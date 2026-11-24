# Troca-Troca de figurinhas

Atividade 01 de Engenharia de Performance, Escala e Resiliencia.

Album de figurinhas da Copa 2026 com trocas entre colecionadores. A ideia é começar com uma versão bem simples (monolito, sem cache, com N+1) e ir melhorando ate virar microsservicos com cache, metricas e circuit breaker.

## O que precisa ter instalado

- Docker Desktop
- Node.js 22
- Python 3 (pro Locust)

## Subindo o banco, Prometheus e Grafana

```
docker compose up -d
```

Na primeira vez o MySQL demora uns 30 segundos pra criar as tabelas e colocar os dados.

| O que | Endereço | Login |
|---|---|---|
| MySQL | localhost:3307 | app / app123 (banco figurinhas) |
| Prometheus | http://localhost:9090 | |
| Grafana | http://localhost:3030 | admin / admin |

Pra zerar o banco e criar tudo de novo:

```
docker compose down -v
docker compose up -d
```

## Banco

- 48 seleções + 1 grupo de especiais (FWC)
- 980 figurinhas (20 por seleção)
- 200 colecionadores
- colecao com umas 98 mil linhas (cada um tem entre 15% e 85% do album, com repetidas)
- 500 trocas

Os scripts ficam em `banco/` e rodam sozinhos quando o container sobe pela primeira vez.

## Instalando as dependencias

Um `npm install` na raiz serve pra todos os apps.

```
npm install
```

## Versao 1 - monolito

```
npm run monolito
```

Sobe na porta 3001. É a versão ruim de proposito: abre conexão nova no banco a cada requisição, tem N+1 no album, usa `includes` em array pra achar faltantes e roda num processo só.

Rotas:

| Rota | O que faz |
|---|---|
| GET /album | album completo (N+1, 50 queries) |
| GET /colecionadores/:id | dados e % do album |
| GET /colecionadores/:id/album | album marcando quais ele tem |
| GET /colecionadores/:id/faltantes | figurinhas que faltam |
| GET /colecionadores/:id/repetidas | repetidas pra trocar |
| GET /colecionadores/:id/sugestoes-troca | quem tem repetida de uma que me falta |
| POST /colecionadores/:id/pacotinho | abre um pacotinho com 5 figurinhas |
| GET /colecionadores/:id/trocas | trocas do colecionador |
| POST /trocas | propõe troca (body: quem_oferece_id, quem_recebe_id, figurinha_oferecida_id, figurinha_pedida_id) |
| POST /trocas/:id/aceitar | aceita a troca |
| POST /trocas/:id/recusar | recusa a troca |
| GET /metrics | metricas pro Prometheus |

Metricas expostas:

- `http_requests_total` (Counter) por metodo, rota e status, da pra filtrar 4xx e 5xx
- `http_request_duration_seconds` (Histogram) latencia por rota
- `http_requests_em_andamento` (Gauge)
- `db_queries_total` (Counter) e `db_queries_por_requisicao` (Histogram)
- `db_conexoes_abertas_total` (Counter) e `db_conexoes_ativas` (Gauge)
- negocio: `pacotinhos_abertos_total`, `figurinhas_recebidas_total{repetida}`, `trocas_total{status}`, `album_progresso_medio_porcentagem`, `figurinhas_repetidas_estoque`

## Dashboard

O dashboard "Troca-Troca de figurinhas" já aparece sozinho no Grafana (pasta Figurinhas). No topo tem o filtro App pra escolher monolito, gateway, album ou trocas.

## Teste de carga (Locust)

Instalar uma vez:

```
pip install locust==2.47.0
```

Baseline no monolito (100 usuarios, entrando 10 por segundo, 3 minutos):

```
python -m locust -f carga/locustfile.py --host http://localhost:3001 --headless -u 100 -r 10 -t 3m --csv carga/resultados/baseline --html carga/resultados/baseline.html
```

