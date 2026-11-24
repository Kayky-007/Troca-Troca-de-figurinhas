// API Gateway
// porta de entrada unica, repassa pros servicos de album e trocas
// o album tem 2 replicas e o gateway divide as chamadas entre elas (round robin)

const express = require('express')
const compression = require('compression')
const { LRUCache } = require('lru-cache')
const { fetch, Agent } = require('undici')
const { client, medirRequisicoes, rotaMetrics } = require('../compartilhado/metricas')
const { rodarEmCluster } = require('../compartilhado/cluster')
const { CircuitBreaker, comRetry } = require('./resiliencia')

const PORTA = process.env.PORTA || 3000

const ALBUM = (process.env.ALBUM_URLS || 'http://localhost:4001,http://localhost:4011').split(',')
const TROCAS = process.env.TROCAS_URL || 'http://localhost:4002'

// chaves pra ligar/desligar as otimizacoes e comparar
const USAR_KEEPALIVE = (process.env.HTTP_KEEPALIVE || 'on') === 'on'
const USAR_GZIP = (process.env.GZIP || 'on') === 'on'
const USAR_CACHE = (process.env.CACHE || 'on') === 'on'
const CACHE_TTL = Number(process.env.CACHE_TTL || 60) // segundos

// RESILIENCIA=off desliga timeout, retry, circuit breaker e fallback (pra comparar no caos)
const USAR_RESILIENCIA = (process.env.RESILIENCIA || 'on') === 'on'
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 2000)
const TENTATIVAS = Number(process.env.TENTATIVAS || 3) // 1 normal + 2 retries

// ---------- metricas ----------

const chamadas = new client.Counter({
  name: 'upstream_requests_total',
  help: 'Chamadas do gateway pros servicos',
  labelNames: ['servico', 'instancia', 'status']
})

