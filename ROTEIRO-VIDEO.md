# Roteiro do vídeo

Kayky fala da parte técnica e do código. Nicolly fala do Prometheus, do Grafana e dos gráficos.
Tempo total: mais ou menos 13 minutos.

---

## Antes de gravar

1. Abrir o Docker Desktop e rodar `docker compose up -d`
2. Rodar `npm run micro` e deixar esse terminal aberto
3. Aquecer o banco: rodar o Locust por 1 minuto e parar
4. Deixar aberto:
   - **VS Code** com os arquivos:
     - `compartilhado/metricas.js`
     - `observabilidade/prometheus.yml`
     - `servico-album/server.js`
     - `gateway/server.js`
     - `gateway/resiliencia.js`
   - **Navegador** com 4 abas:
     - Grafana: http://localhost:3030 (painel Figurinhas, período "Last 15 minutes")
     - Prometheus: http://localhost:9090/targets
     - Locust: http://localhost:8089
     - Álbum: http://localhost:3000/album
   - **Um terminal livre** para os comandos de caos
   - **O PDF do relatório** aberto na Figura 1 (diagrama) e na tabela "Antes e depois"

No PowerShell use `curl.exe` e não só `curl`.

---

## Parte 1: Introdução e arquitetura (2 min)

**Quem fala:** Kayky

**Mostrar:** o diagrama do relatório (Figura 1)

**Falar:**
- "Nosso projeto é um álbum de figurinhas da Copa onde as pessoas podem abrir pacotinhos e trocar figurinhas repetidas."
- "A primeira versão foi feita simples de propósito: tudo num programa só, sem cache, abrindo conexão nova no banco toda hora."
- "Depois separamos em partes: um gateway na frente, um serviço de álbum com duas cópias e um serviço de trocas."
- "O gateway divide as chamadas do álbum entre as duas cópias, uma vez para cada."

---

## Parte 2: Monitoramento e banco de dados (3 min)

### Kayky (1 min), no VS Code

- Abrir `compartilhado/metricas.js`
  - "Aqui criamos as métricas: um contador de requisições, um histograma do tempo de resposta e um medidor das requisições em andamento."
- Abrir `observabilidade/prometheus.yml`
  - "Aqui falamos para o Prometheus de onde buscar as métricas, a cada 5 segundos."
- Abrir `servico-album/server.js`, nas funções `albumN1` e `albumJoin`
  - "Esse era o problema N+1, uma consulta para cada seleção, 50 no total. Trocamos por uma consulta só com JOIN."

### Nicolly (2 min), no navegador

- Aba do Prometheus targets
  - "Aqui o Prometheus mostra que está conseguindo ler os serviços, todos UP."
- Aba do Grafana, linha "Banco de dados", painel "Queries no banco por requisição"
  - Mostrar a queda de 50 para 1 (ver a seção "Como mostrar o N+1 ao vivo" no final)
  - "Quando trocamos para o JOIN, as consultas por requisição caíram de 50 para 1 e o tempo de resposta caiu junto."

---

## Parte 3: Rede, cache e servidor (3 min)

### Kayky (1 min e meio)

- Mostrar o terminal do `npm run micro` com a linha "subindo 2 workers"
  - "Não usamos o servidor de desenvolvimento. O gateway roda em 2 processos, parecido com o Gunicorn."
- Na aba do álbum, apertar F12, ir em Rede (Network) e recarregar a página
  - "A resposta chega comprimida com gzip. Caiu de 80 KB para 8 KB."
  - Mostrar os cabeçalhos `Cache-Control` e `X-Cache: HIT`

### Nicolly (1 min e meio), no Grafana, linha "Cache e rede"

- Painel "Taxa de cache hit"
  - "Quase todas as requisições pegam o álbum da memória, mais de 99%."
- Painel "Cache hit x miss por segundo"
  - "A linha amarela de miss aparece de vez em quando porque o cache expira a cada 60 segundos e busca de novo."

---

## Parte 4: Teste de carga e caos ao vivo (5 min)

### Nicolly (1 min e meio)

- No Locust: 100 usuários, 10 por segundo, clicar em Start
- Aba Charts
  - "Aqui o Locust simula 100 pessoas usando o sistema ao mesmo tempo."
- Aba Statistics, mostrar as colunas 95%ile e 99%ile
  - "O P95 é o tempo que 95% das requisições levaram. Está em volta de 100 ms."
- No Grafana, linha "Visão geral"
  - Mostrar requisições por segundo, latência e erro em 0%

### Kayky (1 min)

- Abrir `gateway/resiliencia.js`
  - "Aqui está o circuit breaker. Se metade das chamadas der erro, ele abre e para de chamar o serviço por 10 segundos. Enquanto isso o gateway responde com a última resposta boa que guardou."
- No terminal livre:
  ```
  npm run caos -- ligar trocas
  ```
  - "Agora vamos derrubar o serviço de trocas de propósito."

### Nicolly (1 min e meio), no Grafana, linha "Resiliencia e caos"

- Painel "Estado do circuit breaker"
  - "O trocas ficou vermelho, o circuito abriu."
- Painel "Fallbacks e retries por segundo"
  - "Essa linha verde são as respostas que o gateway deu sozinho enquanto o serviço estava fora."
- Painel "Respostas do gateway por status"
  - "A maior parte continua dando certo. Só as ações de escrita, como abrir pacotinho, dão erro."

### Kayky (1 min)

- No terminal:
  ```
  curl.exe -i http://localhost:3000/colecionadores/5
  ```
  - Mostrar a linha `X-Fallback: copia_antiga`
  - "Essa resposta veio do fallback."
- Desligar a falha:
  ```
  npm run caos -- desligar trocas
  ```
  - "Desligamos a falha, e em uns 10 segundos o circuito fecha sozinho."
- Nicolly mostra o painel do circuit breaker voltando para verde

---

## Parte 5: Conclusão (2 min)

**Mostrar:** a tabela "Antes e depois" do relatório

### Kayky

- "O P95 caiu de 2600 ms para 110 ms."
- "Sem as proteções, 78% das requisições deram erro com o serviço fora. Com elas, só 16%."

### Nicolly

- "O que a gente aprendeu é que medir antes de mudar ajuda muito. Só separar em microsserviços não deixou mais rápido. O problema estava no banco."
- "E o teste de caos achou um erro nosso que não aparecia nos testes normais."

---

## Como mostrar o N+1 ao vivo (Parte 2)

Com o cache ligado quase nada chega no serviço de álbum e o gráfico fica vazio. Por isso grava essa parte separada:

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
5. Começar a gravar e trocar para o JOIN:
   ```
   curl.exe -X POST http://localhost:4001/admin/modo/join
   curl.exe -X POST http://localhost:4011/admin/modo/join
   ```
6. No Grafana escolher App = album e mostrar a queda no gráfico
7. Depois parar tudo, **fechar esse terminal**, abrir um novo e rodar `npm run micro` normal

O `$env:CACHE="off"` só vale naquele terminal, por isso tem que abrir um novo no passo 7, senão o cache continua desligado.

Se ficar complicado, dá para mostrar a Figura 3 do relatório nessa parte em vez de fazer ao vivo.