Os resultados ficam em `carga/resultados/`. Cada usuario espera de 1 a 3 segundos entre uma ação e outra (think time).

Se quiser ver a interface do Locust é só tirar o `--headless` e abrir http://localhost:8089

### Resultado do baseline (monolito)

| | P50 | P95 | P99 | RPS | Falhas |
|---|---|---|---|---|---|
| Geral | 360 ms | 2600 ms | 4100 ms | 40,8 | 0% |
| GET /album | 1200 ms | 3500 ms | 4600 ms | 6,2 | 0% |
| GET /colecionadores/[id]/album | 1200 ms | 3500 ms | 5800 ms | 4,3 | 0% |
| GET /colecionadores/[id]/sugestoes-troca | 430 ms | 1800 ms | 5300 ms | 2,2 | 0% |

## Versao 2 - microsservicos

```
npm run micro
```

Sobe 4 processos de uma vez:

- `servico-album` nas portas 4001 e 4011 (2 replicas): album e lista de figurinhas
- `servico-trocas` na porta 4002: colecionadores, colecao, pacotinhos e trocas
- `gateway` na porta 3000: é por onde tudo entra, repassa pros serviços via HTTP

O gateway divide as chamadas do album entre as 2 replicas em round robin (uma pra cada). Da pra ver isso no header `X-Instancia` da resposta:

```
curl -i http://localhost:3000/album
```

O `/colecionadores/:id/album` é montado pelo gateway: ele pede o album pro serviço de album e a coleção pro serviço de trocas, e junta os dois.

Tambem da pra subir cada um separado: `npm run album1`, `npm run album2`, `npm run trocas`, `npm run gateway`.

Teste de carga nos microsservicos:

```
python -m locust -f carga/locustfile.py --host http://localhost:3000 --headless -u 100 -r 10 -t 3m --csv carga/resultados/micro-sem-otimizacao --html carga/resultados/micro-sem-otimizacao.html
```

### Monolito x microsservicos (os dois ainda sem otimizar)

| | P50 | P95 | P99 | RPS | Falhas |
|---|---|---|---|---|---|
| Monolito | 360 ms | 2600 ms | 4100 ms | 40,8 | 0% |
| Microsservicos | 950 ms | 2400 ms | 3400 ms | 35,6 | 0,02% |

Só separar em serviços não deixou mais rapido. O P95 e o P99 melhoraram um pouco porque o album ficou dividido em 2 processos, mas o P50 piorou por causa do salto a mais no gateway. O gargalo continua sendo o banco (N+1 e conexão nova toda hora), isso é o que a proxima etapa resolve.

A falha foi um 500 no pacotinho: dois usuarios com o mesmo colecionador abriram pacotinho ao mesmo tempo, os dois viram que não tinham a figurinha e os dois tentaram inserir (chave duplicada).

## Etapa 4 - banco e conexoes

O que mudou nos microsservicos:

- **N+1 resolvido**: o `/album` agora faz 1 JOIN só em vez de 50 queries
- **pool de conexões no MySQL**: cada serviço mantem até 10 conexões abertas e reaproveita (mysql2 `createPool`)
- **keep-alive no gateway**: as conexões HTTP com os serviços ficam abertas e são reaproveitadas (undici `Agent`)
- **pacotinho**: trocou SELECT + INSERT/UPDATE por um `INSERT ... ON DUPLICATE KEY UPDATE`, que faz 1 query por figurinha e acabou com o erro de chave duplicada

Da pra ligar e desligar cada coisa pra comparar:

| Variavel | Valores | Padrao |
|---|---|---|
| ALBUM_MODO | n1 ou join | join |
| DB_POOL | on ou off | on |
| HTTP_KEEPALIVE | on ou off | on |

O modo do album tambem da pra trocar com o app rodando (bom pra mostrar no grafana durante o teste):

```
curl -X POST http://localhost:4001/admin/modo/n1
curl -X POST http://localhost:4011/admin/modo/n1
```

### N+1 x JOIN no mesmo teste

