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
  const conn = await mysql.createConnection(config)
  conexoesAbertas.inc()
  conexoesAtivas.inc()

  // fecha quando a resposta terminar
  req.res.on('close', () => {
    conn.end().catch(() => {})
    conexoesAtivas.dec()
  })

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
