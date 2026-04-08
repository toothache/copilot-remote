/**
 * PtySpawn — standalone PTY wrapper.
 *
 * Spawns a process inside a pseudo-terminal (node-pty), exposes raw output
 * via events, and accepts input via sendText/sendKey. Knows nothing about
 * agents, screens, or networking.
 */

import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';

export interface PtySpawnOptions {
  command: string;
  args?: string[];
  name?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

export interface PtyExitInfo {
  exitCode: number;
  signal?: number;
}

/** Supported special keys for sendKey() */
export type SpecialKey = 'ctrl-c' | 'escape';

const KEY_MAP: Record<SpecialKey, string> = {
  'ctrl-c': '\x03',
  'escape': '\x1b',
};

export class PtySpawn extends EventEmitter {
  private ptyProcess: pty.IPty | null = null;
  private _running = false;
  private opts: Required<Pick<PtySpawnOptions, 'command' | 'args' | 'cwd' | 'cols' | 'rows'>> & PtySpawnOptions;

  constructor(opts: PtySpawnOptions) {
    super();
    this.opts = {
      ...opts,
      args: opts.args ?? [],
      cwd: opts.cwd ?? process.cwd(),
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
    };
  }

  /** Start the PTY process */
  spawn(): void {
    const { args, cwd, cols, rows } = this.opts;
    const command = resolveCommand(this.opts.command);
    const env = this.opts.env ?? { ...process.env } as Record<string, string>;

    this.ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: env as Record<string, string>,
    });

    this._running = true;

    const currentProcess = this.ptyProcess;

    this.ptyProcess.onData((data: string) => {
      this.emit('data', data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      // Ignore exit from a previous process after restart
      if (this.ptyProcess !== currentProcess) return;
      this._running = false;
      this.emit('exit', { exitCode, signal } as PtyExitInfo);
    });
  }

  /** Kill the PTY process */
  kill(): void {
    try {
      this.ptyProcess?.kill();
    } catch {
      // already dead
    }
  }

  /** Kill and respawn with same options */
  restart(): void {
    this.kill();
    this.spawn();
  }

  /**
   * Send text input to the agent. Writes text as a bulk chunk, then sends
   * \r after a short delay so TUI apps (Ink/React raw mode) can process
   * the characters before receiving Enter.
   */
  async sendText(text: string, preSubmitDelay = 50): Promise<void> {
    if (!this.ptyProcess) return;
    this.ptyProcess.write(text);
    await new Promise(r => setTimeout(r, preSubmitDelay));
    this.ptyProcess.write('\r');
  }

  /** Send a control/special key */
  sendKey(key: SpecialKey): void {
    this.ptyProcess?.write(KEY_MAP[key]);
  }

  get pid(): number | undefined {
    return this.ptyProcess?.pid;
  }

  get running(): boolean {
    return this._running;
  }
}

/** Resolve a command name to its full path on Windows (node-pty needs .exe). */
function resolveCommand(command: string): string {
  if (process.platform !== 'win32') return command;
  if (/\.\w+$/.test(command)) return command;

  try {
    const resolved = execFileSync('where.exe', [command], {
      encoding: 'utf-8',
      windowsHide: true,
    }).split('\n')[0].trim();
    if (resolved) return resolved;
  } catch {
    // where.exe failed — fall through
  }
  return command;
}