Rodamos 4 minutos de Locust, começando em n1 e trocando pra join na metade:

| | n1 | join |
|---|---|---|
| Queries por requisição no /album | 50 | 1 |
| Queries por segundo no serviço de album | 736 | 16 |
| P95 do /album | 794 ms | 43 ms |

### Resultado depois da etapa 4

| | P50 | P95 | P99 | RPS | Falhas |
|---|---|---|---|---|---|
| Monolito | 360 ms | 2600 ms | 4100 ms | 40,8 | 0% |
| Microsservicos sem otimizar | 950 ms | 2400 ms | 3400 ms | 35,6 | 0,02% |
| Microsservicos + etapa 4 | 20 ms | 180 ms | 460 ms | 56,8 | 0% |

O RPS não sobe muito porque com 100 usuarios e 1 a 3 segundos de think time o maximo fica perto de 50 a 60 por segundo. Antes o sistema não dava conta disso, agora sobra.

## Etapa 5 - rede, codigo e servidor de producao

- **gzip**: o gateway comprime as respostas maiores que 1 KB (pacote `compression`). O `/album` caiu de 80 KB pra 8 KB.
- **Cache-Control**:
  - `/album` é igual pra todo mundo: `public, max-age=300`
  - rotas do colecionador: `private, no-cache` (o navegador confirma com o ETag e recebe 304 se nada mudou)
  - POST: `no-store`
- **Set no lugar de array**: `faltantes`, `sugestoes-troca` e o album do colecionador usavam `includes` (O(n) por busca), agora usam `Set.has` (O(1))
- **cache LRU no gateway**: o album fica em memoria por 60 segundos (`lru-cache`, max 100 itens). Header `X-Cache: HIT` ou `MISS` na resposta e metrica `cache_requests_total{resultado}`
- **cluster**: gateway e trocas rodam em 2 processos cada (modulo `cluster` do Node, é o equivalente ao Gunicorn). Se um worker morre o principal sobe outro

Por que não PM2: em modo cluster cada processo tem as metricas dele e o Prometheus pega um diferente a cada coleta. Com o `cluster` do Node o processo principal junta as metricas de todos (`AggregatorRegistry` do prom-client) e mostra na porta do app + 100:

| App | Porta do app | Metricas |
|---|---|---|
| gateway | 3000 | 3100 |
| trocas | 4002 | 4102 |

Novas chaves:

| Variavel | Valores | Padrao |
|---|---|---|
| GZIP | on ou off | on |
| CACHE | on ou off | on |
| CACHE_TTL | segundos | 60 |
| WORKERS | numero de processos | 1 (os scripts do npm usam 2) |

Pra subir tudo desligado (pra comparação):

```
npm run micro:sem-otimizacao
```

### Array x Set

```
npm run benchmark
```

Simula as sugestões de troca com o tamanho do nosso banco (980 figurinhas, ~29 mil repetidas):

| | Tempo por chamada |
|---|---|
| array.includes | 17,6 ms |
| Set.has | 1,2 ms (14x mais rapido) |

### Resultado depois da etapa 5

| | P50 | P95 | P99 | RPS | Falhas |
|---|---|---|---|---|---|
| Monolito | 360 ms | 2600 ms | 4100 ms | 40,8 | 0% |
| Microsservicos sem otimizar | 950 ms | 2400 ms | 3400 ms | 35,6 | 0,02% |
| Microsservicos + etapa 4 | 20 ms | 180 ms | 460 ms | 56,8 | 0% |
| Microsservicos + etapa 5 | 17 ms | 110 ms | 240 ms | 56,6 | 0% |

- cache hit de 99,6%, o serviço de album quase não recebe mais chamada (0,07 por segundo)
- sugestoes-troca: P50 de 120 ms pra 88 ms com o Set

## Etapa 6 - resiliencia e caos

Tudo isso fica no gateway, nas chamadas pros serviços (`gateway/resiliencia.js` e `gateway/server.js`):

