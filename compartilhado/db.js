// conexao com o banco usada pelos microsservicos
//
// DB_POOL=on  (padrao) usa um pool: as conexoes ficam abertas e sao reaproveitadas
// DB_POOL=off abre uma conexao nova por requisicao, igual ao monolito

const mysql = require('mysql2/promise')
const { client } = require('./metricas')

const USAR_POOL = (process.env.DB_POOL || 'on') === 'on'

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
  help: 'Conexoes em uso nesse momento'
})

let pool = null
if (USAR_POOL) {
  pool = mysql.createPool({
    ...config,
    connectionLimit: 10, // no maximo 10 conexoes por processo
    maxIdle: 10,
    idleTimeout: 60000,
    waitForConnections: true // se as 10 estiverem ocupadas espera na fila
  })

  // so conta quando o pool precisa abrir uma conexao nova de verdade
  pool.pool.on('connection', () => conexoesAbertas.inc())
}

async function conectar(req) {
  let conn = null
  let terminou = false

  const devolver = () => {
    if (USAR_POOL) conn.release()
    else conn.end().catch(() => {})
    conexoesAtivas.dec()
  }

  // no final da requisicao devolve pro pool (ou fecha, se nao tiver pool)
  // tem que registrar ANTES de pegar a conexao: se o gateway desistir (timeout) enquanto
  // a gente espera na fila do pool, o 'close' dispara antes e a conexao nunca voltava.
  // com 10 conexoes perdidas o worker travava de vez
  req.res.on('close', () => {
    terminou = true
    if (conn) devolver()
  })

  if (USAR_POOL) {
    conn = await pool.getConnection()
  } else {
    conn = await mysql.createConnection(config)
    conexoesAbertas.inc()
  }
  conexoesAtivas.inc()

  if (terminou) {
    devolver()
    throw new Error('cliente desistiu antes de pegar conexao no banco')
  }

  return {
    async query(sql, params) {
      // conexao ja foi devolvida, nao pode mais usar
      if (terminou) throw new Error('cliente desistiu no meio da requisicao')
      req.qtdQueries++
      const [linhas] = await conn.query(sql, params)
      return linhas
    }
  }
}

// pra consultas fora de requisicao (gauges do /metrics)
async function consultaAvulsa(sql, params) {
  if (USAR_POOL) {
    const [linhas] = await pool.query(sql, params)
    return linhas
  }
  const conn = await mysql.createConnection(config)
  try {
    const [linhas] = await conn.query(sql, params)
    return linhas
  } finally {
    await conn.end()
  }
}

console.log('banco: ' + (USAR_POOL ? 'com pool (10 conexoes)' : 'sem pool, conexao nova por requisicao'))

module.exports = { conectar, consultaAvulsa }
