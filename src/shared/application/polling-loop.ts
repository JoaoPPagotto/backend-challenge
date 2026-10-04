import type { AppLogger } from './ports/observability.port';

/**
 * Self-rescheduling loop: runs `tick`, then waits `intervalMs` — or runs again right away
 * when the tick reported a full batch. `stop()` resolves after the in-flight tick ends.
 */
export class PollingLoop {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Promise<void> | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.current = this.runTick();
    }, delay);
  }

  private async runTick(): Promise<void> {
    let again = false;
    try {
      again = await this.tick();
    } catch (error) {
      this.logger.warn(`${this.name} tick failed`, { err: String(error) });
    }
    this.schedule(again ? 0 : this.intervalMs);
  }
}
