/**
 * ScreenBuffer — virtual terminal emulator backed by @xterm/headless.
 *
 * Feeds raw PTY output through a headless xterm terminal to resolve ANSI
 * escape sequences (cursor movement, erase, scroll, alternate screen, etc.)
 * into clean, human-readable text.
 *
 * Provides:
 *   - getViewport(): current visible screen content (for pattern matching)
 *   - getViewportText(): viewport as single string
 *   - getLines(): scrollback lines for non-TUI apps (normal terminal mode)
 *
 * For TUI apps (alternate screen), use ContentLog for semantic logging instead.
 */

// @xterm/headless is CJS — Terminal is on the default export
import xtermHeadless from '@xterm/headless';
import type { Terminal as TerminalType } from '@xterm/headless';
const { Terminal } = xtermHeadless;
import { RingBuffer } from './ring-buffer.js';

export interface ScreenBufferOptions {
  cols?: number;
  rows?: number;
  /** Max lines to keep in the scrollback log (default 1000) */
  scrollbackCapacity?: number;
}

export class ScreenBuffer {
  private terminal: TerminalType;
  private log: RingBuffer;
  /** Number of scrollback lines we've already consumed into the log */
  private lastScrollbackDrain = 0;

  constructor(opts: ScreenBufferOptions = {}) {
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;

    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 5000,
      allowProposedApi: true,
    });

    this.log = new RingBuffer(opts.scrollbackCapacity ?? 1000);
  }

  /**
   * Feed raw PTY output data into the virtual terminal.
   */
  write(data: string): Promise<void> {
    return new Promise((resolve) => {
      this.terminal.write(data, () => {
        this.drainScrollback();
        resolve();
      });
    });
  }

  /**
   * Wait for all pending writes to be processed.
   */
  flush(): Promise<void> {
    return new Promise((resolve) => {
      this.terminal.write('', () => {
        this.drainScrollback();
        resolve();
      });
    });
  }

  /**
   * Get scrollback log lines (for non-TUI apps that produce scrollback).
   * For TUI apps using alternate screen, scrollback is empty — use ContentLog.
   */
  getLines(n?: number): string[] {
    this.drainScrollback();
    return this.log.getLines(n);
  }

  /**
   * Get the current viewport content — what a user would see on screen right now.
   * Returns an array of `rows` lines (some may be empty).
   */
  getViewport(): string[] {
    this.drainScrollback();
    const buf = this.terminal.buffer.active;
    const rows = this.terminal.rows;
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) {
      const lineIdx = buf.baseY + i;
      const line = buf.getLine(lineIdx);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  /**
   * Get viewport as a single joined string — convenient for regex matching.
   */
  getViewportText(): string {
    return this.getViewport().join('\n');
  }

  /** Total scrollback log lines available */
  get size(): number {
    this.drainScrollback();
    return this.log.size;
  }

  /** Resize the virtual terminal */
  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  /** Clear the log and reset the virtual terminal */
  clear(): void {
    this.terminal.reset();
    this.log.clear();
    this.lastScrollbackDrain = 0;
  }

  /** Dispose the underlying xterm terminal */
  dispose(): void {
    this.terminal.dispose();
  }

  /**
   * Drain new scrollback lines from the xterm buffer into our log.
   * Works for normal-mode apps that produce scrollback.
   */
  private drainScrollback(): void {
    const buf = this.terminal.buffer.active;
    const scrollbackCount = buf.baseY;

    if (scrollbackCount > this.lastScrollbackDrain) {
      for (let i = this.lastScrollbackDrain; i < scrollbackCount; i++) {
        const line = buf.getLine(i);
        if (line) {
          const text = line.translateToString(true);
          this.log.push(text);
        }
      }
      this.lastScrollbackDrain = scrollbackCount;
    }
  }
}
