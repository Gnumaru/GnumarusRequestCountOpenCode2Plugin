# OpenCode Request Count

Plugin para o **OpenCode 2** que conta e exibe, de forma permanente no terminal
(TUI), quantas requisições a sessão atual fez ao servidor de LLM.

```
req 12 (7+5) · ok 10 · err 2 · msg 3
```

| campo   | significado                                                                   |
| ------- | ----------------------------------------------------------------------------- |
| `req`   | total absoluto de requisições ao servidor de LLM                             |
| `(7+5)` | `7` requisições da execução atual + `5` do histórico (execuções anteriores)   |
| `ok`    | requisições que retornaram sucesso                                           |
| `err`   | requisições que retornaram qualquer tipo de erro                             |
| `msg`   | mensagens digitadas pelo usuário                                              |

## O que é contado

O plugin se registra nos hooks de sessão do OpenCode e conta:

- **Mensagens do usuário** (`msg`): hook `prompt`, que roda uma vez na admissão
  de cada prompt. Mensagens sintéticas, de shell ou comandos internos do harness
  não contam.
- **Requisições ao LLM** (`req`): hook `http.request`, que roda uma vez por
  requisição HTTP real ao provedor. Isso inclui as requisições "transparentes"
  do harness: geração de título, compactação, continuações do loop do agente
  depois de tool calls e re-tentativas após erro.
- **Sucesso** (`ok`): hook `http.response` com status HTTP < 400.
- **Erro** (`err`): status HTTP >= 400, erro de conexão/rede (hook `retry`) ou
  stream que falhou depois de uma resposta 2xx.

Por ser contado no nível HTTP, o número corresponde ao que o provedor de LLM
realmente recebeu — inclusive as re-tentativas, que normalmente não aparecem em
nenhuma outra métrica.

## Histórico x execução atual

Os contadores são gravados em disco (no armazenamento do próprio plugin, com
uma chave por projeto) e cada requisição guarda em qual processo do servidor
foi contada.

- Reiniciar o **OpenCode** (ou a máquina) e retomar a sessão: o que foi contado
  antes passa a ser **histórico** e o que for feito agora é a **execução atual**.
- Sem reiniciar, tudo continua somando na execução atual.

O `(7+5)` no rodapé só aparece quando existe histórico.

## Instalação

O plugin tem duas partes: o **servidor** (que conta) e o **TUI** (que exibe).
As duas ficam no mesmo pacote e o OpenCode carrega as duas automaticamente.

### Global (todos os projetos)

```sh
ln -s "$(pwd)/request-count" ~/.config/opencode/plugins/request-count
```

### Só em um projeto

```sh
mkdir -p .opencode/plugins
ln -s "$(pwd)/request-count" .opencode/plugins/request-count
```

Depois é só reiniciar o OpenCode (`opencode service restart`).

## Comandos

| comando              | o que faz                                                     |
| -------------------- | -------------------------------------------------------------- |
| `/request-count`     | abre um diálogo com o detalhamento (absoluto, atual, histórico) |
| `/request-count-reset` | zera os contadores da sessão atual                            |

## Arquivos

```
request-count/
├── index.ts    # plugin de servidor: hooks de sessão + persistência
├── rpc.ts      # contrato RPC (stats / reset) compartilhado com o TUI
├── tui.tsx     # plugin de TUI: rodapé e comandos
└── package.json
```

## Notas de implementação

- O OpenCode carrega o plugin **uma vez por location** (diretório de trabalho),
  e cada instância registra os seus hooks — por isso uma requisição nunca é
  contada duas vezes. O armazenamento é separado por projeto e cada instância
  grava apenas as sessões que ela tocou.
- A RPC é registrada por location, então o TUI sempre envia o diretório da
  sessão ao consultar os contadores.
- O TUI lê o store dentro de uma expressão JSX: é lá que o Solid cria o efeito
  que reage às mudanças dos contadores.