- **timeout**: se o serviço não responder em 2s o gateway desiste (`AbortSignal.timeout`)
- **retry com backoff exponencial**: GET que deu erro de conexão ou 5xx tenta de novo mais 2 vezes, esperando ~100ms e depois ~200ms (com um aleatorio pra não voltar todo mundo junto). POST não repete (senão abre 2 pacotinhos) e timeout também não (se o serviço ta lento, mandar mais requisição só piora)
- **circuit breaker** feito na mão, um por instancia (album-4001, album-4011, trocas-4002):
  - fechado: anota as ultimas 20 chamadas, se pelo menos 10 e metade ou mais deu erro, abre
  - aberto: nem chama o serviço, responde na hora (fail fast) por 10s
  - meio-aberto: deixa passar 1 chamada de teste. deu certo fecha, deu errado abre de novo
  - no album o round robin pula a replica com circuito aberto, então se uma cair a outra segura
- **fallback** (degradação controlada):
  - `/album`: devolve a ultima copia boa que o gateway recebeu
  - leituras do colecionador: ultima resposta boa daquela url. Se não tiver, `sugestoes-troca` e `trocas` voltam lista vazia, e o `/colecionadores/:id/album` mostra o album com `tenho: null`
  - escrita (pacotinho, trocas): 503 rapido com `Retry-After`, não da pra inventar resposta
  - resposta de fallback vem com o header `X-Fallback` e conta na metrica `fallback_total`

Pra comparar da pra desligar tudo isso com `RESILIENCIA=off` (`npm run micro:sem-resiliencia`). Outras chaves: `TIMEOUT_MS` (padrao 2000) e `TENTATIVAS` (padrao 3).

Pra ver o estado dos circuitos: `curl http://localhost:3000/circuitos` (mostra o worker que respondeu) ou no Grafana, linha "Resiliencia e caos".

### Injetando falha (caos)

Os dois serviços tem as rotas de caos:

| Rota | O que faz |
|---|---|
| POST /caos/ativar-falha?tipo=erro&taxa=100 | responde 500 em 100% das requisicoes |
| POST /caos/ativar-falha?tipo=lentidao&taxa=100 | demora 5s pra responder (cai no timeout do gateway) |
| POST /caos/desativar | volta ao normal |
| GET /caos | mostra como esta |

Pelo script fica mais facil:

```
npm run caos -- ligar trocas
npm run caos -- ligar trocas lentidao 100
npm run caos -- ligar album1
npm run caos -- desligar trocas
npm run caos -- status
```

No servico de trocas (que roda em cluster) o worker que recebe o POST avisa o processo principal, e ele repassa pros outros workers. Senão só metade ficaria com falha.

### Experimento

Hipotese: se o serviço de trocas cair, o circuit breaker abre e o gateway continua respondendo as leituras pelo fallback, sem a latencia subir. So as escritas falham.

Locust com 100 usuarios por 4 minutos: 1 minuto normal, liga `erro 100%` no trocas, desliga depois de 90s.

```
python -m locust -f carga/locustfile.py --host http://localhost:3000 --headless -u 100 -r 10 -t 4m --csv carga/resultados/caos-com-resiliencia --html carga/resultados/caos-com-resiliencia.html
```

(no meio, em outro terminal: `npm run caos -- ligar trocas` e depois `npm run caos -- desligar trocas`)

Com resiliencia:

| Fase | RPS | Falhas | P50 | P95 | P99 |
|---|---|---|---|---|---|
| normal | 58,2 | 0% | 11 ms | 71 ms | 152 ms |
| trocas fora do ar | 55,1 | 16,1% | 7 ms | 55 ms | 127 ms |
| depois que voltou | 58,9 | 0,1% | 7 ms | 53 ms | 112 ms |

Sem resiliencia (`RESILIENCIA=off`), mesmo teste:

