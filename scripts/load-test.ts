/**
 * Load test (optional differential). Usage:
 *   bun run test:load                                  # against nginx on :3000 (docker compose)
 *   TARGETS=http://localhost:3001,http://localhost:3002,http://localhost:3003 DURATION_S=30 CONCURRENCY=64 bun run test:load
 *
 * Workload: WALLETS wallets; each virtual user loops picking a random wallet and sends a mix
 * of BET (55%), WIN (20%), LOSS (10%), ROLLBACK of an earlier own BET (5%) and deliberate
 * replays of an already-sent request (10%). A few wallets are "hot" (HOT_SHARE of traffic)
 * to exercise lock contention. Results are printed and written to docs/load-test-results.md.
 */
import { cpus, totalmem } from 'node:os';

const TARGETS = (process.env.TARGETS ?? 'http://localhost:3000').split(',').map((s) => s.trim());
const DURATION_S = Number(process.env.DURATION_S ?? 30);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 64);
const WALLETS = Number(process.env.WALLETS ?? 200);
const HOT_WALLETS = Number(process.env.HOT_WALLETS ?? 5);
const HOT_SHARE = Number(process.env.HOT_SHARE ?? 0.2);
const OUTPUT = process.env.OUTPUT ?? 'docs/load-test-results.md';

type Kind = 'BET' | 'WIN' | 'LOSS' | 'ROLLBACK' | 'REPLAY';
interface Sample {
  kind: Kind;
  status: number;
  ms: number;
}
interface SentBody {
  body: Record<string, unknown>;
  key: string;
}

