/**
 * PtySpawn — core component for spawning and managing an agent CLI in a PTY.
 *
 * Provides transparent passthrough, output tapping (multiple consumers),
 * virtual terminal screen buffer (via @xterm/headless), and optional recording.
 */

import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { ScreenBuffer } from './screen-buffer.js';
import { Recorder } from './recorder.js';

export interface PtySpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  /** Enable .jsonl recording */
  record?: boolean;
  /** Session name (used for recording filename and display) */
  name?: string;
  /** Ring buffer capacity (default 1000 lines) */
  scrollbackCapacity?: number;
}

export interface PtyExitInfo {
  exitCode: number;
  signal?: number;
}

export class PtySpawn extends EventEmitter {
  private ptyProcess: pty.IPty | null = null;
  private screenBuffer: ScreenBuffer;
  private recorder: Recorder | null = null;
  private options: Required<Pick<PtySpawnOptions, 'command' | 'args' | 'cwd' | 'cols' | 'rows'>> & PtySpawnOptions;

  constructor(opts: PtySpawnOptions) {
    super();
    this.options = {
      ...opts,
      args: opts.args ?? [],
      cwd: opts.cwd ?? process.cwd(),
      cols: opts.cols ?? process.stdout.columns ?? 80,
      rows: opts.rows ?? process.stdout.rows ?? 24,
    };
    this.screenBuffer = new ScreenBuffer({
      cols: this.options.cols,
      rows: this.options.rows,
      scrollbackCapacity: opts.scrollbackCapacity ?? 1000,
    });
    if (opts.record) {
      this.recorder = new Recorder(opts.name ?? 'session');
    }
  }

  spawn(): void {
    const { args, cwd, cols, rows } = this.options;
    const command = resolveCommand(this.options.command);
    const env = this.options.env ?? { ...process.env } as Record<string, string>;

    this.ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: env as Record<string, string>,
    });

    this.recorder?.write({ type: 'spawn', command, args, cols, rows });

    this.ptyProcess.onData((data: string) => {
      this.emit('data', data);
      this.screenBuffer.write(data);
      this.recorder?.write({ type: 'output', data });
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      const info: PtyExitInfo = { exitCode, signal };
      this.recorder?.write({ type: 'exit', code: exitCode });
      this.emit('exit', info);
    });
  }

  /** Write data to PTY stdin */
  write(data: string): void {
    this.ptyProcess?.write(data);
    this.recorder?.write({ type: 'input', data });
  }

  /** Resize PTY */
  resize(cols: number, rows: number): void {
    this.ptyProcess?.resize(cols, rows);
    this.screenBuffer.resize(cols, rows);
    this.recorder?.write({ type: 'resize', cols, rows });
  }

  /** Kill the PTY process */
  kill(): void {
    try {
      this.ptyProcess?.kill();
    } catch {
      // already dead
    }
  }

  /** Respawn with same options (for //restart) */
  restart(): void {
    this.kill();
    this.screenBuffer.clear();
    this.spawn();
  }

  /** Get recent log lines — clean text resolved through virtual terminal */
  getLines(n?: number): string[] {
    return this.screenBuffer.getLines(n);
  }

  /** Get current viewport content — what the user sees on screen right now */
  getViewport(): string[] {
    return this.screenBuffer.getViewport();
  }

  /** Get viewport as a single string — convenient for regex matching */
  getViewportText(): string {
    return this.screenBuffer.getViewportText();
  }

  get recordingPath(): string | null {
    return this.recorder?.path ?? null;
  }

  get pid(): number | undefined {
    return this.ptyProcess?.pid;
  }
}

/** Resolve a command name to its full path on Windows (node-pty needs .exe). */
function resolveCommand(command: string): string {
  if (process.platform !== 'win32') return command;
  if (/\.\w+$/.test(command)) return command; // already has extension

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
