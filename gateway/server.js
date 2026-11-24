// API Gateway
// porta de entrada unica, repassa pros servicos de album e trocas
// o album tem 2 replicas e o gateway divide as chamadas entre elas (round robin)

const express = require('express')
const compression = require('compression')
const { LRUCache } = require('lru-cache')
const { fetch, Agent } = require('undici')
const { client, medirRequisicoes, rotaMetrics } = require('../compartilhado/metricas')
const { rodarEmCluster } = require('../compartilhado/cluster')

const PORTA = process.env.PORTA || 3000

const ALBUM = (process.env.ALBUM_URLS || 'http://localhost:4001,http://localhost:4011').split(',')
const TROCAS = process.env.TROCAS_URL || 'http://localhost:4002'

// chaves pra ligar/desligar as otimizacoes e comparar
const USAR_KEEPALIVE = (process.env.HTTP_KEEPALIVE || 'on') === 'on'
const USAR_GZIP = (process.env.GZIP || 'on') === 'on'
const USAR_CACHE = (process.env.CACHE || 'on') === 'on'
const CACHE_TTL = Number(process.env.CACHE_TTL || 60) // segundos

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

// ---------- pool de conexoes HTTP (keep-alive) ----------
const agente = USAR_KEEPALIVE
  ? new Agent({ connections: 50, keepAliveTimeout: 30000 }) // ate 50 conexoes por servico, ficam abertas 30s
  : new Agent({ pipelining: 0 }) // pipelining 0 desliga o keep-alive no undici

agente.on('connect', (origem) => conexoesHttp.inc({ destino: new URL(origem).host }))

// ---------- round robin ----------

let vez = 0
function urlAlbum() {
  const url = ALBUM[vez]
  vez = (vez + 1) % ALBUM.length
  return url
}

// chama um servico e devolve status + corpo
async function chamar(servico, base, caminho, metodo = 'GET', corpo) {
  const instancia = servico + '-' + base.split(':').pop()
  const pararTimer = tempoChamadas.startTimer({ servico, instancia })

  const opcoes = { method: metodo, headers: { 'Content-Type': 'application/json' }, dispatcher: agente }
  if (metodo !== 'GET') opcoes.body = JSON.stringify(corpo || {})

  try {
    const resposta = await fetch(base + caminho, opcoes)
    const dados = await resposta.json()
    chamadas.inc({ servico, instancia, status: resposta.status })
    return { status: resposta.status, dados, instancia }
  } catch (e) {
    chamadas.inc({ servico, instancia, status: 'erro' })
    const erro = new Error('servico ' + servico + ' nao respondeu')
    erro.status = 502
    throw erro
  } finally {
    pararTimer()
  }
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

  const r = await chamar('album', urlAlbum(), '/album')
  if (USAR_CACHE && r.status === 200) {
    cache.set('album', r)
  }
  return { ...r, cache: 'MISS' }
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

  // so repassa a requisicao do jeito que veio
  function repassar(servico) {
    return seguro(async (req, res) => {
      const base = servico === 'album' ? urlAlbum() : TROCAS
      const r = await chamar(servico, base, req.originalUrl, req.method, req.body)
      // mostra qual instancia respondeu, ajuda a ver o round robin funcionando
      res.set('X-Instancia', r.instancia)
      res.status(r.status).json(r.dados)
    })
  }

  // ---------- rotas ----------

  app.get('/album', cachePublico, seguro(async (req, res) => {
    const r = await buscarAlbum()
    res.set('X-Cache', r.cache)
    res.set('X-Instancia', r.instancia)
    res.status(r.status).json(r.dados)
  }))

  // album do colecionador: junta o album (cache ou servico album) com a colecao dele (servico trocas)
  app.get('/colecionadores/:id/album', cachePrivado, seguro(async (req, res) => {
    const [album, colecao] = await Promise.all([
      buscarAlbum(),
      chamar('trocas', TROCAS, '/colecionadores/' + req.params.id + '/colecao')
    ])

    if (album.status !== 200) return res.status(album.status).json(album.dados)
    if (colecao.status !== 200) return res.status(colecao.status).json(colecao.dados)

    // antes era um array com includes (percorre tudo pra cada figurinha, O(n))
    // com Set o has() e direto (O(1))
    const idsQueTenho = new Set(colecao.dados.map((c) => c.figurinha_id))

    const selecoes = album.dados.map((selecao) => ({
      ...selecao,
      figurinhas: selecao.figurinhas.map((f) => ({ ...f, tenho: idsQueTenho.has(f.id) }))
    }))

    res.set('X-Cache', album.cache)
    res.json(selecoes)
  }))

  app.get('/colecionadores/:id', cachePrivado, repassar('trocas'))
  app.get('/colecionadores/:id/faltantes', cachePrivado, repassar('trocas'))
  app.get('/colecionadores/:id/repetidas', cachePrivado, repassar('trocas'))
  app.get('/colecionadores/:id/sugestoes-troca', cachePrivado, repassar('trocas'))
  app.get('/colecionadores/:id/trocas', cachePrivado, repassar('trocas'))
  app.post('/colecionadores/:id/pacotinho', naoGuardar, repassar('trocas'))
  app.post('/trocas', naoGuardar, repassar('trocas'))
  app.post('/trocas/:id/aceitar', naoGuardar, repassar('trocas'))
  app.post('/trocas/:id/recusar', naoGuardar, repassar('trocas'))

  app.use((req, res) => {
    res.status(404).json({ erro: 'rota nao existe' })
  })

  app.use((err, req, res, next) => {
    console.error(err.message)
    res.status(err.status || 500).json({ erro: err.message })
  })

  app.listen(PORTA, () => {
    console.log('gateway rodando na porta ' + PORTA + ' (pid ' + process.pid + ')')
  })
}

console.log('gateway config: keep-alive ' + (USAR_KEEPALIVE ? 'on' : 'off') + ', gzip ' + (USAR_GZIP ? 'on' : 'off') +
  ', cache ' + (USAR_CACHE ? 'on (ttl ' + CACHE_TTL + 's)' : 'off'))

rodarEmCluster('gateway', PORTA, iniciarApp)
