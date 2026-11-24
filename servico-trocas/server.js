// servico de trocas
// cuida dos colecionadores, da colecao de cada um, pacotinhos e trocas
//
// uso: node servico-trocas/server.js 4002

const express = require('express')
const { client, medirRequisicoes, rotaMetrics } = require('../compartilhado/metricas')
const { conectar, consultaAvulsa } = require('../compartilhado/db')
const { rodarEmCluster } = require('../compartilhado/cluster')

const app = express()
const PORTA = process.argv[2] || process.env.PORTA || 4002

app.use(express.json())
app.use(medirRequisicoes)
app.get('/metrics', rotaMetrics)

const seguro = (fn) => (req, res, next) => fn(req, res).catch(next)

// ---------- metricas de negocio ----------

const pacotinhosAbertos = new client.Counter({
  name: 'pacotinhos_abertos_total',
  help: 'Pacotinhos abertos'
})

const figurinhasRecebidas = new client.Counter({
  name: 'figurinhas_recebidas_total',
  help: 'Figurinhas que sairam nos pacotinhos',
  labelNames: ['repetida']
})

const trocasFeitas = new client.Counter({
  name: 'trocas_total',
  help: 'Trocas por status',
  labelNames: ['status']
})

new client.Gauge({
  name: 'album_progresso_medio_porcentagem',
  help: 'Media de quanto do album os colecionadores ja completaram',
  aggregator: 'max', // em cluster todo worker calcula o mesmo valor, nao pode somar
  async collect() {
    try {
      const linhas = await consultaAvulsa(
        'SELECT AVG(qtd) / (SELECT COUNT(*) FROM figurinhas) * 100 AS media FROM (SELECT COUNT(*) AS qtd FROM colecao GROUP BY colecionador_id) t'
      )
      this.set(Number(linhas[0].media))
    } catch (e) {}
  }
})

new client.Gauge({
  name: 'figurinhas_repetidas_estoque',
  help: 'Quantas figurinhas repetidas existem no total pra trocar',
  aggregator: 'max',
  async collect() {
    try {
      const linhas = await consultaAvulsa('SELECT SUM(quantidade - 1) AS total FROM colecao WHERE quantidade > 1')
      this.set(Number(linhas[0].total))
    } catch (e) {}
  }
})

app.get('/saude', (req, res) => {
  res.json({ ok: true, servico: 'trocas', porta: PORTA })
})

// ---------- colecionadores ----------

app.get('/colecionadores/:id', seguro(async (req, res) => {
  const db = await conectar(req)

  const resultado = await db.query('SELECT id, nome, cidade FROM colecionadores WHERE id = ?', [req.params.id])
  if (resultado.length === 0) {
    return res.status(404).json({ erro: 'colecionador nao encontrado' })
  }

  const colecionador = resultado[0]
  const total = await db.query('SELECT COUNT(*) AS qtd FROM figurinhas')
  const tenho = await db.query('SELECT COUNT(*) AS qtd FROM colecao WHERE colecionador_id = ?', [colecionador.id])
  const repetidas = await db.query(
    'SELECT COALESCE(SUM(quantidade - 1), 0) AS qtd FROM colecao WHERE colecionador_id = ? AND quantidade > 1',
    [colecionador.id]
  )

  colecionador.total_album = total[0].qtd
  colecionador.tenho = tenho[0].qtd
  colecionador.repetidas = Number(repetidas[0].qtd)
  colecionador.progresso = Math.round((tenho[0].qtd / total[0].qtd) * 1000) / 10

  res.json(colecionador)
}))

// ids das figurinhas que o colecionador tem (o gateway usa pra montar o album dele)
app.get('/colecionadores/:id/colecao', seguro(async (req, res) => {
  const db = await conectar(req)
  const linhas = await db.query(
    'SELECT figurinha_id, quantidade FROM colecao WHERE colecionador_id = ?',
    [req.params.id]
  )
  res.json(linhas)
}))

