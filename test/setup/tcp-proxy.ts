import type { Socket, TCPSocketListener } from 'bun';

/**
 * Minimal TCP proxy in front of PostgreSQL. `stop()` closes the listener and kills every
 * open connection — a real network outage for the application under test, not a mock.
 */
export class TcpProxy {
  private listener:
    | TCPSocketListener<{ upstream?: Socket<{ peer: Socket<unknown> }>; buffer: Uint8Array[] }>
    | undefined;
  private readonly sockets = new Set<Socket<unknown>>();
  port = 0;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  async start(port = 0): Promise<number> {
    const self = this;
    this.listener = Bun.listen<{ upstream?: Socket<{ peer: Socket<unknown> }>; buffer: Uint8Array[] }>({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(client) {
          client.data = { buffer: [] };
          self.sockets.add(client as Socket<unknown>);
          Bun.connect<{ peer: Socket<unknown> }>({
            hostname: self.targetHost,
            port: self.targetPort,
            socket: {
              open(up) {
                up.data = { peer: client as Socket<unknown> };
                self.sockets.add(up as Socket<unknown>);
                client.data.upstream = up;
                for (const chunk of client.data.buffer) up.write(chunk);
                client.data.buffer = [];
              },
              data(up, chunk) {
                up.data.peer.write(chunk);
              },
              close(up) {
                self.sockets.delete(up as Socket<unknown>);
                up.data?.peer.end();
              },
              error(up) {
                up.data?.peer.end();
              },
            },
          }).catch(() => client.end());
        },
        data(client, chunk) {
          if (client.data.upstream) client.data.upstream.write(chunk);
          else client.data.buffer.push(new Uint8Array(chunk));
        },
        close(client) {
          self.sockets.delete(client as Socket<unknown>);
          client.data.upstream?.end();
        },
        error(client) {
          client.data.upstream?.end();
        },
      },
    });
    this.port = this.listener.port;
    return this.port;
  }

  /** Simulates the database going away: refuse new connections and drop existing ones. */
  stop(): void {
    this.listener?.stop(true);
    this.listener = undefined;
    for (const s of this.sockets) s.terminate();
    this.sockets.clear();
  }

  async restart(): Promise<void> {
    await this.start(this.port);
  }
}
