/**
 * Replay a recording through ScreenBuffer and show clean output.
 * Usage: npx tsx src/cli/test-screen-buffer.ts <recording.jsonl>
 */

import { ScreenBuffer } from '../core/screen-buffer.js';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const recording = process.argv[2];
if (!recording) {
  console.error('Usage: test-screen-buffer <recording.jsonl>');
  process.exit(1);
}

const sb = new ScreenBuffer({ cols: 120, rows: 80 });

const rl = createInterface({ input: createReadStream(recording) });
let writeCount = 0;
for await (const line of rl) {
  const entry = JSON.parse(line);
  if (entry.type === 'output') {
    sb.write(entry.data);
    writeCount++;
  }
}

// Flush all pending xterm writes
await sb.flush();

console.log(`Fed ${writeCount} output chunks`);
console.log(`\n=== LOG (last 30 lines) ===`);
const logLines = sb.getLines(30);
for (const l of logLines) {
  console.log(`  ${l}`);
}

console.log(`\n=== CURRENT VIEWPORT (non-empty) ===`);
const vp = sb.getViewport();
for (const l of vp) {
  if (l.trim()) console.log(`  ${l}`);
}

console.log(`\nTotal log lines: ${sb.size}`);
sb.dispose();
