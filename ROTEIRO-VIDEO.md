# Roteiro do vídeo

Cada um grava os seus clipes quando quiser, e no final a gente junta tudo na ordem.
Kayky fica com a parte técnica e o código. Nicolly fica com o Prometheus, o Grafana e os gráficos.

## Ordem final do vídeo

| Ordem | Arquivo | Quem | Assunto | Tempo |
|---|---|---|---|---|
| 1 | `01-kayky-introducao.mp4` | Kayky | Projeto e arquitetura | 2 min |
| 2 | `02-kayky-metricas-e-n1.mp4` | Kayky | Código das métricas e do N+1 | 1 min |
| 3 | `03-nicolly-prometheus-e-n1.mp4` | Nicolly | Prometheus e gráfico do N+1 | 1 min e meio |
| 4 | `04-kayky-rede-e-servidor.mp4` | Kayky | Servidor, gzip e cache no código | 1 min e meio |
| 5 | `05-nicolly-cache.mp4` | Nicolly | Gráficos do cache | 1 min e meio |
| 6 | `06-kayky-circuit-breaker.mp4` | Kayky | Código do circuit breaker e fallback | 1 min e meio |
| 7 | `07-nicolly-carga-e-caos.mp4` | Nicolly | Locust e caos ao vivo | 3 min e meio |
| 8 | `08-kayky-conclusao.mp4` | Kayky | Números de antes e depois | 1 min |
| 9 | `09-nicolly-conclusao.mp4` | Nicolly | O que a gente aprendeu | 1 min |

Total: mais ou menos 14 minutos (tem que ficar entre 10 e 15).

## Combinados para os vídeos ficarem parecidos

- Gravar a tela em **1920x1080**
- Grafana no **mesmo tema** (claro ou escuro, os dois iguais)
- Não precisa falar "oi" nem "agora sou eu" no começo de cada clipe, já começa direto no assunto
- No PowerShell usar `curl.exe` e não só `curl`

---

# Parte do Kayky

## Preparação

1. Abrir o Docker Desktop e rodar `docker compose up -d`
2. Rodar `npm run micro` e deixar esse terminal aberto
3. Deixar aberto:
   - O PDF do relatório (Figura 1 e tabela "Antes e depois")
   - VS Code com os arquivos:
     - `compartilhado/metricas.js`
     - `observabilidade/prometheus.yml`
     - `servico-album/server.js`
     - `gateway/server.js`
     - `gateway/resiliencia.js`
   - Navegador na página http://localhost:3000/album
   - Um terminal livre

## Clipe 01: Introdução e arquitetura (2 min)

**Mostrar:** o diagrama do relatório (Figura 1)

**Falar:**
- "Nosso projeto é um álbum de figurinhas da Copa onde as pessoas podem abrir pacotinhos e trocar figurinhas repetidas."
- "A primeira versão foi feita simples de propósito: tudo num programa só, sem cache, abrindo conexão nova no banco toda hora."
- "Depois separamos em partes: um gateway na frente, um serviço de álbum com duas cópias e um serviço de trocas."
- "O gateway divide as chamadas do álbum entre as duas cópias, uma vez para cada."
- "Para medir tudo usamos o Prometheus e o Grafana, e para simular os usuários usamos o Locust."

## Clipe 02: Métricas e N+1 no código (1 min)

- Abrir `compartilhado/metricas.js`
  - "Aqui criamos as métricas: um contador de requisições, um histograma do tempo de resposta e um medidor das requisições em andamento."
- Abrir `observabilidade/prometheus.yml`
  - "Aqui falamos para o Prometheus de onde buscar as métricas, a cada 5 segundos."
- Abrir `servico-album/server.js`, nas funções `albumN1` e `albumJoin`
  - "Esse era o problema N+1, uma consulta para cada seleção, 50 no total. Trocamos por uma consulta só com JOIN."

## Clipe 04: Servidor, gzip e cache (1 min e meio)

- Mostrar o terminal do `npm run micro` com a linha "subindo 2 workers"
  - "Não usamos o servidor de desenvolvimento. O gateway roda em 2 processos, parecido com o Gunicorn."
- Abrir `gateway/server.js` na parte do `LRUCache`
  - "Aqui o gateway guarda o álbum na memória por 60 segundos, assim não precisa buscar no serviço toda hora."
- No navegador, na página do álbum, apertar F12, ir em Rede (Network) e recarregar
  - "A resposta chega comprimida com gzip. Caiu de 80 KB para 8 KB."
  - Mostrar os cabeçalhos `Cache-Control` e `X-Cache: HIT`

## Clipe 06: Circuit breaker e fallback (1 min e meio)

- Abrir `gateway/resiliencia.js`
  - "Aqui está o circuit breaker. Se metade das chamadas der erro, ele abre e para de chamar o serviço por 10 segundos. Depois testa uma chamada, se der certo fecha de novo."
- Abrir `gateway/server.js` na função `fallbackTrocas`
  - "E aqui o fallback. Enquanto o serviço está fora, o gateway responde com a última resposta boa que guardou."
- No terminal, mostrar funcionando:
  ```
  curl.exe http://localhost:3000/colecionadores/5
  curl.exe http://localhost:3000/colecionadores/5
  npm run caos -- ligar trocas
  curl.exe -i http://localhost:3000/colecionadores/5
  ```
  - Mostrar a linha `X-Fallback: copia_antiga`
  - "Mesmo com o serviço de trocas fora do ar, a resposta veio, só que do fallback."
- Desligar no final:
  ```
  npm run caos -- desligar trocas
  ```

Os dois primeiros `curl.exe` são para o gateway guardar uma resposta boa antes de derrubar o serviço. São dois porque o gateway roda em 2 processos e cada um guarda a sua cópia. Se mesmo assim aparecer erro 503, é só rodar o `curl.exe -i` de novo.

