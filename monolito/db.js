// conexao com o banco do jeito "ingenuo"
// abre uma conexao nova a cada requisicao e fecha no final (sem pool)

const mysql = require('mysql2/promise')
const { client } = require('../compartilhado/metricas')

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3307,
  user: process.env.DB_USER || 'app',
  password: process.env.DB_PASS || 'app123',
  database: process.env.DB_NAME || 'figurinhas'
}

const conexoesAbertas = new client.Counter({
  name: 'db_conexoes_abertas_total',
  help: 'Quantas conexoes novas foram abertas no banco'
})

const conexoesAtivas = new client.Gauge({
  name: 'db_conexoes_ativas',
  help: 'Conexoes abertas nesse momento'
})

async function conectar(req) {
  let conn = null
  let terminou = false

  // fecha quando a resposta terminar
  // registra antes de conectar, senao se o cliente desistir no meio a conexao fica aberta pra sempre
  req.res.on('close', () => {
    terminou = true
    if (conn) {
      conn.end().catch(() => {})
      conexoesAtivas.dec()
    }
  })

  conn = await mysql.createConnection(config)
  conexoesAbertas.inc()
  conexoesAtivas.inc()

  if (terminou) {
    conn.end().catch(() => {})
    conexoesAtivas.dec()
    throw new Error('cliente desistiu antes de conectar no banco')
  }

  return {
    // conta cada query pra metrica db_queries_total
    async query(sql, params) {
      req.qtdQueries++
      const [linhas] = await conn.query(sql, params)
      return linhas
    },
    conn
  }
}

module.exports = { conectar, config }
