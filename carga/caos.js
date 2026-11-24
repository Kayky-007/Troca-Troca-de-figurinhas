// liga e desliga o caos nos servicos sem precisar lembrar das urls
//
//   npm run caos -- ligar trocas              500 em todas as requisicoes do servico de trocas
//   npm run caos -- ligar trocas lentidao 100 trocas demora 5s pra responder
//   npm run caos -- ligar album1 erro 100     derruba so uma replica do album
//   npm run caos -- desligar trocas
//   npm run caos -- status                    mostra o caos e os circuitos do gateway

const servicos = {
  trocas: 'http://localhost:4002',
  album1: 'http://localhost:4001',
  album2: 'http://localhost:4011'
}

async function main() {
  const [acao, nome, tipo = 'erro', taxa = '100'] = process.argv.slice(2)

  if (acao === 'status') {
    for (const [n, url] of Object.entries(servicos)) {
      const r = await fetch(url + '/caos').then((r) => r.json()).catch(() => 'fora do ar')
      console.log(n.padEnd(8), r)
    }
    const c = await fetch('http://localhost:3000/circuitos').then((r) => r.json()).catch(() => 'fora do ar')
    console.log('gateway ', c)
    return
  }

  const base = servicos[nome]
  if (!base || (acao !== 'ligar' && acao !== 'desligar')) {
    console.log('uso: npm run caos -- ligar|desligar trocas|album1|album2 [erro|lentidao] [taxa]')
    console.log('     npm run caos -- status')
    process.exit(1)
  }

  const url = acao === 'ligar'
    ? base + '/caos/ativar-falha?tipo=' + tipo + '&taxa=' + taxa
    : base + '/caos/desativar'

  const r = await fetch(url, { method: 'POST' })
  console.log(nome + ':', await r.json())
}

main().catch((e) => {
  console.error('nao consegui falar com o servico:', e.message)
  process.exit(1)
})
