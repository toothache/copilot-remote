# Spec — PtySpawn

## Responsibility

Spawn a process inside a pseudo-terminal (node-pty), expose raw I/O via events, and manage the process lifecycle. **Standalone** — knows nothing about agents, screens, or networking.

---

## Design Principle

PtySpawn is a thin wrapper around node-pty. It adds:
1. **Command resolution** on Windows (`.exe` suffix via `where.exe`).
2. **Simulated typing** for TUI apps that process stdin in raw mode.
3. **EventEmitter hooks** so consumers attach their own logic externally.

It does NOT contain: ScreenBuffer, ContentLog, Recorder, AgentProfile, or any agent-specific knowledge. Wiring happens at the application level.

---

## API

### Construction & Spawn

```ts
interface PtySpawnOptions {
  command: string;         // e.g. "copilot"
  args?: string[];         // e.g. []
  name?: string;           // session name for display
  cwd?: string;            // default process.cwd()
  env?: NodeJS.ProcessEnv; // default process.env
  cols?: number;           // default process.stdout.columns
  rows?: number;           // default process.stdout.rows
}

class PtySpawn extends EventEmitter {
  constructor(opts: PtySpawnOptions);
  spawn(): void;
}
```

### Events (hooks)

```ts
on('data', (data: string) => void)     // raw PTY output chunk
on('exit', (info: PtyExitInfo) => void) // process exited
```

Consumers hook `on('data')` to attach AgentScreen, Recorder, or any other processing. PtySpawn doesn't care what they do with the data.

### Writing to PTY

```ts
// Raw write — sends bytes directly to PTY stdin
write(data: string): void;

// Simulated typing for TUI apps (Ink/React raw mode)
// Writes text as bulk chunk, then \r after delay to submit
writeSimulated(text: string, submit?: boolean, preSubmitDelay?: number): Promise<void>;
```

`writeSimulated()` exists because TUI apps like Copilot CLI (built on Ink) process stdin character-by-character in raw mode. Sending `text + '\r'` as one chunk doesn't work — the TUI needs time to process text before receiving Enter.

### Process Control

```ts
resize(cols: number, rows: number): void;
kill(): void;
restart(): Promise<void>;  // kill + respawn with same options
```

### State

```ts
get pid(): number | undefined;
get running(): boolean;
```

---

## Windows Compatibility

- **Command resolution**: `copilot` → `copilot.exe`. Uses `where.exe` to find the full path. Required because node-pty on Windows needs `.exe` suffix.
- **ConPTY**: node-pty uses ConPTY on Windows. `writeSimulated()` with delayed `\r` is required for reliable TUI input.

---

## Signal Handling

| Signal | Action |
|--------|--------|
| `SIGWINCH` | Resize PTY to match new terminal dimensions |
| `SIGINT` (Ctrl+C) | Forward to PTY. Do NOT exit wrapper. |
| `SIGTERM` | Kill PTY, clean up, exit. |

On Windows, `SIGWINCH` is handled via `process.stdout.on('resize')`.

---

## Wiring Example

```ts
// Application level — wire PtySpawn to AgentScreen
const pty = new PtySpawn({ command: 'copilot' });
const screen = new CopilotScreen();

pty.on('data', (data) => {
  process.stdout.write(data);   // passthrough to terminal
  screen.write(data);           // feed to screen parser
});

pty.on('exit', (info) => {
  screen.dispose();
  process.exit(info.exitCode);
});

pty.spawn();
```

---

## Testing

Testable with simple commands — no agent or screen needed:

```ts
const pty = new PtySpawn({ command: 'echo', args: ['hello'] });
const chunks: string[] = [];
pty.on('data', (d) => chunks.push(d));
pty.on('exit', (info) => {
  assert(chunks.join('').includes('hello'));
  assert(info.exitCode === 0);
});
pty.spawn();
```

---

## Open Questions

- [ ] Should `restart()` emit a `restart` event?
- [ ] Should `--record` be a PtySpawn concern or an external hook? (Current preference: external hook via `on('data')`)
- [ ] `writeSimulated` delay (50ms) — needs tuning per platform?
