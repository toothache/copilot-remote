/**
 * MonitorServer — lightweight TCP server attached to a PtySpawn instance.
 * Streams ring buffer contents and live output to connected monitor clients.
 *
 * Protocol: newline-delimited JSON messages.
 *   Server → Client:
 *     { "type": "hello", "name": "...", "command": "...", "pid": N, "bufferSize": N, "port": N }
 *     { "type": "output", "line": "..." }
 *     { "type": "state", "state": "running|exited", "exitCode?": N }
 *     { "type": "ring", "lines": ["..."] }    (sent on connect, initial dump)
 *   Client → Server:
 *     { "type": "get_ring", "n": N }           (request last N lines)
 */

import { createServer, type Server, type Socket } from 'node:net';
import type { PtySpawn } from './pty-spawn.js';

export interface MonitorServerOptions {
  ptySpawn: PtySpawn;
  name: string;
  command: string;
  port?: number;
}

export class MonitorServer {
  private server: Server;
  private clients = new Set<Socket>();
  private ptySpawn: PtySpawn;
  private name: string;
  private command: string;
  private state: 'running' | 'exited' = 'running';
  private exitCode?: number;
  private actualPort = 0;
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  private lastViewportSnapshot = '';

  constructor(opts: MonitorServerOptions) {
    this.ptySpawn = opts.ptySpawn;
    this.name = opts.name;
    this.command = opts.command;

    this.server = createServer((socket) => this.onConnect(socket));

    // Periodically send viewport snapshots to clients (clean, resolved text)
    // instead of streaming raw ANSI which contains cursor movement noise
    this.ptySpawn.on('data', () => {
      // Debounce: only send after data settles (50ms)
      if (this.outputTimer) clearTimeout(this.outputTimer);
      this.outputTimer = setTimeout(() => this.sendViewportUpdate(), 50);
    });

    this.ptySpawn.on('exit', ({ exitCode }: { exitCode: number }) => {
      this.state = 'exited';
      this.exitCode = exitCode;
      this.broadcast({ type: 'state', state: 'exited', exitCode });
    });
  }

  async start(port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server.address();
        this.actualPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(this.actualPort);
      });
    });
  }

  stop(): void {
    if (this.outputTimer) clearTimeout(this.outputTimer);
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.server.close();
  }

  get port(): number {
    return this.actualPort;
  }

  private sendViewportUpdate(): void {
    const viewport = this.ptySpawn.getViewport();
    const snapshot = viewport.join('\n');
    // Only send if viewport actually changed
    if (snapshot === this.lastViewportSnapshot) return;
    this.lastViewportSnapshot = snapshot;

    const lines = viewport.filter(l => l.length > 0);
    if (lines.length > 0) {
      this.broadcast({ type: 'viewport', lines });
    }
  }

  private onConnect(socket: Socket): void {
    this.clients.add(socket);

    // Send hello + initial ring buffer dump
    this.send(socket, {
      type: 'hello',
      name: this.name,
      command: this.command,
      pid: this.ptySpawn.pid,
      bufferSize: this.ptySpawn.getLines().length,
      port: this.actualPort,
    });

    this.send(socket, {
      type: 'state',
      state: this.state,
      ...(this.exitCode !== undefined && { exitCode: this.exitCode }),
    });

    // Send recent ring buffer
    const lines = this.ptySpawn.getLines(50);
    this.send(socket, { type: 'ring', lines });

    // Handle client requests
    let buf = '';
    socket.on('data', (data) => {
      buf += data.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        if (!part.trim()) continue;
        try {
          const msg = JSON.parse(part);
          this.handleClientMessage(socket, msg);
        } catch { /* ignore malformed */ }
      }
    });

    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  }

  private handleClientMessage(socket: Socket, msg: { type: string; n?: number }): void {
    if (msg.type === 'get_ring') {
      const lines = this.ptySpawn.getLines(msg.n ?? 50);
      this.send(socket, { type: 'ring', lines });
    }
  }

  private send(socket: Socket, msg: object): void {
    try {
      socket.write(JSON.stringify(msg) + '\n');
    } catch { /* client gone */ }
  }

  private broadcast(msg: object): void {
    const line = JSON.stringify(msg) + '\n';
    for (const client of this.clients) {
      try {
        client.write(line);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
