# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) vindas de múltiplos provedores, por **HTTP** e por **SQS FIFO**, com entrega *at-least-once*. Continua correto com mensagens duplicadas, fora de ordem e simultâneas, rodando em várias instâncias.

Stack: **Bun 1.x · TypeScript estrito · NestJS (Fastify) · PostgreSQL 16 · MikroORM 6 · AWS SQS (LocalStack) · Docker Compose**.

O enunciado original está em [`docs/CHALLENGE.md`](docs/CHALLENGE.md). As decisões técnicas, trade-offs e limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Pré-requisitos

- [Bun](https://bun.sh) ≥ 1.2
- Docker + Docker Compose v2

```bash
bun install
cp .env.example .env      # só necessário para rodar a app fora do Docker
```

## Subir tudo (3 instâncias + infraestrutura)

```bash
docker compose up -d --build --wait
```

Isso sobe PostgreSQL, LocalStack (SQS), cria as filas FIFO (`init-sqs`), aplica as migrations (`migrate`), três instâncias da aplicação (`app-1..3` nas portas `3001-3003`) e um nginx em **`:3000`** fazendo round-robin entre elas. A resposta HTTP traz o header `X-Instance-Id` com a instância que atendeu.

```bash
docker compose ps
docker compose logs -f app-1 app-2 app-3     # logs JSON estruturados
docker compose down -v                       # derruba tudo e apaga o volume do banco
```

### Rodar a aplicação fora do Docker

```bash
docker compose up -d --wait postgres localstack init-sqs
bun run migration:up
bun run dev              # ou: bun start
```

## API

Todos os valores monetários são **strings decimais com 2 casas** (`"25.00"`), nunca números JSON.

### Criar wallet

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'
# 201 {"id":"…","playerId":"…","balance":{"amount":"1000.00","currency":"BRL"},"version":1}
```

### Submeter transação

```bash
WALLET=<id da wallet>
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "'"$WALLET"'",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
# 200 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

Repetir a mesma requisição devolve o mesmo corpo com `"idempotentReplay": true`. A mesma `Idempotency-Key` com payload diferente devolve `409`. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.

| Situação | HTTP |
|---|---|
| Processada (inclui `LOSS`) ou replay | `200` |
| Aceita, aguardando a transação referenciada (`PENDING_REFERENCE`) | `202` |
| Payload inválido / header ausente / `OPENING` | `400` |
| Recurso inexistente | `404` |
| Conflito de idempotência / wallet duplicada | `409` |
| Rejeitada por regra de negócio (`failureCode` no corpo) | `422` |
| Falha transitória de infraestrutura (seguro reenviar) | `503` + `Retry-After` |

### Consultas e reconciliação

```bash
curl -s localhost:3000/wallets/$WALLET
curl -s "localhost:3000/wallets/$WALLET/ledger?limit=50"            # devolve nextCursor opaco
curl -s "localhost:3000/wallets/$WALLET/ledger?limit=50&cursor=<nextCursor>"
curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123
curl -s -X POST localhost:3000/wallets/$WALLET/reconciliation
```

### Via SQS

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" \
  --message-deduplication-id msg-123 \
  --message-body '{
    "messageId": "msg-123",
    "type": "WagerTransactionRequested",
    "occurredAt": "2026-07-29T15:00:00.000Z",
    "data": {
      "providerId": "provider-a", "externalTransactionId": "transaction-456",
      "idempotencyKey": "provider-a:transaction-456",
      "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "walletId": "'"$WALLET"'",
      "roundId": "round-987", "gameId": "fortune-chimp", "kind": "BET",
      "money": { "amount": "25.00", "currency": "BRL" }
    }
  }'

# eventos de integração publicados pela outbox
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wagering-events.fifo --max-number-of-messages 10
# mensagens rejeitadas de forma permanente
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo --message-attribute-names All
```

Se a sua versão do LocalStack usar outro formato de URL, descubra-a com `awslocal sqs get-queue-url --queue-name wager-transactions.fifo`. A aplicação resolve as URLs pelo nome na inicialização, então não depende desse formato.

### Operação

```bash
curl -s localhost:3000/health/live      # processo vivo
curl -s localhost:3000/health/ready     # PostgreSQL e SQS alcançáveis (503 se não)
curl -s localhost:3001/metrics          # Prometheus, por instância
```

Health e métricas não exigem autenticação. A autenticação foi deixada como ponto de extensão explícito (ver `ARCHITECTURE.md § Autenticação`).

## Testes

Os testes de integração e concorrência usam **PostgreSQL e SQS reais** (nada de mocks). Suba a infraestrutura de teste (PostgreSQL em `:5433`, LocalStack em `:4567`):

```bash
bun run infra:up
bun run test:unit           # domínio, use case com repositórios in-memory, arquitetura
bun run test:integration    # schema/constraints, fluxos, API HTTP, mensageria, atomicidade, queda do banco
bun run test:concurrency    # 3 processos reais da aplicação em paralelo (~3–4 min)
bun test                    # tudo
bun run infra:down
```

Cada arquivo de teste recebe um banco próprio clonado de um template migrado e filas com prefixo próprio, então os arquivos são isolados entre si. Para apontar para outra infraestrutura: `TEST_DATABASE_ADMIN_URL` (padrão `postgres://postgres:postgres@127.0.0.1:5433/postgres`) e `TEST_SQS_ENDPOINT` (padrão `http://localhost:4567`).

Toda suíte de integração e concorrência termina verificando a invariante `wallet.balance == saldo reconstruído pelo ledger` (além de versão sem buracos, nenhum lançamento duplicado e nenhum saldo negativo).

### Teste de carga

```bash
docker compose up -d --build --wait
bun run test:load                         # contra o nginx em :3000
TARGETS=http://localhost:3001,http://localhost:3002,http://localhost:3003 DURATION_S=60 CONCURRENCY=32 bun run test:load
```

Os resultados e a análise ficam em [`docs/load-test-results.md`](docs/load-test-results.md).

## Outros comandos

```bash
bun run typecheck           # tsc --noEmit (strict)
bun run lint                # biome check
bun run format
bun run migration:up        # aplica migrations (DATABASE_URL)
bun run migration:down      # reverte a última (use: bun scripts/migrate.ts down --all)
```

## Estrutura

```
src/
  shared/            Money, erros, FailureCode, IntegrationEvent, portas, infraestrutura comum (ORM, SQS, logs, métricas), HTTP
  wallet/            Wallet (aggregate), WalletLedgerEntry, use cases de wallet, controller
  wagering/          WagerTransaction, regras de negócio, use case central (HTTP + SQS), worker de referências, consumidor SQS
  inbox/  outbox/    InboxMessage / OutboxMessage e publicação da outbox
  health/            liveness, readiness, /metrics
  composition.ts     composition root independente de framework
migrations/          migrations versionadas e reversíveis (todas as garantias no schema)
scripts/             migrate.ts, init-sqs.ts, load-test.ts
test/                unit/, integration/, concurrency/, setup/
```
