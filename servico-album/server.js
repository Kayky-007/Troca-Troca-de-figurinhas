// servico de album (catalogo)
// so cuida das selecoes e figurinhas, roda em 2 replicas (4001 e 4011)
//
// uso: node servico-album/server.js 4001

const express = require('express')
const { medirRequisicoes, rotaMetrics } = require('../compartilhado/metricas')
const { conectar } = require('../compartilhado/db')

const app = express()
const PORTA = process.argv[2] || process.env.PORTA || 4001

app.use(express.json())
app.use(medirRequisicoes)
app.get('/metrics', rotaMetrics)

const seguro = (fn) => (req, res, next) => fn(req, res).catch(next)

app.get('/saude', (req, res) => {
  res.json({ ok: true, servico: 'album', porta: PORTA })
})

// ALBUM_MODO=n1   jeito antigo, 1 query pras selecoes + 1 pra cada selecao (50 queries)
// ALBUM_MODO=join um JOIN so (1 query)
let modo = process.env.ALBUM_MODO || 'join'

// troca o modo sem reiniciar, pra mostrar a diferenca no grafana durante o teste
// ex: curl -X POST http://localhost:4001/admin/modo/n1
app.post('/admin/modo/:modo', (req, res) => {
  if (req.params.modo !== 'n1' && req.params.modo !== 'join') {
    return res.status(400).json({ erro: 'modo tem que ser n1 ou join' })
  }
  modo = req.params.modo
  console.log('modo do album mudou pra ' + modo)
  res.json({ modo })
})

async function albumN1(db) {
  const selecoes = await db.query('SELECT id, codigo, nome FROM selecoes ORDER BY id')
  for (const selecao of selecoes) {
    selecao.figurinhas = await db.query(
      'SELECT id, codigo, numero, nome, tipo FROM figurinhas WHERE selecao_id = ? ORDER BY numero',
      [selecao.id]
    )
  }
  return selecoes
}

async function albumJoin(db) {
  const linhas = await db.query(
    `SELECT s.id AS selecao_id, s.codigo AS selecao_codigo, s.nome AS selecao_nome,
            f.id, f.codigo, f.numero, f.nome, f.tipo
     FROM selecoes s
     JOIN figurinhas f ON f.selecao_id = s.id
     ORDER BY s.id, f.numero`
  )

  // agrupa as figurinhas por selecao, usando um Map pra achar a selecao direto
  const porSelecao = new Map()
  for (const l of linhas) {
    if (!porSelecao.has(l.selecao_id)) {
      porSelecao.set(l.selecao_id, { id: l.selecao_id, codigo: l.selecao_codigo, nome: l.selecao_nome, figurinhas: [] })
    }
    porSelecao.get(l.selecao_id).figurinhas.push({ id: l.id, codigo: l.codigo, numero: l.numero, nome: l.nome, tipo: l.tipo })
  }

  return [...porSelecao.values()]
}

app.get('/album', seguro(async (req, res) => {
  const db = await conectar(req)
  const selecoes = modo === 'n1' ? await albumN1(db) : await albumJoin(db)

  // header pra saber qual replica respondeu
  res.set('X-Instancia', 'album-' + PORTA)
  res.set('X-Modo', modo)
  res.json(selecoes)
}))

// lista simples de todas as figurinhas
app.get('/figurinhas', seguro(async (req, res) => {
  const db = await conectar(req)
  const figurinhas = await db.query('SELECT id, codigo, nome, tipo FROM figurinhas ORDER BY id')
  res.set('X-Instancia', 'album-' + PORTA)
  res.json(figurinhas)
}))

app.use((req, res) => {
  res.status(404).json({ erro: 'rota nao existe' })
})

app.use((err, req, res, next) => {
  console.error(err.message)
  res.status(500).json({ erro: 'erro interno' })
})

app.listen(PORTA, () => {
  console.log('servico album rodando na porta ' + PORTA + ' (modo ' + modo + ')')
})
