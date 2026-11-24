// compara array + includes com Set + has
// mesmo tamanho do nosso banco: 980 figurinhas, colecionador com ~500, ~29 mil repetidas dos outros
//
// uso: npm run benchmark

const TOTAL_FIGURINHAS = 980
const REPETIDAS_DOS_OUTROS = 29000
const VEZES = 200

// colecionador com metade do album
const todas = []
for (let i = 1; i <= TOTAL_FIGURINHAS; i++) todas.push(i)
const minhas = todas.filter(() => Math.random() < 0.5)

const repetidas = []
for (let i = 0; i < REPETIDAS_DOS_OUTROS; i++) {
  repetidas.push(1 + Math.floor(Math.random() * TOTAL_FIGURINHAS))
}

function comArray() {
  const faltando = todas.filter((id) => !minhas.includes(id))
  return repetidas.filter((id) => faltando.includes(id)).length
}

function comSet() {
  const tenho = new Set(minhas)
  const faltando = new Set(todas.filter((id) => !tenho.has(id)))
  return repetidas.filter((id) => faltando.has(id)).length
}

function medir(nome, fn) {
  fn() // aquece
  const inicio = process.hrtime.bigint()
  let resultado
  for (let i = 0; i < VEZES; i++) resultado = fn()
  const ms = Number(process.hrtime.bigint() - inicio) / 1e6 / VEZES
  console.log(nome.padEnd(16) + ms.toFixed(3) + ' ms por chamada   (achou ' + resultado + ' sugestoes)')
  return ms
}

console.log('sugestoes de troca, media de ' + VEZES + ' execucoes\n')
const a = medir('array.includes', comArray)
const s = medir('Set.has', comSet)
console.log('\nSet foi ' + (a / s).toFixed(0) + 'x mais rapido')