## Clipe 08: Conclusão (1 min)

**Mostrar:** a tabela "Antes e depois" do relatório

**Falar:**
- "Na primeira versão o P95 era de 2600 ms. Na versão final caiu para 110 ms."
- "E no teste de caos, sem as proteções 78% das requisições deram erro com o serviço fora. Com elas, só 16%."

---

# Parte da Nicolly

## Preparação

1. Seguir o `COMO-RODAR.md` até o passo 5 (tudo instalado e funcionando)
2. Deixar aberto no navegador:
   - Grafana: http://localhost:3030 (painel Figurinhas, período "Last 15 minutes")
   - Prometheus: http://localhost:9090/targets
   - Locust: http://localhost:8089
3. Um terminal livre para os comandos

## Clipe 03: Prometheus e gráfico do N+1 (1 min e meio)

Com o cache ligado quase nada chega no serviço de álbum e o gráfico fica vazio. Por isso esse clipe precisa de uma preparação diferente.

**Preparação (antes de gravar):**
1. Parar o `npm run micro` com `Ctrl + C`
2. Rodar:
   ```
   $env:CACHE="off"; npm run micro
   ```
3. Colocar o álbum no modo antigo:
   ```
   curl.exe -X POST http://localhost:4001/admin/modo/n1
   curl.exe -X POST http://localhost:4011/admin/modo/n1
   ```
4. Iniciar o Locust com 100 usuários e esperar 1 minuto

**Gravando:**
- Aba do Prometheus targets
  - "Aqui o Prometheus mostra que está conseguindo ler os serviços. O gateway, as duas cópias do álbum e o trocas estão UP."
- Aba do Grafana, escolher App = album, linha "Banco de dados", painel "Queries no banco por requisição"
  - "Agora o álbum está no jeito antigo, fazendo 50 consultas no banco por requisição."
- No terminal, trocar para o JOIN:
  ```
  curl.exe -X POST http://localhost:4001/admin/modo/join
  curl.exe -X POST http://localhost:4011/admin/modo/join
  ```
- Esperar uns 30 segundos no gráfico
  - "Quando trocamos para o JOIN, as consultas por requisição caíram de 50 para 1 e o tempo de resposta caiu junto."

**Depois de gravar:** parar o Locust, parar o `npm run micro`, **fechar esse terminal**, abrir um novo e rodar `npm run micro` normal. O `$env:CACHE="off"` só vale naquele terminal, então se não abrir um novo o cache continua desligado.

Se ficar complicado, dá para mostrar a Figura 3 do relatório nesse clipe em vez de fazer ao vivo.

## Clipe 05: Gráficos do cache (1 min e meio)

**Preparação:** com o `npm run micro` normal, deixar o Locust rodando com 100 usuários por uns 2 minutos antes de gravar.

**Gravando**, no Grafana com App = All, linha "Cache e rede":
- Painel "Taxa de cache hit"
  - "Quase todas as requisições pegam o álbum da memória, mais de 99%."
- Painel "Cache hit x miss por segundo"
  - "A linha verde são as vezes que achou no cache. A amarela de miss aparece de vez em quando porque o cache expira a cada 60 segundos e busca de novo."
- Painel "Bytes por resposta"
  - "E aqui dá para ver o tamanho das respostas, que ficou pequeno por causa da compressão."

## Clipe 07: Teste de carga e caos ao vivo (3 min e meio)

**Preparação:** `npm run micro` normal rodando e o Locust parado.

**Gravando:**
1. No Locust: 100 usuários, 10 por segundo, clicar em Start
   - "Aqui o Locust simula 100 pessoas usando o sistema ao mesmo tempo."
2. Esperar 1 minuto e mostrar a aba Statistics, colunas 95%ile e 99%ile
   - "O P95 é o tempo que 95% das requisições levaram. Está em volta de 100 ms."
3. No Grafana, linha "Visão geral"
   - "Aqui no Grafana vemos as requisições por segundo, o tempo de resposta e o erro em 0%."
4. No terminal, derrubar o serviço de trocas:
   ```
   npm run caos -- ligar trocas
   ```
   - "Agora vamos derrubar o serviço de trocas de propósito."
5. No Grafana, linha "Resiliencia e caos":
   - Painel "Estado do circuit breaker"
     - "O trocas ficou vermelho, o circuito abriu."
   - Painel "Fallbacks e retries por segundo"
     - "Essa linha verde são as respostas que o gateway deu sozinho enquanto o serviço estava fora."
   - Painel "Respostas do gateway por status"
     - "A maior parte continua dando certo. Só as ações de escrita, como abrir pacotinho, dão erro."
6. Religar o serviço:
   ```
   npm run caos -- desligar trocas
   ```
   - Esperar uns 10 a 15 segundos no painel do circuit breaker
   - "Desligamos a falha, e o circuito fechou sozinho. O sistema voltou ao normal."
7. Parar o Locust

## Clipe 09: Conclusão (1 min)

**Mostrar:** o painel do Grafana ou a tabela do relatório

**Falar:**
- "O que a gente aprendeu é que medir antes de mudar ajuda muito. Só separar em microsserviços não deixou o sistema mais rápido, o problema estava no banco."
- "As mudanças mais simples, como o JOIN e o cache, foram as que mais ajudaram."
- "E o teste de caos achou um erro nosso que não aparecia nos testes normais."

---

# Juntando os vídeos

1. Abrir o Clipchamp (já vem no Windows) ou o CapCut
2. Colocar os clipes na linha do tempo na ordem dos números (01, 02, 03...)
3. Ver se o total ficou entre 10 e 15 minutos
4. Exportar em MP4
