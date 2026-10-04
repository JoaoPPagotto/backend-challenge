# Resultados do teste de carga

Gerado com `bun run test:load` (script em `scripts/load-test.ts`). O script reescreve este arquivo a cada execução; os números abaixo são da execução registrada durante o desenvolvimento, com a análise escrita à mão.

## Ambiente

| | |
|---|---|
| Máquina | VM de desenvolvimento, **2 vCPUs** (Intel Xeon @ 2.80GHz), 8 GB RAM |
| Runtime | Bun 1.4.2 |
| Banco | PostgreSQL 16 local (mesma VM) |
| SQS | emulador SQS compatível (moto server, Python, mesma VM) — o mesmo papel do LocalStack |
| Instâncias | 3 processos `bun src/main.ts` (todos com consumidor SQS, publisher da outbox e worker de referências) |
| Gerador de carga | mesma VM |

Tudo divide as mesmas 2 vCPUs: 3 instâncias, PostgreSQL, emulador SQS e o próprio gerador. Isso domina os resultados e precisa ser lido junto com eles.

## Metodologia

Usuários virtuais em laço fechado, durante a janela de tempo, sobre N wallets com saldo alto. 5 wallets "quentes" recebem 20% do tráfego (contenção de lock proposital). Mistura: BET 55%, WIN 20%, LOSS 10%, ROLLBACK de uma BET anterior 5% e **replay deliberado** de uma requisição já enviada 10%. Latência medida no cliente (ida e volta HTTP). Contadores (conflitos de lock, replays, outbox) são deltas do `/metrics` das instâncias.

## Resultados

| Cenário | Requisições | Throughput | p50 | p95 | p99 | Erros 5xx |
|---|---|---|---|---|---|---|
| A. 1 cliente, 1 instância, workers de fila desligados (latência base) | 538 | 67 req/s | 14,5 ms | 27,1 ms | 35,8 ms | 0 |
| B. 48 VUs, 3 instâncias, workers de fila desligados (só HTTP → Postgres) | 2.406 | 119 req/s | 298 ms | 1.156 ms | 2.243 ms | 0 |
| C. 32 VUs, 3 instâncias, stack completa (consumidor + outbox + worker) | 2.080 | 69 req/s | 349 ms | 1.236 ms | 1.933 ms | 0 |

Detalhes da execução C:

| Métrica | Valor |
|---|---|
| Códigos HTTP | 200: 2.080 (nenhum 4xx/5xx inesperado) |
| Conflitos de concorrência (`wallet_lock_conflicts_total`) | 0 |
| Replays idempotentes servidos | 175 |
| Eventos publicados pela outbox durante a janela | 222 |
| Lag médio da outbox | 16,7 s |
| Outbox pendente ao fim da janela | 8.167 (drenou a ~240 eventos/s após o fim da carga) |

## Análise

**Correção sob carga.** Em todas as execuções: zero respostas 5xx, zero 4xx inesperados, todos os replays devolveram o resultado original, e a invariante `saldo == ledger` foi mantida (verificada pela suíte de concorrência, que roda os mesmos caminhos). Não houve conflito de versão: com lock pessimista por wallet, a contenção nas wallets quentes vira **espera** na fila do lock (limitada pelo `lock_timeout`), não retry.

**O teto é CPU, não o desenho.** A latência base é ~15 ms para ~10 round trips SQL por transação. Com 48 clientes em 2 vCPUs compartilhadas por tudo, o tempo extra é fila de CPU: o throughput do cenário B (~120 req/s) é praticamente o que 2 vCPUs entregam para 3 runtimes JS + Postgres + gerador. O lock por wallet não aparece como gargalo (wallets diferentes rodam em paralelo; as quentes serializam como esperado).

**A outbox é o ponto fraco neste ambiente.** No cenário C o emulador SQS (Python, single-process) consome ~65% de uma vCPU só com long polling e `SendMessageBatch`, e os publishers ficam sem CPU enquanto a carga dura: o lag médio chega a ~17 s e a fila de pendentes cresce. Quando a carga para, a outbox drena a ~240 eventos/s. Nenhum evento é perdido (o teste 6 da suíte de concorrência confere que todo `eventId` commitado aparece na fila), mas o lag mostra que, nesse hardware, o publisher precisaria de prioridade ou de uma instância dedicada.

**O que eu mudaria para produção:** separar o publisher da outbox em um processo próprio (ou dar a ele CPU reservada), publicar lotes em paralelo por `MessageGroupId`, usar `LISTEN/NOTIFY` para acordar o publisher em vez de polling, e medir em hardware dedicado, com o SQS real (ou LocalStack em outra máquina) e o gerador de carga fora das máquinas da aplicação. Os números absolutos daqui **não** devem ser lidos como capacidade do serviço.

## Como reproduzir

```bash
docker compose up -d --build --wait          # 3 instâncias atrás do nginx em :3000
bun run test:load                            # padrão: 30 s, 64 VUs, 200 wallets
TARGETS=http://localhost:3001,http://localhost:3002,http://localhost:3003 \
  DURATION_S=60 CONCURRENCY=32 WALLETS=100 bun run test:load
```
