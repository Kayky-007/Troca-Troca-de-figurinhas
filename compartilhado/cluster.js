// roda o app em varios processos (servidor de producao, tipo o gunicorn do python)
//
// WORKERS=1 (padrao) roda num processo so, igual antes
// WORKERS=4 o processo principal sobe 4 workers que dividem a mesma porta
//
// problema: cada worker tem as metricas dele, entao se o prometheus buscar o /metrics
// cai num worker diferente cada vez e os numeros ficam pulando.
// por isso o processo principal junta as metricas de todos (AggregatorRegistry)
// e mostra numa porta separada (porta do app + 100)

const cluster = require('cluster')
const express = require('express')
const { AggregatorRegistry } = require('prom-client')

function rodarEmCluster(nome, porta, iniciarApp) {
  const workers = Number(process.env.WORKERS || 1)

  if (workers <= 1) {
    return iniciarApp()
  }

  if (cluster.isPrimary) {
    // no windows o padrao e deixar o sistema escolher o worker e quase tudo cai num so
    // com SCHED_RR o processo principal distribui as conexoes em round robin
    cluster.schedulingPolicy = cluster.SCHED_RR

    console.log(nome + ': subindo ' + workers + ' workers')
    for (let i = 0; i < workers; i++) {
      cluster.fork()
    }

    // se um worker morrer sobe outro no lugar
    cluster.on('exit', (worker) => {
      console.log(nome + ': worker ' + worker.process.pid + ' morreu, subindo outro')
      cluster.fork()
    })

    const registro = new AggregatorRegistry()
    const portaMetricas = Number(porta) + 100
    const app = express()

    app.get('/metrics', async (req, res) => {
      try {
        const metricas = await registro.clusterMetrics()
        res.set('Content-Type', registro.contentType)
        res.send(metricas)
      } catch (e) {
        res.status(500).send(e.message)
      }
    })

    app.listen(portaMetricas, () => {
      console.log(nome + ': metricas de todos os workers em http://localhost:' + portaMetricas + '/metrics')
    })
  } else {
    // o worker tambem precisa criar o AggregatorRegistry, senao ele nao responde
    // quando o principal pede as metricas (descobri isso lendo o codigo do prom-client)
    new AggregatorRegistry()
    iniciarApp()
  }
}

module.exports = { rodarEmCluster }
