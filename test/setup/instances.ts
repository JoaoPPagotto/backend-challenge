import type { Subprocess } from 'bun';
import type { QueueSet } from '../../scripts/init-sqs';
import { SQS_ENDPOINT } from './test-sqs';

export interface InstanceOptions {
  databaseUrl: string;
  queues: QueueSet;
  env?: Record<string, string>;
}

/** A real application process (`bun src/main.ts`) with its own port. */
export class AppInstance {
  proc: Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  readonly logs: string[] = [];
  exitCode: number | null = null;

  constructor(
    readonly id: string,
    readonly port: number,
    private readonly opts: InstanceOptions,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(extraEnv: Record<string, string> = {}): Promise<void> {
    this.exitCode = null;
    this.proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: `${import.meta.dir}/../..`,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(this.port),
        INSTANCE_ID: this.id,
        LOG_LEVEL: 'info',
        DATABASE_URL: this.opts.databaseUrl,
        DB_POOL_MAX: '10',
        AWS_ENDPOINT_URL: SQS_ENDPOINT,
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        SQS_WAGER_QUEUE_URL: this.opts.queues.wagerQueueUrl,
        SQS_WAGER_DLQ_URL: this.opts.queues.dlqUrl,
        SQS_EVENTS_QUEUE_URL: this.opts.queues.eventsQueueUrl,
        SQS_WAIT_TIME_SECONDS: '1',
        SQS_VISIBILITY_TIMEOUT_SECONDS: '3',
        OUTBOX_POLL_MS: '100',
        PENDING_REF_POLL_MS: '100',
        PENDING_REF_BASE_DELAY_MS: '50',
        PENDING_REF_MAX_DELAY_MS: '200',
        SHUTDOWN_TIMEOUT_MS: '5000',
        ...this.opts.env,
        ...extraEnv,
      },
    });
    const proc = this.proc;
    void this.collect(proc.stdout);
    void this.collect(proc.stderr);
    void proc.exited.then((code) => {
      this.exitCode = code;
    });
    await this.waitReady();
  }

  private async collect(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        this.logs.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    }
  }

  async waitReady(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exitCode !== null)
        throw new Error(`${this.id} exited with ${this.exitCode}:\n${this.logs.slice(-20).join('\n')}`);
      try {
        const res = await fetch(`${this.url}/health/ready`);
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await Bun.sleep(100);
    }
    throw new Error(`${this.id} not ready:\n${this.logs.slice(-20).join('\n')}`);
  }

  /** SIGKILL: the process dies without any cleanup (crash). */
  async kill(): Promise<void> {
    if (!this.proc || this.exitCode !== null) return;
    this.proc.kill('SIGKILL');
    await this.proc.exited;
  }

  /** SIGTERM: graceful shutdown. */
  async terminate(): Promise<number> {
    if (!this.proc || this.exitCode !== null) return this.exitCode ?? 0;
    this.proc.kill('SIGTERM');
    return this.proc.exited;
  }

  async waitExit(timeoutMs = 30_000): Promise<number | null> {
    if (!this.proc) return null;
    return Promise.race([this.proc.exited, Bun.sleep(timeoutMs).then(() => null)]);
  }
}

/** Asks the OS for a free port (bind to 0, read it, release it). */
export function freePort(): number {
  const server = Bun.listen({ hostname: '0.0.0.0', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

export async function startInstances(
  n: number,
  opts: InstanceOptions,
  prefix = 'app',
): Promise<AppInstance[]> {
  const instances = Array.from(
    { length: n },
    (_, i) => new AppInstance(`${prefix}-${i + 1}`, freePort(), opts),
  );
  await Promise.all(instances.map((i) => i.start()));
  return instances;
}

export async function stopAll(instances: AppInstance[]): Promise<void> {
  await Promise.all(instances.map((i) => i.terminate().catch(() => i.kill())));
}

// ---------------------------------------------------------------- HTTP helpers

export interface HttpResult<T = Record<string, unknown>> {
  status: number;
  body: T;
  instance: string | null;
}

export async function http<T = Record<string, unknown>>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-JSON (metrics)
  }
  return { status: res.status, body: parsed as T, instance: res.headers.get('x-instance-id') };
}

export async function openWallet(baseUrl: string, amount: string, currency = 'BRL') {
  const playerId = crypto.randomUUID();
  const res = await http<{ id: string }>(baseUrl, 'POST', '/wallets', {
    playerId,
    initialBalance: { amount, currency },
  });
  if (res.status !== 201) throw new Error(`open wallet failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id, playerId };
}

export async function waitFor(
  check: () => Promise<boolean>,
  { timeoutMs = 20_000, intervalMs = 100, what = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
