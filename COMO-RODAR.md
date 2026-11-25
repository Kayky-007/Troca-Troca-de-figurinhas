# Como rodar o projeto

Passo a passo pra rodar o Troca-Troca num computador novo com Windows. Leva uns 20 a 30 minutos, a maior parte é esperando instalar.

## 1. Instalar os programas (só na primeira vez)

| Programa | Onde baixar | Atenção |
|---|---|---|
| Git | git-scm.com | pode instalar com as opções padrão |
| Docker Desktop | docker.com/products/docker-desktop | pede pra reiniciar o PC e as vezes pede pra instalar o WSL, é só aceitar |
| Node.js 22 ou mais novo | nodejs.org (versão LTS) | opções padrão |
| Python 3 | python.org | marcar a opção **Add Python to PATH** na primeira tela |

Depois de instalar, abre o **Docker Desktop** e espera aparecer "Engine running". Sem ele aberto nada funciona.

## 2. Baixar o projeto e instalar as dependências

No PowerShell ou no terminal do VS Code:

```
git clone https://github.com/Kayky-007/Troca-Troca-de-figurinhas.git
cd Troca-Troca-de-figurinhas
npm install
python -m pip install locust==2.47.0
```

## 3. Subir o banco, o Prometheus e o Grafana

```
docker compose up -d
```

Na primeira vez demora alguns minutos pra baixar tudo. O MySQL ainda leva uns 30 segundos a mais pra criar as tabelas e colocar os dados, não precisa importar nada.

## 4. Rodar o sistema

```
npm run micro
```

Deixa esse terminal aberto.

**Importante:** na primeira vez o Windows Firewall vai perguntar se pode liberar o Node. Tem que clicar em **Permitir**. Se não liberar, o Prometheus não consegue ler as métricas e o Grafana fica vazio.

## 5. Ver se está tudo funcionando

- http://localhost:3000/album tem que mostrar o álbum em JSON
- http://localhost:9090/targets os alvos gateway, album e trocas tem que estar **UP** (o monolito fica DOWN, é normal, ele só roda com `npm run monolito`)
- http://localhost:3030 é o Grafana, login `admin` e senha `admin`. O painel fica em Dashboards, pasta Figurinhas

## 6. Teste de carga

Em outro terminal:

```
python -m locust -f carga/locustfile.py --host http://localhost:3000
```

Abre http://localhost:8089, coloca 100 usuários, 10 por segundo, e clica em Start.

## 7. Teste de caos

Com o Locust rodando, em mais um terminal:

```
npm run caos -- ligar trocas
```

No Grafana, na parte "Resiliencia e caos", o circuito do trocas fica vermelho. Pra voltar ao normal:

```
npm run caos -- desligar trocas
```

Pra ver como está: `npm run caos -- status`

## Pra parar tudo

- `Ctrl + C` no terminal do `npm run micro` e do Locust
- `docker compose down` pra desligar o banco, o Prometheus e o Grafana (os dados continuam salvos)

## Se der problema

| Problema | O que fazer |
|---|---|
| Erro falando que não conecta no Docker | o Docker Desktop não está aberto |
| Erro de porta em uso | algum programa já usa a porta 3307, 9090 ou 3030 (por exemplo um MySQL instalado). Fecha ele |
| Grafana sem dados | olha a página de targets do Prometheus. Se estiver DOWN, é o firewall do passo 4 |
| Circuito abrindo sozinho logo no começo | o banco ainda está frio. Roda o Locust 1 minuto antes de gravar |
| `python` não é reconhecido | troca `python` por `py` nos comandos |
| Aparece `ValueError: I/O operation on closed file` no fim do Locust | pode ignorar, é um bug do próprio Locust |

## Onde está cada parte no código

No final do [README](README.md) tem a tabela "Onde esta cada requisito da atividade" com o arquivo de cada parte.
