# Spec — PtySpawn

## Responsibility

Spawn a process inside a pseudo-terminal (node-pty), expose raw output via events, and accept input. **Standalone** — knows nothing about agents, screens, or networking.

---

## Design Principle

PtySpawn is a thin wrapper around node-pty. It adds:
1. **Command resolution** on Windows (`.exe` suffix via `where.exe`).
2. **Simulated typing** for TUI apps that process stdin in raw mode.
3. **EventEmitter hooks** so consumers attach their own logic externally.

It does NOT contain: ScreenBuffer, ContentLog, Recorder, AgentProfile, or any agent-specific knowledge. Wiring happens at the application level.

---

## API

### Construction & Lifecycle

```ts
interface PtySpawnOptions {
  command: string;         // e.g. "copilot"
  args?: string[];         // e.g. []
  name?: string;           // session name for display
  cwd?: string;            // default process.cwd()
  env?: NodeJS.ProcessEnv; // default process.env
  cols?: number;           // default 80
  rows?: number;           // default 24
}

interface PtyExitInfo {
  exitCode: number;
  signal?: number;
}

class PtySpawn extends EventEmitter {
  constructor(opts: PtySpawnOptions);

  spawn(): void;       // start the PTY process
  kill(): void;        // kill the PTY process
  restart(): void;     // kill + respawn with same options
}
```

### Input

```ts
// Send text input to agent — simulated typing + submit
// Writes text as bulk chunk, then \r after delay so TUI processes it
sendText(text: string): Promise<void>;

// Send a control/special key
sendKey(key: 'ctrl-c' | 'escape'): void;
```

`sendText()` exists because TUI apps like Copilot CLI (built on Ink) process stdin character-by-character in raw mode. Sending `text + '\r'` as one chunk doesn't work — the TUI needs time to process text before receiving Enter.

No raw `write()` is exposed. Consumers don't need to know about PTY byte sequences.

### Events

```ts
on(event: 'data', cb: (data: string) => void): this;   // raw PTY output chunk
on(event: 'exit', cb: (info: PtyExitInfo) => void): this; // process exited
```

Consumers hook `on('data')` to attach AgentScreen, Recorder, or any other processing. PtySpawn doesn't care what they do with the data.

### State

```ts
get pid(): number | undefined;
get running(): boolean;
```

---

## Windows Compatibility

- **Command resolution**: `copilot` → `copilot.exe`. Uses `where.exe` to find the full path. Required because node-pty on Windows needs `.exe` suffix.
- **ConPTY**: node-pty uses ConPTY on Windows. `sendText()` with delayed `\r` is required for reliable TUI input.

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
- [ ] `sendText` delay (50ms) — needs tuning per platform?
