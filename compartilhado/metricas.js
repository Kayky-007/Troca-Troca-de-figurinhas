// metricas que todos os apps usam
// o prometheus busca tudo em GET /metrics (modelo pull)

const client = require('prom-client')
const cluster = require('cluster')

// cpu, memoria, event loop etc
client.collectDefaultMetrics()

const requisicoes = new client.Counter({
  name: 'http_requests_total',
  help: 'Total de requisicoes HTTP',
  labelNames: ['metodo', 'rota', 'status']
})

const duracao = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Tempo de resposta das requisicoes',
  labelNames: ['metodo', 'rota'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
})

const emAndamento = new client.Gauge({
  name: 'http_requests_em_andamento',
  help: 'Requisicoes sendo processadas agora'
})

const bytesEnviados = new client.Counter({
  name: 'http_response_bytes_total',
  help: 'Bytes enviados nas respostas (depois do gzip, se tiver)',
  labelNames: ['rota']
})

const dbQueries = new client.Counter({
  name: 'db_queries_total',
  help: 'Total de queries feitas no banco',
  labelNames: ['rota']
})

const queriesPorRequisicao = new client.Histogram({
  name: 'db_queries_por_requisicao',
  help: 'Quantas queries cada requisicao fez',
  labelNames: ['rota'],
  buckets: [1, 2, 5, 10, 20, 50, 100]
})

// middleware que mede todas as rotas
function medirRequisicoes(req, res, next) {
  if (req.path === '/metrics') return next()

  req.qtdQueries = 0
  emAndamento.inc()
  const pararTimer = duracao.startTimer()
  const bytesAntes = req.socket.bytesWritten

  // 'close' dispara sempre, ate quando o cliente desiste no meio
  res.on('close', () => {
    // usa o caminho da rota (/colecionadores/:id) e nao a url, senao vira uma label pra cada id
    const rota = req.route ? req.baseUrl + req.route.path : 'nao_encontrada'

    pararTimer({ metodo: req.method, rota })
    requisicoes.inc({ metodo: req.method, rota, status: res.statusCode })
    bytesEnviados.inc({ rota }, req.socket.bytesWritten - bytesAntes)
    emAndamento.dec()

    if (req.qtdQueries > 0) {
      dbQueries.inc({ rota }, req.qtdQueries)
      queriesPorRequisicao.observe({ rota }, req.qtdQueries)
    }
  })

  next()
}

async function rotaMetrics(req, res) {
  // rodando em cluster quem mostra as metricas e o processo principal (veja cluster.js)
  if (cluster.isWorker) {
    return res.status(404).send('rodando em cluster, as metricas ficam na porta do app + 100')
  }
  res.set('Content-Type', client.register.contentType)
  res.end(await client.register.metrics())
}

module.exports = { client, medirRequisicoes, rotaMetrics }
