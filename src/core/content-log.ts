/**
 * ContentLog — semantic log extracted from a TUI's viewport changes.
 *
 * Instead of naively logging every viewport diff (which produces duplicates
 * from spinners, typing, and counter updates), ContentLog uses a settle-based
 * approach:
 *
 *   1. On each viewport snapshot, compare each row to its previous content.
 *   2. If a row changed AND matches a "known-final" whitelist → log immediately.
 *   3. Otherwise → start a 300ms debounce timer for that row.
 *   4. When the timer fires (row stopped changing) → log the settled content.
 *   5. Apply chrome filter + normalize + dedup before logging.
 *
 * User input is captured separately via logInput() — never extracted from screen.
 */

import { RingBuffer } from './ring-buffer.js';
import type { AgentProfile } from './agent-profile.js';

export interface ContentLogOptions {
  /** Agent profile for chrome/whitelist/normalize */
  agentProfile: AgentProfile;
  /** Settle delay in ms before logging a non-immediate line (default 300) */
  settleDelay?: number;
  /** Ring buffer capacity (default 1000) */
  capacity?: number;
}

export class ContentLog {
  private log: RingBuffer;
  private profile: AgentProfile;
  private settleDelay: number;

  /** Per-row settle state: row index → { content, timer } */
  private slots = new Map<number, { content: string; timer: ReturnType<typeof setTimeout> }>();
  /** Previous viewport lines for change detection */
  private prevLines: string[] = [];
  /** Dedup set: normalized strings already logged */
  private logged = new Set<string>();

  constructor(opts: ContentLogOptions) {
    this.profile = opts.agentProfile;
    this.settleDelay = opts.settleDelay ?? 300;
    this.log = new RingBuffer(opts.capacity ?? 1000);
  }

  /**
   * Feed a new viewport snapshot (array of row strings).
   * Called by PtySpawn after ScreenBuffer processes raw output.
   */
  update(viewportLines: string[]): void {
    for (let i = 0; i < viewportLines.length; i++) {
      const cur = viewportLines[i];
      const prev = i < this.prevLines.length ? this.prevLines[i] : '';

      // Skip unchanged rows
      if (cur === prev) continue;

      const trimmed = cur.trimEnd();

      // Skip empty
      if (trimmed.length === 0) {
        this.cancelSlot(i);
        continue;
      }

      // Chrome → drop entirely, cancel any pending timer
      if (this.profile.isChrome(trimmed)) {
        this.cancelSlot(i);
        continue;
      }

      // Known-final → log immediately, cancel any pending timer
      if (this.profile.isImmediate(trimmed)) {
        this.cancelSlot(i);
        this.tryLog(trimmed);
        continue;
      }

      // Otherwise → settle/debounce: start or reset timer for this row
      this.scheduleSettle(i, trimmed);
    }

    this.prevLines = [...viewportLines];
  }

  /**
   * Log user input directly (captured from ptySpawn.write, not from screen).
   */
  logInput(text: string): void {
    const clean = text.replace(/[\r\n]+$/, '').trim();
    if (clean.length > 0) {
      this.log.push(`❯ ${clean}`);
    }
  }

  /** Get log lines. */
  getLines(n?: number): string[] {
    return this.log.getLines(n);
  }

  /** Total log lines available. */
  get size(): number {
    return this.log.size;
  }

  /** Flush all pending settle timers immediately (for cleanup/testing). */
  flush(): void {
    for (const [row, slot] of this.slots) {
      clearTimeout(slot.timer);
      this.tryLog(slot.content);
    }
    this.slots.clear();
  }

  /** Clear all state. */
  clear(): void {
    for (const [, slot] of this.slots) clearTimeout(slot.timer);
    this.slots.clear();
    this.prevLines = [];
    this.logged.clear();
    this.log.clear();
  }

  // --- Internal ---

  private scheduleSettle(row: number, content: string): void {
    // Cancel existing timer for this row
    const existing = this.slots.get(row);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.slots.delete(row);
      this.tryLog(content);
    }, this.settleDelay);

    this.slots.set(row, { content, timer });
  }

  private cancelSlot(row: number): void {
    const existing = this.slots.get(row);
    if (existing) {
      clearTimeout(existing.timer);
      this.slots.delete(row);
    }
  }

  private tryLog(line: string): void {
    // Normalize for dedup
    const normalized = this.profile.normalize(line);
    if (normalized === null) return;

    // Dedup
    if (this.logged.has(normalized)) return;
    this.logged.add(normalized);
    this.log.push(normalized);

    // Cap dedup set
    if (this.logged.size > 10_000) {
      this.logged.clear();
      for (const l of this.log.getLines()) {
        this.logged.add(l);
      }
    }
  }
}