// figurinhas que faltam
// antes: array + includes, pra cada uma das 980 percorria o array inteiro (O(n) por busca)
// agora: Set, o has() acha direto (O(1) por busca)
app.get('/colecionadores/:id/faltantes', seguro(async (req, res) => {
  const db = await conectar(req)

  const todas = await db.query('SELECT id, codigo, nome FROM figurinhas')
  const minhas = await db.query('SELECT figurinha_id FROM colecao WHERE colecionador_id = ?', [req.params.id])
  const idsQueTenho = new Set(minhas.map((m) => m.figurinha_id))

  const faltantes = todas.filter((f) => !idsQueTenho.has(f.id))

  res.json({ total: faltantes.length, faltantes })
}))

app.get('/colecionadores/:id/repetidas', seguro(async (req, res) => {
  const db = await conectar(req)

  const repetidas = await db.query(
    `SELECT f.id, f.codigo, f.nome, c.quantidade - 1 AS sobrando
     FROM colecao c JOIN figurinhas f ON f.id = c.figurinha_id
     WHERE c.colecionador_id = ? AND c.quantidade > 1`,
    [req.params.id]
  )

  res.json({ total: repetidas.length, repetidas })
}))

// quem tem repetida de uma que me falta
// antes era O(n x m): ~29 mil repetidas x includes num array de ~400 faltantes
// agora com Set fica O(n): cada repetida e so um has()
app.get('/colecionadores/:id/sugestoes-troca', seguro(async (req, res) => {
  const db = await conectar(req)
  const id = Number(req.params.id)

  const todas = await db.query('SELECT id FROM figurinhas')
  const minhas = await db.query('SELECT figurinha_id FROM colecao WHERE colecionador_id = ?', [id])
  const idsQueTenho = new Set(minhas.map((m) => m.figurinha_id))
  const idsFaltando = new Set(todas.filter((f) => !idsQueTenho.has(f.id)).map((f) => f.id))

  const repetidasDosOutros = await db.query(
    'SELECT colecionador_id, figurinha_id FROM colecao WHERE quantidade > 1 AND colecionador_id <> ?',
    [id]
  )

  const sugestoes = repetidasDosOutros.filter((r) => idsFaltando.has(r.figurinha_id))

  res.json({ total: sugestoes.length, sugestoes: sugestoes.slice(0, 50) })
}))

app.post('/colecionadores/:id/pacotinho', seguro(async (req, res) => {
  const db = await conectar(req)
  const id = Number(req.params.id)

  const existe = await db.query('SELECT id FROM colecionadores WHERE id = ?', [id])
  if (existe.length === 0) {
    return res.status(404).json({ erro: 'colecionador nao encontrado' })
  }

  const sorteadas = await db.query('SELECT id, codigo, nome FROM figurinhas ORDER BY RAND() LIMIT 5')

  // antes fazia SELECT e depois INSERT ou UPDATE (2 queries por figurinha)
  // e dava erro de chave duplicada quando 2 pacotinhos do mesmo colecionador abriam juntos
  // agora o proprio banco resolve numa query so
  for (const fig of sorteadas) {
    const resultado = await db.query(
      'INSERT INTO colecao (colecionador_id, figurinha_id, quantidade) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE quantidade = quantidade + 1',
      [id, fig.id]
    )

    // affectedRows = 1 inseriu (nova), 2 atualizou (repetida)
    fig.repetida = resultado.affectedRows === 2
    figurinhasRecebidas.inc({ repetida: fig.repetida ? 'sim' : 'nao' })
  }

  pacotinhosAbertos.inc()
  res.status(201).json({ figurinhas: sorteadas })
}))

// ---------- trocas ----------

app.get('/colecionadores/:id/trocas', seguro(async (req, res) => {
  const db = await conectar(req)

  const trocas = await db.query(
    'SELECT * FROM trocas WHERE quem_oferece_id = ? OR quem_recebe_id = ? ORDER BY criado_em DESC LIMIT 50',
    [req.params.id, req.params.id]
  )

  res.json(trocas)
}))

