// padroes de resiliencia usados pelo gateway nas chamadas pros servicos
// - circuit breaker (fechado, aberto, meio-aberto)
// - retry com backoff exponencial
// o timeout fica no proprio fetch (AbortSignal.timeout) la no server.js

const { client } = require('../compartilhado/metricas')

const ESTADOS = { fechado: 0, meio_aberto: 1, aberto: 2 }

const estadoCircuito = new client.Gauge({
  name: 'circuit_breaker_estado',
  help: 'Estado do circuit breaker: 0 fechado, 1 meio-aberto, 2 aberto',
  labelNames: ['instancia'],
  aggregator: 'max' // em cluster mostra o pior estado entre os workers
})

const mudancasCircuito = new client.Counter({
  name: 'circuit_breaker_mudancas_total',
  help: 'Quantas vezes o circuito mudou de estado',
  labelNames: ['instancia', 'para']
})

const retries = new client.Counter({
  name: 'upstream_retries_total',
  help: 'Tentativas repetidas depois de uma falha',
  labelNames: ['servico']
})

// circuit breaker
//
// fechado:     tudo passa. guarda o resultado das ultimas 20 chamadas, se tiver pelo menos 10
//              e metade ou mais deu erro, abre
// aberto:      nem tenta chamar o servico, falha na hora (fail fast). fica assim por 10s
// meio_aberto: depois dos 10s deixa passar UMA chamada de teste.
//              deu certo -> fecha, deu errado -> abre de novo por mais 10s
class CircuitBreaker {
  constructor(nome, opcoes = {}) {
    this.nome = nome
    this.janela = opcoes.janela || 20
    this.minimo = opcoes.minimo || 10
    this.limiteErro = opcoes.limiteErro || 50 // em %
    this.tempoAberto = opcoes.tempoAberto || 10000 // ms

    this.estado = 'fechado'
    this.resultados = [] // true = sucesso, false = falha
    this.abertoEm = 0
    this.testando = false

    estadoCircuito.set({ instancia: nome }, 0)
  }

  mudar(novo) {
    if (this.estado === novo) return
    console.log('circuit breaker ' + this.nome + ': ' + this.estado + ' -> ' + novo)
    this.estado = novo
    estadoCircuito.set({ instancia: this.nome }, ESTADOS[novo])
    mudancasCircuito.inc({ instancia: this.nome, para: novo })

    if (novo === 'aberto') this.abertoEm = Date.now()
    if (novo === 'fechado') this.resultados = []
    this.testando = false
  }

  // so olha, nao muda nada (usado pelo round robin pra pular replica com circuito aberto)
  disponivel() {
    if (this.estado === 'fechado') return true
    if (this.estado === 'aberto') return Date.now() - this.abertoEm >= this.tempoAberto
    return !this.testando
  }

  // pede permissao pra chamar
  podeChamar() {
    if (this.estado === 'aberto' && Date.now() - this.abertoEm >= this.tempoAberto) {
      this.mudar('meio_aberto')
    }
    if (this.estado === 'aberto') return false
    if (this.estado === 'meio_aberto') {
      if (this.testando) return false // ja tem uma chamada de teste rodando
      this.testando = true
    }
    return true
  }

  sucesso() {
    if (this.estado === 'meio_aberto') return this.mudar('fechado')
    this.anotar(true)
  }

  falha(motivo) {
    if (this.estado === 'meio_aberto') {
      console.log('circuit breaker ' + this.nome + ': chamada de teste falhou (' + motivo + ')')
      return this.mudar('aberto')
    }
    if (this.estado === 'aberto') return
    this.anotar(false)

    const falhas = this.resultados.filter((r) => !r).length
    if (this.resultados.length >= this.minimo && (falhas / this.resultados.length) * 100 >= this.limiteErro) {
      this.mudar('aberto')
    }
  }

  anotar(ok) {
    this.resultados.push(ok)
    if (this.resultados.length > this.janela) this.resultados.shift()
  }
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// tenta de novo esperando cada vez mais: ~100ms, ~200ms, ~400ms...
// o aleatorio (jitter) e pra nao voltar todo mundo no mesmo instante e derrubar o servico de novo
async function comRetry(servico, tentativas, fn) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await fn()
    } catch (e) {
      // circuito aberto e timeout nao adianta repetir
      if (tentativa >= tentativas || !e.repetir) throw e

      const espera = 100 * 2 ** (tentativa - 1) + Math.random() * 100
      retries.inc({ servico })
      await esperar(espera)
    }
  }
}

module.exports = { CircuitBreaker, comRetry }
