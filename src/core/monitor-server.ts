/**
 * MonitorServer — lightweight TCP server attached to a PtySpawn instance.
 *
 * Design: pull-based with push notifications for important events.
 * Clients request data on demand; server only pushes state changes and exit.
 *
 * Protocol: newline-delimited JSON messages.
 *
 *   Server → Client (push — unsolicited):
 *     { "type": "hello", "name", "command", "pid", "port", "startedAt" }
 *     { "type": "push_state", "state": "running|exited", "exitCode?": N }
 *
 *   Client → Server (request):
 *     { "type": "get_viewport" }
 *     { "type": "get_logs", "n": N }
 *     { "type": "get_info" }
 *     { "type": "send_input", "data": "..." }
 *     { "type": "send_ctrl_c" }
 *
 *   Server → Client (response to request):
 *     { "type": "viewport", "lines": ["..."] }
 *     { "type": "logs", "lines": ["..."], "total": N }
 *     { "type": "info", "name", "command", "pid", "state", "port", "startedAt", "logSize" }
 *     { "type": "ok", "action": "input_sent|ctrl_c_sent" }
 */

import { createServer, type Server, type Socket } from 'node:net';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PtySpawn } from './pty-spawn.js';

/** Well-known path where the monitor server advertises its port */
export const MONITOR_INFO_PATH = join(homedir(), '.copilot-remote', 'monitor.json');

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
  private startedAt = Date.now();

  constructor(opts: MonitorServerOptions) {
    this.ptySpawn = opts.ptySpawn;
    this.name = opts.name;
    this.command = opts.command;

    this.server = createServer((socket) => this.onConnect(socket));

    this.ptySpawn.on('exit', ({ exitCode }: { exitCode: number }) => {
      this.state = 'exited';
      this.exitCode = exitCode;
      this.broadcast({ type: 'push_state', state: 'exited', exitCode });
    });
  }

  async start(port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server.address();
        this.actualPort = typeof addr === 'object' && addr ? addr.port : 0;
        this.writeInfoFile();
        resolve(this.actualPort);
      });
    });
  }

  stop(): void {
    this.removeInfoFile();
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.server.close();
  }

  get port(): number {
    return this.actualPort;
  }

  private onConnect(socket: Socket): void {
    this.clients.add(socket);

    // Push: hello + current state
    this.send(socket, {
      type: 'hello',
      name: this.name,
      command: this.command,
      pid: this.ptySpawn.pid,
      port: this.actualPort,
      startedAt: this.startedAt,
    });

    this.send(socket, {
      type: 'push_state',
      state: this.state,
      ...(this.exitCode !== undefined && { exitCode: this.exitCode }),
    });

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
          this.handleRequest(socket, msg);
        } catch { /* ignore malformed */ }
      }
    });

    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  }

  private handleRequest(socket: Socket, msg: { type: string; n?: number; data?: string }): void {
    switch (msg.type) {
      case 'get_viewport': {
        const lines = this.ptySpawn.getViewport().filter(l => l.trim().length > 0);
        this.send(socket, { type: 'viewport', lines });
        break;
      }
      case 'get_logs': {
        const lines = msg.n ? this.ptySpawn.getLines(msg.n) : this.ptySpawn.getLines();
        const total = this.ptySpawn.getLines().length;
        this.send(socket, { type: 'logs', lines, total });
        break;
      }
      case 'get_info': {
        this.send(socket, {
          type: 'info',
          name: this.name,
          command: this.command,
          pid: this.ptySpawn.pid,
          state: this.state,
          port: this.actualPort,
          startedAt: this.startedAt,
          logSize: this.ptySpawn.getLines().length,
          ...(this.exitCode !== undefined && { exitCode: this.exitCode }),
        });
        break;
      }
      case 'send_input': {
        if (msg.data && this.state === 'running') {
          this.ptySpawn.write(msg.data);
          this.send(socket, { type: 'ok', action: 'input_sent' });
        }
        break;
      }
      case 'send_ctrl_c': {
        if (this.state === 'running') {
          this.ptySpawn.write('\x03');
          this.send(socket, { type: 'ok', action: 'ctrl_c_sent' });
        }
        break;
      }
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

  private writeInfoFile(): void {
    try {
      const dir = join(homedir(), '.copilot-remote');
      mkdirSync(dir, { recursive: true });
      writeFileSync(MONITOR_INFO_PATH, JSON.stringify({
        port: this.actualPort,
        pid: this.ptySpawn.pid,
        name: this.name,
        command: this.command,
        startedAt: this.startedAt,
      }) + '\n');
    } catch { /* best effort */ }
  }

  private removeInfoFile(): void {
    try {
      rmSync(MONITOR_INFO_PATH, { force: true });
    } catch { /* best effort */ }
  }
}