app.post('/trocas', seguro(async (req, res) => {
  const { quem_oferece_id, quem_recebe_id, figurinha_oferecida_id, figurinha_pedida_id } = req.body

  if (!quem_oferece_id || !quem_recebe_id || !figurinha_oferecida_id || !figurinha_pedida_id) {
    return res.status(400).json({ erro: 'faltou campo' })
  }
  if (quem_oferece_id === quem_recebe_id) {
    return res.status(400).json({ erro: 'nao da pra trocar com voce mesmo' })
  }

  const db = await conectar(req)

  const tenho = await db.query(
    'SELECT quantidade FROM colecao WHERE colecionador_id = ? AND figurinha_id = ?',
    [quem_oferece_id, figurinha_oferecida_id]
  )
  if (tenho.length === 0 || tenho[0].quantidade < 2) {
    return res.status(400).json({ erro: 'voce so pode oferecer figurinha repetida' })
  }

  const resultado = await db.query(
    'INSERT INTO trocas (quem_oferece_id, quem_recebe_id, figurinha_oferecida_id, figurinha_pedida_id) VALUES (?, ?, ?, ?)',
    [quem_oferece_id, quem_recebe_id, figurinha_oferecida_id, figurinha_pedida_id]
  )

  trocasFeitas.inc({ status: 'pendente' })
  res.status(201).json({ id: resultado.insertId, status: 'pendente' })
}))

app.post('/trocas/:id/aceitar', seguro(async (req, res) => {
  const db = await conectar(req)

  const resultado = await db.query('SELECT * FROM trocas WHERE id = ?', [req.params.id])
  if (resultado.length === 0) {
    return res.status(404).json({ erro: 'troca nao encontrada' })
  }

  const troca = resultado[0]
  if (troca.status !== 'pendente') {
    return res.status(409).json({ erro: 'essa troca ja foi ' + troca.status })
  }

  const oferecida = await db.query(
    'SELECT quantidade FROM colecao WHERE colecionador_id = ? AND figurinha_id = ?',
    [troca.quem_oferece_id, troca.figurinha_oferecida_id]
  )
  const pedida = await db.query(
    'SELECT quantidade FROM colecao WHERE colecionador_id = ? AND figurinha_id = ?',
    [troca.quem_recebe_id, troca.figurinha_pedida_id]
  )
  if (oferecida.length === 0 || oferecida[0].quantidade < 2 || pedida.length === 0 || pedida[0].quantidade < 2) {
    return res.status(409).json({ erro: 'alguem nao tem mais a figurinha repetida' })
  }

  await db.query('START TRANSACTION')
  try {
    await db.query(
      'UPDATE colecao SET quantidade = quantidade - 1 WHERE colecionador_id = ? AND figurinha_id = ?',
      [troca.quem_oferece_id, troca.figurinha_oferecida_id]
    )
    await db.query(
      'INSERT INTO colecao (colecionador_id, figurinha_id, quantidade) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE quantidade = quantidade + 1',
      [troca.quem_oferece_id, troca.figurinha_pedida_id]
    )
    await db.query(
      'UPDATE colecao SET quantidade = quantidade - 1 WHERE colecionador_id = ? AND figurinha_id = ?',
      [troca.quem_recebe_id, troca.figurinha_pedida_id]
    )
    await db.query(
      'INSERT INTO colecao (colecionador_id, figurinha_id, quantidade) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE quantidade = quantidade + 1',
      [troca.quem_recebe_id, troca.figurinha_oferecida_id]
    )
    await db.query("UPDATE trocas SET status = 'aceita' WHERE id = ?", [troca.id])
    await db.query('COMMIT')
  } catch (e) {
    await db.query('ROLLBACK')
    throw e
  }

  trocasFeitas.inc({ status: 'aceita' })
  res.json({ id: troca.id, status: 'aceita' })
}))

app.post('/trocas/:id/recusar', seguro(async (req, res) => {
  const db = await conectar(req)

  const resultado = await db.query("UPDATE trocas SET status = 'recusada' WHERE id = ? AND status = 'pendente'", [req.params.id])
  if (resultado.affectedRows === 0) {
    return res.status(404).json({ erro: 'troca nao encontrada ou ja respondida' })
  }

  trocasFeitas.inc({ status: 'recusada' })
  res.json({ id: Number(req.params.id), status: 'recusada' })
}))

app.use((req, res) => {
  res.status(404).json({ erro: 'rota nao existe' })
})

app.use((err, req, res, next) => {
  console.error(err.message)
  res.status(500).json({ erro: 'erro interno' })
})

// WORKERS=2 sobe 2 processos dividindo a porta (veja compartilhado/cluster.js)
rodarEmCluster('trocas', PORTA, () => {
  app.listen(PORTA, () => {
    console.log('servico trocas rodando na porta ' + PORTA + ' (pid ' + process.pid + ')')
  })
})
