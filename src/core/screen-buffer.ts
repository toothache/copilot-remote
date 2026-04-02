/**
 * ScreenBuffer — virtual terminal emulator backed by @xterm/headless.
 *
 * Feeds raw PTY output through a headless xterm terminal to resolve ANSI
 * escape sequences (cursor movement, erase, scroll, alternate screen, etc.)
 * into clean, human-readable text.
 *
 * Provides two views:
 *   - getLines(): log of meaningful viewport snapshots + scrollback lines
 *   - getViewport(): current visible screen content (for pattern matching)
 *
 * For TUI apps that use the alternate screen buffer (like Copilot CLI),
 * scrollback is empty — so we also capture viewport diffs into the log.
 */

// @xterm/headless is CJS — Terminal is on the default export
import xtermHeadless from '@xterm/headless';
import type { Terminal as TerminalType } from '@xterm/headless';
const { Terminal } = xtermHeadless;
import { RingBuffer } from './ring-buffer.js';

export interface ScreenBufferOptions {
  cols?: number;
  rows?: number;
  /** Max lines to keep in the log ring buffer (default 1000) */
  scrollbackCapacity?: number;
}

export class ScreenBuffer {
  private terminal: TerminalType;
  private log: RingBuffer;
  /** Number of scrollback lines we've already consumed into the log */
  private lastScrollbackDrain = 0;
  /** Last viewport snapshot text — for diffing */
  private lastViewportSnapshot = '';

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
   * The callback-based drain ensures data is processed before reads.
   */
  write(data: string): Promise<void> {
    return new Promise((resolve) => {
      this.terminal.write(data, () => {
        this.drain();
        resolve();
      });
    });
  }

  /**
   * Wait for all pending writes to be processed.
   * Call this before reading if you've been feeding data in a loop.
   */
  flush(): Promise<void> {
    return new Promise((resolve) => {
      this.terminal.write('', () => {
        this.drain();
        resolve();
      });
    });
  }

  /**
   * Get recent log lines — clean text resolved through the virtual terminal.
   * Includes both scrollback (for normal-mode apps) and viewport snapshots
   * (for alternate-screen TUI apps like Copilot CLI).
   * Returns the last N lines (default: all available).
   */
  getLines(n?: number): string[] {
    this.drain();
    return this.log.getLines(n);
  }

  /**
   * Get the current viewport content — what a user would see on screen right now.
   * Used for pattern matching (permission prompts, errors, etc.)
   * Returns an array of `rows` lines (some may be empty).
   */
  getViewport(): string[] {
    this.drain();
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

  /** Total log lines available */
  get size(): number {
    this.drain();
    return this.log.size;
  }

  /** Resize the virtual terminal (call when real terminal resizes) */
  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  /** Clear the log and reset the virtual terminal */
  clear(): void {
    this.terminal.reset();
    this.log.clear();
    this.lastScrollbackDrain = 0;
    this.lastViewportSnapshot = '';
  }

  /** Dispose the underlying xterm terminal */
  dispose(): void {
    this.terminal.dispose();
  }

  /**
   * Drain new content into the log ring buffer.
   * Two sources:
   *   1. Scrollback lines (for normal-mode output)
   *   2. Viewport diffs (for alternate-screen TUI apps)
   */
  private drain(): void {
    this.drainScrollback();
    this.drainViewportDiff();
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

  /**
   * Capture viewport changes into the log.
   * For TUI apps using the alternate screen, scrollback is always empty.
   * Instead, we diff the viewport and log new non-empty lines.
   */
  private drainViewportDiff(): void {
    const buf = this.terminal.buffer.active;
    const rows = this.terminal.rows;
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) {
      const line = buf.getLine(buf.baseY + i);
      lines.push(line ? line.translateToString(true) : '');
    }

    const snapshot = lines.join('\n');
    if (snapshot === this.lastViewportSnapshot) return;
    this.lastViewportSnapshot = snapshot;

    // Extract only the non-empty lines that are new
    const newLines = lines.filter(l => l.trim().length > 0);
    for (const line of newLines) {
      this.log.push(line);
    }
  }
}