const tempoChamadas = new client.Histogram({
  name: 'upstream_duration_seconds',
  help: 'Tempo das chamadas do gateway pros servicos',
  labelNames: ['servico', 'instancia'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
})

const conexoesHttp = new client.Counter({
  name: 'upstream_conexoes_abertas_total',
  help: 'Conexoes TCP novas que o gateway abriu com os servicos',
  labelNames: ['destino']
})

const consultasCache = new client.Counter({
  name: 'cache_requests_total',
  help: 'Consultas no cache do gateway (hit = achou, miss = nao achou)',
  labelNames: ['chave', 'resultado']
})

const fallbacks = new client.Counter({
  name: 'fallback_total',
  help: 'Respostas dadas pelo fallback quando o servico falhou',
  labelNames: ['rota', 'tipo']
})

// ---------- cache LRU ----------
// o album quase nunca muda, entao guarda em memoria por CACHE_TTL segundos
// max 100 itens, quando enche joga fora o que foi usado ha mais tempo (LRU)
const cache = new LRUCache({ max: 100, ttl: CACHE_TTL * 1000 })

new client.Gauge({
  name: 'cache_itens',
  help: 'Quantos itens tem no cache agora',
  collect() {
    this.set(cache.size)
  }
})

// copia das ultimas respostas boas, so pra usar quando o servico cair (fallback)
// diferente do cache de cima, aqui nunca e usado com o servico funcionando
let ultimoAlbumBom = null
const respostasAntigas = new LRUCache({ max: 5000, ttl: 30 * 60 * 1000 })

// ---------- pool de conexoes HTTP (keep-alive) ----------
const agente = USAR_KEEPALIVE
  ? new Agent({ connections: 50, keepAliveTimeout: 30000 }) // ate 50 conexoes por servico, ficam abertas 30s
  : new Agent({ pipelining: 0 }) // pipelining 0 desliga o keep-alive no undici

agente.on('connect', (origem) => conexoesHttp.inc({ destino: new URL(origem).host }))

// ---------- circuit breaker, um por instancia ----------

const nomeInstancia = (servico, base) => servico + '-' + base.split(':').pop()

const disjuntores = {}
for (const url of ALBUM) disjuntores[url] = new CircuitBreaker(nomeInstancia('album', url))
disjuntores[TROCAS] = new CircuitBreaker(nomeInstancia('trocas', TROCAS))

// ---------- round robin ----------
// pula replica com circuito aberto, assim se uma cair a outra segura sozinha

let vez = 0
function urlAlbum() {
  for (let i = 0; i < ALBUM.length; i++) {
    const url = ALBUM[vez]
    vez = (vez + 1) % ALBUM.length
    if (!USAR_RESILIENCIA || disjuntores[url].disponivel()) return url
  }
  return ALBUM[0] // todas com circuito aberto, o disjuntor vai barrar
}

function erroServico(servico, motivo, status, repetir) {
  const erro = new Error('servico ' + servico + ' ' + motivo)
  erro.status = status
  erro.repetir = repetir
  return erro
}

// chama um servico uma vez e devolve status + corpo
async function chamarUmaVez(servico, base, caminho, metodo, corpo) {
  const instancia = nomeInstancia(servico, base)
  const disjuntor = disjuntores[base]

  if (USAR_RESILIENCIA && !disjuntor.podeChamar()) {
    chamadas.inc({ servico, instancia, status: 'circuito_aberto' })
    throw erroServico(servico, 'com circuito aberto', 503, false)
  }

  const opcoes = { method: metodo, headers: { 'Content-Type': 'application/json' }, dispatcher: agente }
  if (metodo !== 'GET') opcoes.body = JSON.stringify(corpo || {})
  // timeout: se o servico nao responder em TIMEOUT_MS desiste
  if (USAR_RESILIENCIA) opcoes.signal = AbortSignal.timeout(TIMEOUT_MS)

  const pararTimer = tempoChamadas.startTimer({ servico, instancia })
  let resposta, dados
  try {
    resposta = await fetch(base + caminho, opcoes)
    dados = await resposta.json()
  } catch (e) {
    const motivo = e.name === 'TimeoutError' ? 'timeout' : 'erro'
    chamadas.inc({ servico, instancia, status: motivo })
    if (USAR_RESILIENCIA) disjuntor.falha(motivo + ' ' + caminho)
    // timeout nao repete: se o servico ta lento, mandar mais requisicao so piora
    // (e o usuario ja esperou TIMEOUT_MS). erro de conexao repete
    if (motivo === 'timeout') throw erroServico(servico, 'demorou demais', 504, false)
    throw erroServico(servico, 'nao respondeu', 502, true)
  } finally {
    pararTimer()
  }

  chamadas.inc({ servico, instancia, status: resposta.status })

  if (USAR_RESILIENCIA) {
    // 5xx e problema do servico, conta como falha. 4xx e erro de quem pediu, nao
    if (resposta.status >= 500) {
      disjuntor.falha(resposta.status + ' ' + caminho)
      throw erroServico(servico, 'deu erro ' + resposta.status, 502, true)
    }
    disjuntor.sucesso()
  }

  return { status: resposta.status, dados, instancia }
}

// GET pode repetir. POST nao, senao abre 2 pacotinhos ou cria troca duplicada
function chamar(servico, base, caminho, metodo = 'GET', corpo) {
  if (!USAR_RESILIENCIA || metodo !== 'GET') {
    return chamarUmaVez(servico, base, caminho, metodo, corpo)
  }
  // no album cada tentativa pega a proxima replica (se uma falhar tenta na outra)
  return comRetry(servico, TENTATIVAS, () =>
    chamarUmaVez(servico, servico === 'album' ? urlAlbum() : base, caminho, metodo, corpo)
  )
}

// busca o album no cache, se nao tiver pede pro servico e guarda
async function buscarAlbum() {
  if (USAR_CACHE) {
    const guardado = cache.get('album')
    if (guardado) {
      consultasCache.inc({ chave: 'album', resultado: 'hit' })
      return { ...guardado, cache: 'HIT' }
    }
    consultasCache.inc({ chave: 'album', resultado: 'miss' })
  }

  try {
    const r = await chamar('album', urlAlbum(), '/album')
    if (r.status === 200) {
      if (USAR_CACHE) cache.set('album', r)
      ultimoAlbumBom = r
    }
    return { ...r, cache: 'MISS' }
  } catch (e) {
    // fallback: o servico de album caiu mas a gente tem uma copia antiga
    if (USAR_RESILIENCIA && ultimoAlbumBom) {
      fallbacks.inc({ rota: '/album', tipo: 'copia_antiga' })
      return { ...ultimoAlbumBom, cache: 'STALE', fallback: 'copia_antiga' }
    }
    throw e
  }
}

// fallback das rotas de leitura do servico de trocas
// 1) devolve a ultima resposta boa que o gateway viu pra essa url
// 2) se nao tiver, algumas rotas tem uma resposta padrao que nao quebra a tela
// 3) se nao tiver nada, 503 rapido (nao deixa o usuario esperando)
const respostaPadrao = {
  '/colecionadores/:id/sugestoes-troca': () => ({ total: 0, sugestoes: [], aviso: 'sugestoes indisponiveis no momento' }),
  '/colecionadores/:id/trocas': () => []
}

function fallbackTrocas(req, res) {
  const rota = req.route.path
  res.set('Cache-Control', 'no-store') // resposta de emergencia nao pode ficar guardada

  const antiga = respostasAntigas.get(req.originalUrl)
  if (antiga) {
    fallbacks.inc({ rota, tipo: 'copia_antiga' })
    res.set('X-Fallback', 'copia_antiga')
    return res.status(antiga.status).json(antiga.dados)
  }

  if (respostaPadrao[rota]) {
    fallbacks.inc({ rota, tipo: 'padrao' })
    res.set('X-Fallback', 'padrao')
    return res.json(respostaPadrao[rota]())
  }

  fallbacks.inc({ rota, tipo: 'sem_fallback' })
  res.set('Retry-After', '10')
  res.status(503).json({ erro: 'servico de trocas fora do ar, tente de novo daqui a pouco' })
}

function iniciarApp() {
  const app = express()

  // gzip nas respostas maiores que 1KB
  if (USAR_GZIP) {
    app.use(compression({ threshold: 1024 }))
  }

  app.use(express.json())
  app.use(medirRequisicoes)
  app.get('/metrics', rotaMetrics)

  const seguro = (fn) => (req, res, next) => fn(req, res).catch(next)

  // ---------- Cache-Control ----------
  // album e igual pra todo mundo: navegador e proxy podem guardar por 5 min
  const cachePublico = (req, res, next) => {
    res.set('Cache-Control', 'public, max-age=300')
    next()
  }
  // dados do colecionador mudam toda hora: pode guardar mas tem que confirmar com o servidor (usa o ETag)
  const cachePrivado = (req, res, next) => {
    res.set('Cache-Control', 'private, no-cache')
    next()
  }
  // POST nunca guarda
  const naoGuardar = (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  }

  // repassa a requisicao pro servico de trocas do jeito que veio
  const repassarTrocas = seguro(async (req, res) => {
    let r
    try {
      r = await chamar('trocas', TROCAS, req.originalUrl, req.method, req.body)
    } catch (e) {
      // so leitura tem fallback. escrita (POST) falha rapido com 503
      if (USAR_RESILIENCIA && req.method === 'GET') return fallbackTrocas(req, res)
      throw e
    }

    if (USAR_RESILIENCIA && req.method === 'GET' && r.status === 200) {
      respostasAntigas.set(req.originalUrl, r)
    }
    // mostra qual instancia respondeu, ajuda a ver o round robin funcionando
    res.set('X-Instancia', r.instancia)
    res.status(r.status).json(r.dados)
  })

  // ---------- rotas ----------

  app.get('/album', cachePublico, seguro(async (req, res) => {
    const r = await buscarAlbum()
    res.set('X-Cache', r.cache)
    res.set('X-Instancia', r.instancia)
    if (r.fallback) {
      res.set('X-Fallback', r.fallback)
      res.set('Cache-Control', 'no-store')
    }
    res.status(r.status).json(r.dados)
  }))

  // album do colecionador: junta o album (cache ou servico album) com a colecao dele (servico trocas)
  app.get('/colecionadores/:id/album', cachePrivado, seguro(async (req, res) => {
    const caminhoColecao = '/colecionadores/' + req.params.id + '/colecao'

    const [album, colecao] = await Promise.all([
      buscarAlbum(),
      chamar('trocas', TROCAS, caminhoColecao).then(
        (r) => {
          if (USAR_RESILIENCIA && r.status === 200) respostasAntigas.set(caminhoColecao, r)
          return r
        },
        (e) => {
          if (!USAR_RESILIENCIA) throw e
          // fallback: usa a colecao antiga, ou mostra o album sem marcar o que ele tem
          const antiga = respostasAntigas.get(caminhoColecao)
          fallbacks.inc({ rota: '/colecionadores/:id/album', tipo: antiga ? 'copia_antiga' : 'padrao' })
          return antiga ? { ...antiga, fallback: 'copia_antiga' } : { status: 200, dados: null, fallback: 'padrao' }
        }
      )
    ])

    if (album.status !== 200) return res.status(album.status).json(album.dados)
    if (colecao.status !== 200) return res.status(colecao.status).json(colecao.dados)

    // antes era um array com includes (percorre tudo pra cada figurinha, O(n))
    // com Set o has() e direto (O(1))
    // sem a colecao (fallback padrao) o tenho fica null = "nao sei"
    const idsQueTenho = colecao.dados ? new Set(colecao.dados.map((c) => c.figurinha_id)) : null

    const selecoes = album.dados.map((selecao) => ({
      ...selecao,
      figurinhas: selecao.figurinhas.map((f) => ({ ...f, tenho: idsQueTenho ? idsQueTenho.has(f.id) : null }))
    }))

    const fallback = colecao.fallback || album.fallback
    if (fallback) {
      res.set('X-Fallback', fallback)
      res.set('Cache-Control', 'no-store')
    }
    res.set('X-Cache', album.cache)
    res.json(selecoes)
  }))

  app.get('/colecionadores/:id', cachePrivado, repassarTrocas)
  app.get('/colecionadores/:id/faltantes', cachePrivado, repassarTrocas)
  app.get('/colecionadores/:id/repetidas', cachePrivado, repassarTrocas)
  app.get('/colecionadores/:id/sugestoes-troca', cachePrivado, repassarTrocas)
  app.get('/colecionadores/:id/trocas', cachePrivado, repassarTrocas)
  app.post('/colecionadores/:id/pacotinho', naoGuardar, repassarTrocas)
  app.post('/trocas', naoGuardar, repassarTrocas)
  app.post('/trocas/:id/aceitar', naoGuardar, repassarTrocas)
  app.post('/trocas/:id/recusar', naoGuardar, repassarTrocas)

  // estado dos circuitos desse worker (bom pra mostrar no video)
  app.get('/circuitos', (req, res) => {
    const estados = {}
    for (const d of Object.values(disjuntores)) estados[d.nome] = d.estado
    res.set('Cache-Control', 'no-store')
    res.json({ pid: process.pid, resiliencia: USAR_RESILIENCIA, circuitos: estados })
  })

  app.use((req, res) => {
    res.status(404).json({ erro: 'rota nao existe' })
  })

  app.use((err, req, res, next) => {
    console.error(err.message)
    if (err.status === 503) res.set('Retry-After', '10')
    res.status(err.status || 500).json({ erro: err.message })
  })

  app.listen(PORTA, () => {
    console.log('gateway rodando na porta ' + PORTA + ' (pid ' + process.pid + ')')
  })
}

console.log('gateway config: keep-alive ' + (USAR_KEEPALIVE ? 'on' : 'off') + ', gzip ' + (USAR_GZIP ? 'on' : 'off') +
  ', cache ' + (USAR_CACHE ? 'on (ttl ' + CACHE_TTL + 's)' : 'off') +
  ', resiliencia ' + (USAR_RESILIENCIA ? 'on (timeout ' + TIMEOUT_MS + 'ms, ' + TENTATIVAS + ' tentativas)' : 'off'))

rodarEmCluster('gateway', PORTA, iniciarApp)
