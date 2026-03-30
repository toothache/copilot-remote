# Spec — PTY Spawn & Passthrough

## Responsibility

Spawn the agent CLI inside a pseudo-terminal (node-pty), pass through I/O transparently, and record all output for replay.

---

## Basic Operation

```bash
copilot-remote copilot --name my-project
```

1. Parse CLI args to extract agent command and monitor options.
2. Spawn agent command in a PTY (node-pty) with inherited environment and cwd.
3. Pipe `process.stdin` → PTY stdin (transparent passthrough).
4. Pipe PTY stdout → `process.stdout` (transparent passthrough).
5. Handle terminal resize (`SIGWINCH` on Unix, ConPTY on Windows).
6. On PTY exit → emit exit event, clean up, exit with agent's exit code.

The user should not notice any difference from running the agent directly — same colors, same cursor behavior, same interactive experience.

---

## PTY Configuration

```ts
interface PtySpawnOptions {
  command: string;         // e.g. "copilot"
  args: string[];          // e.g. []
  cwd: string;             // --cwd or process.cwd()
  env: NodeJS.ProcessEnv;  // inherited + any overrides
  cols: number;            // process.stdout.columns
  rows: number;            // process.stdout.rows
}
```

- Use `node-pty` for cross-platform PTY (ConPTY on Windows, native on Unix).
- Inherit `process.env` — agent CLIs need PATH, HOME, etc.
- Set `stdin` to raw mode for full key passthrough.

---

## Output Tapping

PTY stdout is a single stream. Multiple consumers need it:

```
PTY stdout ──┬──▶ process.stdout     (user sees output)
             ├──▶ OutputMonitor       (pattern detection — future)
             ├──▶ RingBuffer          (for //logs command — future)
             └──▶ Recorder            (write to .jsonl file)
```

All taps are synchronous listeners on the PTY `onData` event. No buffering or delays — output appears on screen instantly.

---

## Ring Buffer

Stores recent output lines for `//logs` command and output digest.

```ts
interface RingBuffer {
  push(line: string): void;
  getLines(n?: number): string[];  // last N lines, default all
  capacity: number;                // max lines stored (default 1000)
}
```

Populated by splitting PTY output on newlines (after ANSI stripping). Available from startup.

---

## Recording (for test replay)

Every PTY output chunk is written to a `.jsonl` file:

```jsonl
{"t":0,"type":"spawn","command":"copilot","args":[],"cols":120,"rows":40}
{"t":12,"type":"output","data":"Welcome to GitHub Copilot CLI..."}
{"t":1503,"type":"output","data":"Allow write to src/index.ts? (y/n)"}
{"t":5200,"type":"input","data":"y\n"}
{"t":5250,"type":"output","data":"✓ Wrote src/index.ts"}
{"t":18400,"type":"exit","code":0}
```

- `t` = milliseconds since spawn.
- `type` = `spawn`, `output`, `input`, `exit`, `resize`.
- `data` = raw string (with ANSI codes preserved).

**File location:** `~/.copilot-remote/recordings/{name}-{timestamp}.jsonl`

**Opt-in:** `--record` flag enables recording. Off by default.

**Replay mode:** `copilot-remote --replay <file>` feeds recorded output through the pipeline at original timing. No real PTY spawned. Useful for testing OutputMonitor patterns without a live agent.

---

## Restart Support

For `//restart` command (future):

1. Kill current PTY process.
2. Respawn with same `PtySpawnOptions`.
3. All taps (OutputMonitor, RingBuffer, Recorder) continue on the new PTY.
4. Ring buffer is cleared on restart (fresh session).

The monitor process itself stays alive — only the inner agent restarts.

---

## Signal Handling

| Signal | Action |
|--------|--------|
| `SIGWINCH` | Resize PTY to match new terminal dimensions |
| `SIGINT` (Ctrl+C) | Forward to PTY (agent handles it). Do NOT exit monitor. |
| `SIGTERM` | Kill PTY, clean up, exit. |

On Windows, `SIGWINCH` is handled via `process.stdout.on('resize')`.

---

## Exit Behavior

- When agent process exits → monitor exits with same exit code.
- Clean up: restore terminal raw mode, flush recorder, close files.
- Print summary line: `[copilot-remote] Agent exited (code: 0)`.

---

## Open Questions

- [ ] Should `--record` be on by default during prototype phase?
- [ ] Max recording file size / auto-rotation?
- [ ] Support passing agent command as a single quoted string? e.g. `copilot-remote "claude --continue"`