| Fase | RPS | Falhas | P50 | P95 | P99 |
|---|---|---|---|---|---|
| normal | 58,0 | 0% | 13 ms | 75 ms | 126 ms |
| trocas fora do ar | 49,8 | 78,6% | 8 ms | 58 ms | 108 ms |
| depois que voltou | 58,0 | 0,2% | 8 ms | 68 ms | 164 ms |

Falhas por rota no teste inteiro:

| Rota | Sem resiliencia | Com resiliencia |
|---|---|---|
| GET /colecionadores/[id] | 795 | 0 |
| GET /colecionadores/[id]/album | 561 | 0 |
| GET /colecionadores/[id]/faltantes | 598 | 15 |
| GET /colecionadores/[id]/repetidas | 538 | 5 |
| GET /colecionadores/[id]/sugestoes-troca | 301 | 0 |
| POST /colecionadores/[id]/pacotinho | 559 | 579 |
| Total | 3612 (27,9%) | 830 (6,2%) |

A hipotese se confirmou: durante a falha as leituras continuaram funcionando (as poucas que falharam foram de url que o gateway nunca tinha visto, então não tinha copia). O que falhou foram as escritas, que não tem como ter fallback. O circuito abriu em menos de 1 segundo e fechou uns 8 segundos depois do serviço voltar (na proxima chamada de teste do meio-aberto).

Com o erro sendo 500 imediato a latencia não muda muito nos dois casos. Com `lentidao` a diferença é maior: sem resiliencia cada requisição fica presa 5s esperando o serviço.

### Bug que o caos achou

Na primeira vez que rodamos o experimento o serviço de trocas continuava travado mesmo depois de desligar a falha. O problema era no `compartilhado/db.js`: quando o gateway desistia (timeout) enquanto a requisição ainda estava esperando conexão no pool, o evento `close` da resposta disparava antes da gente registrar o `res.on('close')`, e a conexão nunca voltava pro pool. Depois de 10 perdidas o worker travava de vez. A correção foi registrar o `close` antes de pedir a conexão. O monolito tinha o mesmo problema.

### Dica pra gravar

O banco frio (logo depois do `docker compose up`) deixa as primeiras queries lentas e o circuito pode abrir sozinho por timeout. Roda 1 minuto de Locust antes de gravar pra aquecer.

O Locust no Python 3.14 as vezes mostra um `ValueError: I/O operation on closed file` no final. É bug dele ao fechar o csv, os resultados são salvos normal.

## Onde esta cada requisito da atividade

| Requisito | Onde |
|---|---|
| /metrics, Counter, Gauge, Histogram | `compartilhado/metricas.js`, metricas de negocio no `servico-trocas/server.js` |
| Prometheus e Grafana | `observabilidade/prometheus.yml`, `observabilidade/grafana/dashboards/figurinhas.json` |
| Monolito x microsservicos | `monolito/` x `gateway/`, `servico-album/`, `servico-trocas/` |
| Escala horizontal (round robin) | 2 replicas do album, `urlAlbum()` no gateway |
| N+1 x JOIN | `servico-album/server.js` (`/admin/modo/n1` e `/admin/modo/join`) |
| Pool de conexões | `compartilhado/db.js` (MySQL) e `Agent` do undici no gateway (HTTP) |
| Gzip e Cache-Control | `gateway/server.js` |
| O(1) x O(n) | `servico-trocas/server.js` e `npm run benchmark` |
| Cache LRU com TTL | `gateway/server.js`, metrica `cache_requests_total` |
| Servidor de produção | `compartilhado/cluster.js` (cluster do Node, varios processos) |
| Teste de carga | `carga/locustfile.py`, resultados em `carga/resultados/` |
| Timeout, retry, circuit breaker, fallback | `gateway/resiliencia.js` e `gateway/server.js` |
| Caos | `compartilhado/caos.js` e `npm run caos` |

## Portas dos apps

| App | Porta |
|---|---|
| gateway | 3000 |
| monolito | 3001 |
| servico-album | 4001 e 4011 |
| servico-trocas | 4002 |
