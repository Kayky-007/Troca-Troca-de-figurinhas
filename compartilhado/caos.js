// engenharia do caos: liga uma falha de proposito no servico pra ver se o gateway aguenta
//
// POST /caos/ativar-falha?tipo=erro&taxa=100      responde 500 em 100% das requisicoes
// POST /caos/ativar-falha?tipo=lentidao&taxa=50   metade das requisicoes demora 5s pra responder
// POST /caos/desativar                            volta ao normal
// GET  /caos                                      mostra como esta
//
// ou pelo script: npm run caos -- ligar trocas erro 100

const cluster = require('cluster')
const { client } = require('./metricas')

let falha = { ativa: false, tipo: 'erro', taxa: 100, atraso: 5000 }

const caosAtivo = new client.Gauge({
  name: 'caos_falha_ativa',
  help: '1 quando tem falha injetada no servico',
  labelNames: ['tipo'],
  aggregator: 'max'
})

const falhasInjetadas = new client.Counter({
  name: 'caos_falhas_injetadas_total',
  help: 'Quantas requisicoes foram sabotadas pelo caos',
  labelNames: ['tipo']
})

function aplicar(nova) {
  falha = nova
  caosAtivo.reset()
  if (falha.ativa) caosAtivo.set({ tipo: falha.tipo }, 1)
  console.log('caos (pid ' + process.pid + '): ' + (falha.ativa ? falha.tipo + ' em ' + falha.taxa + '%' : 'desligado'))
}

// em cluster a requisicao cai em so um worker, entao avisa o principal
// e ele repassa pra todos (veja compartilhado/cluster.js)
function espalhar(nova) {
  aplicar(nova)
  if (cluster.isWorker) process.send({ tipo: 'caos', falha: nova })
}

if (cluster.isWorker) {
  process.on('message', (msg) => {
    if (msg && msg.tipo === 'caos') aplicar(msg.falha)
  })
}

function rotasCaos(app) {
  app.get('/caos', (req, res) => res.json(falha))

  app.post('/caos/ativar-falha', (req, res) => {
    const tipo = req.query.tipo || 'erro'
    if (tipo !== 'erro' && tipo !== 'lentidao') {
      return res.status(400).json({ erro: 'tipo tem que ser erro ou lentidao' })
    }
    const taxa = Math.min(100, Math.max(0, Number(req.query.taxa || 100)))
    const atraso = Number(req.query.atraso || 5000)

    espalhar({ ativa: true, tipo, taxa, atraso })
    res.json(falha)
  })

  app.post('/caos/desativar', (req, res) => {
    espalhar({ ...falha, ativa: false })
    res.json(falha)
  })
}

// middleware que sabota as requisicoes normais
function injetarFalha(req, res, next) {
  if (!falha.ativa) return next()
  if (req.path === '/metrics' || req.path === '/saude' || req.path.startsWith('/caos')) return next()
  if (Math.random() * 100 >= falha.taxa) return next()

  falhasInjetadas.inc({ tipo: falha.tipo })

  if (falha.tipo === 'lentidao') {
    // so atrasa, depois responde normal (o gateway vai desistir antes por causa do timeout)
    return setTimeout(next, falha.atraso)
  }
  res.status(500).json({ erro: 'falha injetada pelo caos' })
}

module.exports = { rotasCaos, injetarFalha }
