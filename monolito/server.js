// VERSAO 1 - monolito ingenuo
// tudo num app so, sem cache, sem compressao, sem pool, um processo so
// os problemas aqui sao de proposito pra comparar depois com a versao otimizada

const express = require('express')
const { client, medirRequisicoes, rotaMetrics } = require('../compartilhado/metricas')
const { conectar, config } = require('./db')
const mysql = require('mysql2/promise')

const app = express()
const PORTA = process.env.PORTA || 3001

app.use(express.json())
app.use(medirRequisicoes)
app.get('/metrics', rotaMetrics)

// express 4 nao pega erro de funcao async sozinho, entao passa pro next
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

// esses dois sao calculados na hora que o prometheus busca o /metrics
new client.Gauge({
  name: 'album_progresso_medio_porcentagem',
  help: 'Media de quanto do album os colecionadores ja completaram',
  async collect() {
    try {
      const conn = await mysql.createConnection(config)
      const [linhas] = await conn.query(
        'SELECT AVG(qtd) / (SELECT COUNT(*) FROM figurinhas) * 100 AS media FROM (SELECT COUNT(*) AS qtd FROM colecao GROUP BY colecionador_id) t'
      )
      await conn.end()
      this.set(Number(linhas[0].media))
    } catch (e) {
      // se o banco cair nao quebra o /metrics
    }
  }
})

new client.Gauge({
  name: 'figurinhas_repetidas_estoque',
  help: 'Quantas figurinhas repetidas existem no total pra trocar',
  async collect() {
    try {
      const conn = await mysql.createConnection(config)
      const [linhas] = await conn.query('SELECT SUM(quantidade - 1) AS total FROM colecao WHERE quantidade > 1')
      await conn.end()
      this.set(Number(linhas[0].total))
    } catch (e) {}
  }
})

// ---------- album ----------

// album completo
// PROBLEMA N+1: 1 query pras selecoes + 1 query de figurinhas pra cada selecao (50 queries)
app.get('/album', seguro(async (req, res) => {
  const db = await conectar(req)

  const selecoes = await db.query('SELECT id, codigo, nome FROM selecoes ORDER BY id')
  for (const selecao of selecoes) {
    selecao.figurinhas = await db.query(
      'SELECT id, codigo, numero, nome, tipo FROM figurinhas WHERE selecao_id = ? ORDER BY numero',
      [selecao.id]
    )
  }

  res.json(selecoes)
}))

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

// album do colecionador, marcando quais ele tem
// mesmo N+1 do /album e ainda usa includes num array pra saber se tem (O(n))
app.get('/colecionadores/:id/album', seguro(async (req, res) => {
  const db = await conectar(req)

  const minhas = await db.query('SELECT figurinha_id FROM colecao WHERE colecionador_id = ?', [req.params.id])
  const idsQueTenho = minhas.map((m) => m.figurinha_id)

  const selecoes = await db.query('SELECT id, codigo, nome FROM selecoes ORDER BY id')
  for (const selecao of selecoes) {
    const figurinhas = await db.query(
      'SELECT id, codigo, numero, nome FROM figurinhas WHERE selecao_id = ? ORDER BY numero',
      [selecao.id]
    )
    selecao.figurinhas = figurinhas.map((f) => ({ ...f, tenho: idsQueTenho.includes(f.id) }))
  }

  res.json(selecoes)
}))

// quais figurinhas faltam
// PROBLEMA O(n): pra cada uma das 980 figurinhas faz um includes no array das que ele tem
app.get('/colecionadores/:id/faltantes', seguro(async (req, res) => {
  const db = await conectar(req)

  const todas = await db.query('SELECT id, codigo, nome FROM figurinhas')
  const minhas = await db.query('SELECT figurinha_id FROM colecao WHERE colecionador_id = ?', [req.params.id])
  const idsQueTenho = minhas.map((m) => m.figurinha_id)

  const faltantes = todas.filter((f) => !idsQueTenho.includes(f.id))

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

// quem tem repetida de uma figurinha que eu nao tenho
// PROBLEMA O(n x m): pega todas as repetidas dos outros (~29 mil) e faz includes no array de faltantes
app.get('/colecionadores/:id/sugestoes-troca', seguro(async (req, res) => {
  const db = await conectar(req)
  const id = Number(req.params.id)

  const todas = await db.query('SELECT id FROM figurinhas')
  const minhas = await db.query('SELECT figurinha_id FROM colecao WHERE colecionador_id = ?', [id])
  const idsQueTenho = minhas.map((m) => m.figurinha_id)
  const idsFaltando = todas.filter((f) => !idsQueTenho.includes(f.id)).map((f) => f.id)

  const repetidasDosOutros = await db.query(
    'SELECT colecionador_id, figurinha_id FROM colecao WHERE quantidade > 1 AND colecionador_id <> ?',
    [id]
  )

  const sugestoes = repetidasDosOutros.filter((r) => idsFaltando.includes(r.figurinha_id))

  res.json({ total: sugestoes.length, sugestoes: sugestoes.slice(0, 50) })
}))

// abre um pacotinho com 5 figurinhas aleatorias
app.post('/colecionadores/:id/pacotinho', seguro(async (req, res) => {
  const db = await conectar(req)
  const id = Number(req.params.id)

  const existe = await db.query('SELECT id FROM colecionadores WHERE id = ?', [id])
  if (existe.length === 0) {
    return res.status(404).json({ erro: 'colecionador nao encontrado' })
  }

  const sorteadas = await db.query('SELECT id, codigo, nome FROM figurinhas ORDER BY RAND() LIMIT 5')

  for (const fig of sorteadas) {
    const jaTem = await db.query(
      'SELECT quantidade FROM colecao WHERE colecionador_id = ? AND figurinha_id = ?',
      [id, fig.id]
    )

    if (jaTem.length > 0) {
      await db.query(
        'UPDATE colecao SET quantidade = quantidade + 1 WHERE colecionador_id = ? AND figurinha_id = ?',
        [id, fig.id]
      )
      fig.repetida = true
    } else {
      await db.query('INSERT INTO colecao (colecionador_id, figurinha_id, quantidade) VALUES (?, ?, 1)', [id, fig.id])
      fig.repetida = false
    }

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

// propor uma troca: eu dou uma repetida minha e peco uma do outro
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

// aceitar a troca: as duas figurinhas mudam de dono
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

  // os dois ainda tem que ter a repetida
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
    // quem oferece entrega a dele e ganha a pedida
    await db.query(
      'UPDATE colecao SET quantidade = quantidade - 1 WHERE colecionador_id = ? AND figurinha_id = ?',
      [troca.quem_oferece_id, troca.figurinha_oferecida_id]
    )
    await db.query(
      'INSERT INTO colecao (colecionador_id, figurinha_id, quantidade) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE quantidade = quantidade + 1',
      [troca.quem_oferece_id, troca.figurinha_pedida_id]
    )
    // quem recebe entrega a pedida e ganha a oferecida
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

// ---------- erros ----------

app.use((req, res) => {
  res.status(404).json({ erro: 'rota nao existe' })
})

app.use((err, req, res, next) => {
  console.error(err.message)
  res.status(500).json({ erro: 'erro interno' })
})

// servidor de desenvolvimento, um processo so (de proposito)
app.listen(PORTA, () => {
  console.log('monolito rodando na porta ' + PORTA)
})