let rr = 0;
const target = () => TARGETS[rr++ % TARGETS.length] as string;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const started = performance.now();
  const res = await fetch(`${target()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json, ms: performance.now() - started };
}

async function scrape(): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  const urls = new Set(TARGETS);
  for (const url of urls) {
    const text = await fetch(`${url}/metrics`)
      .then((r) => r.text())
      .catch(() => '');
    for (const line of text.split('\n')) {
      if (line.startsWith('#') || !line.trim()) continue;
      const m = line.match(/^([a-z_]+)(\{[^}]*\})?\s+([0-9.eE+-]+)$/);
      if (!m) continue;
      const [, name, labels = '', value] = m;
      const key = `${name}${labels}`;
      totals[key] = (totals[key] ?? 0) + Number(value);
    }
  }
  return totals;
}

const sum = (m: Record<string, number>, prefix: string) =>
  Object.entries(m)
    .filter(([k]) => k.startsWith(prefix))
    .reduce((a, [, v]) => a + v, 0);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

async function main() {
  console.log(`Opening ${WALLETS} wallets on ${TARGETS.join(', ')} …`);
  const wallets: { walletId: string; playerId: string; bets: SentBody[]; sent: SentBody[] }[] = [];
  for (let i = 0; i < WALLETS; i++) {
    const playerId = crypto.randomUUID();
    const r = await post('/wallets', { playerId, initialBalance: { amount: '100000.00', currency: 'BRL' } });
    if (r.status !== 201) throw new Error(`wallet creation failed: ${r.status} ${JSON.stringify(r.json)}`);
    wallets.push({ walletId: String(r.json.id), playerId, bets: [], sent: [] });
  }
  const before = await scrape();
  const samples: Sample[] = [];
  const deadline = Date.now() + DURATION_S * 1000;
  let seq = 0;

  async function vu(id: number) {
    while (Date.now() < deadline) {
      const hot = Math.random() < HOT_SHARE;
      const w = wallets[hot ? Math.floor(Math.random() * HOT_WALLETS) : Math.floor(Math.random() * WALLETS)];
      if (!w) continue;
      const dice = Math.random();
      let kind: Kind =
        dice < 0.55 ? 'BET' : dice < 0.75 ? 'WIN' : dice < 0.85 ? 'LOSS' : dice < 0.9 ? 'ROLLBACK' : 'REPLAY';
      let req: SentBody | undefined;
      if (kind === 'REPLAY') req = w.sent[Math.floor(Math.random() * w.sent.length)];
      if (kind === 'ROLLBACK') {
        const ref = w.bets.pop();
        if (!ref) kind = 'BET';
        else {
          seq += 1;
          const ext = `lt-${id}-${seq}`;
          req = {
            key: `load:${ext}`,
            body: {
              ...ref.body,
              externalTransactionId: ext,
              kind: 'ROLLBACK',
              referenceExternalTransactionId: ref.body.externalTransactionId,
            },
          };
        }
      }
      if (!req) {
        if (kind === 'REPLAY') kind = 'BET';
        seq += 1;
        const ext = `lt-${id}-${seq}`;
        req = {
          key: `load:${ext}`,
          body: {
            providerId: 'load',
            externalTransactionId: ext,
            playerId: w.playerId,
            walletId: w.walletId,
            roundId: `round-${seq}`,
            gameId: 'load-test',
            kind,
            money: { amount: (1 + Math.floor(Math.random() * 500) / 100).toFixed(2), currency: 'BRL' },
          },
        };
      }
      try {
        const r = await post('/wagering/transactions', req.body, { 'Idempotency-Key': req.key });
        samples.push({ kind, status: r.status, ms: r.ms });
        if (kind !== 'REPLAY') w.sent.push(req);
        if (kind === 'BET' && r.status === 200) w.bets.push(req);
      } catch {
        samples.push({ kind, status: 0, ms: 0 });
      }
    }
  }

  console.log(`Running ${DURATION_S}s with ${CONCURRENCY} virtual users …`);
  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => vu(i)));
  const elapsed = (performance.now() - started) / 1000;
  await Bun.sleep(1500); // let the outbox drain before reading lag
  const after = await scrape();

  const lat = samples
    .filter((s) => s.status > 0)
    .map((s) => s.ms)
    .sort((a, b) => a - b);
  const byStatus = new Map<number, number>();
  for (const s of samples) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  const errors5xx = samples.filter((s) => s.status >= 500 || s.status === 0).length;
  const unexpected4xx = samples.filter((s) => s.status >= 400 && s.status < 500 && s.status !== 422).length;
  const delta = (prefix: string) => sum(after, prefix) - sum(before, prefix);
  const lagCount = delta('outbox_lag_seconds_count');
  const lagSum = delta('outbox_lag_seconds_sum');

  const result = {
    environment: {
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      bun: Bun.version,
      targets: TARGETS,
    },
    parameters: {
      durationS: DURATION_S,
      concurrency: CONCURRENCY,
      wallets: WALLETS,
      hotWallets: HOT_WALLETS,
      hotShare: HOT_SHARE,
    },
    requests: samples.length,
    throughputRps: Math.round(samples.length / elapsed),
    latencyMs: {
      p50: Number(percentile(lat, 50).toFixed(1)),
      p95: Number(percentile(lat, 95).toFixed(1)),
      p99: Number(percentile(lat, 99).toFixed(1)),
      max: Number((lat.at(-1) ?? 0).toFixed(1)),
    },
    statusCodes: Object.fromEntries([...byStatus.entries()].sort()),
    errorRate5xx: Number((errors5xx / Math.max(1, samples.length)).toFixed(4)),
    unexpected4xx,
    lockConflicts: delta('wallet_lock_conflicts_total'),
    idempotentReplays: delta('idempotent_replays_total'),
    outboxPublished: delta('outbox_published_total'),
    outboxLagAvgSeconds: lagCount > 0 ? Number((lagSum / lagCount).toFixed(3)) : null,
    outboxPendingAtEnd: sum(after, 'outbox_pending'),
  };
  console.log(JSON.stringify(result, null, 2));

  const md = `# Load test results

Generated by \`bun run test:load\` on ${new Date().toISOString()}.

## Environment

| | |
|---|---|
| CPUs | ${result.environment.cpus} × ${result.environment.cpuModel} |
| Memory | ${result.environment.memoryGb} GB |
| Bun | ${result.environment.bun} |
| Targets | ${TARGETS.join(', ')} |

## Methodology

${CONCURRENCY} virtual users for ${DURATION_S}s over ${WALLETS} wallets (${HOT_WALLETS} "hot" wallets receive ${Math.round(HOT_SHARE * 100)}% of the traffic).
Mix: BET 55%, WIN 20%, LOSS 10%, ROLLBACK of an earlier BET 5%, deliberate replay of an earlier request 10%.
Latency is client-side round trip. Counters are deltas of the instances' \`/metrics\`.

## Results

| Metric | Value |
|---|---|
| Requests | ${result.requests} |
| Throughput | ${result.throughputRps} req/s |
| p50 / p95 / p99 / max | ${result.latencyMs.p50} / ${result.latencyMs.p95} / ${result.latencyMs.p99} / ${result.latencyMs.max} ms |
| Status codes | ${Object.entries(result.statusCodes)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')} |
| 5xx / transport error rate | ${(result.errorRate5xx * 100).toFixed(2)}% |
| Unexpected 4xx (excl. 422) | ${result.unexpected4xx} |
| Lock conflicts (retried in-process) | ${result.lockConflicts} |
| Idempotent replays served | ${result.idempotentReplays} |
| Outbox events published | ${result.outboxPublished} |
| Avg outbox lag | ${result.outboxLagAvgSeconds ?? 'n/a'} s |
| Outbox pending at end | ${result.outboxPendingAtEnd} |

\`\`\`json
${JSON.stringify(result, null, 2)}
\`\`\`
`;
  await Bun.write(OUTPUT, md);
  console.log(`Written to ${OUTPUT}`);
}

await main();
