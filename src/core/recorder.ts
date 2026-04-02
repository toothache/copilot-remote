/**
 * Recording types and recorder for capturing PTY sessions.
 */

import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type RecordEntryData =
  | { type: 'spawn'; command: string; args: string[]; cols: number; rows: number }
  | { type: 'output'; data: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'exit'; code: number };

export type RecordEntry = RecordEntryData & { t: number };

export class Recorder {
  private filePath: string;
  private startTime: number;

  constructor(name: string) {
    const dir = join(homedir(), '.copilot-remote', 'recordings');
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = join(dir, `${name}-${ts}.jsonl`);
    this.startTime = Date.now();
    writeFileSync(this.filePath, '');
  }

  write(entry: RecordEntryData): void {
    const record = { t: Date.now() - this.startTime, ...entry };
    appendFileSync(this.filePath, JSON.stringify(record) + '\n');
  }

  get path(): string {
    return this.filePath;
  }
}
