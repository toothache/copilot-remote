# Spec — AgentScreen

## Responsibility

Resolve raw PTY output (ANSI escape sequences, cursor movements, TUI animations) into clean, readable text. Provide two views: **viewport** (current screen) and **log** (meaningful output history).

Base class `AgentScreen` is agent-agnostic. Subclass `CopilotScreen` adds Copilot CLI-specific knowledge.

---

## Why This Exists

TUI-based agents (Copilot CLI, Claude Code) don't emit simple line-by-line text. They use:
- Alternate screen buffer (`\x1b[?1049h`) — scrollback is always empty
- Spinners and animations (● ◉ ◎ ○) — overwrite the same line repeatedly
- Box-drawing chrome (╭─╮│╰─╯) — visual decoration, not content
- Cursor rewrites — update status bars, progress indicators in-place

Raw PTY output is unusable for logging or remote display. AgentScreen resolves it into meaningful text.

---

## AgentScreen (base class)

### Construction

```ts
class AgentScreen {
  constructor(opts?: {
    cols?: number;        // default 120
    rows?: number;        // default 40
    logCapacity?: number; // max log lines, default 1000
  });
}
```

Uses `@xterm/headless` internally to emulate a real terminal.

### Input

```ts
// Feed raw PTY data — hooked to PtySpawn.on('data')
write(data: string): void;

// Wait for async xterm processing to complete (for batch replay)
flush(): Promise<void>;

// Update terminal dimensions
resize(cols: number, rows: number): void;
```

### Output — Viewport

Current screen content. What the agent is displaying right now.

```ts
// Non-empty lines from the virtual terminal viewport
getViewport(): string[];

// Joined viewport as single string
getViewportText(): string;
```

### Output — Log

Meaningful output history. Built from viewport diffs — when the viewport changes, new non-empty content is appended to the log.

```ts
// Last N log lines (default all)
getLog(n?: number): string[];

// Total log lines stored
get logSize(): number;
```

### Lifecycle

```ts
dispose(): void;
```

### How Log Is Built

On each `write()`, after xterm processes the data:
1. Snapshot the viewport (non-empty lines).
2. Compare to previous snapshot.
3. If changed, push new lines to internal ring buffer.

This captures content that scrolls through the viewport without losing it.

---

## CopilotScreen (subclass)

Extends AgentScreen with Copilot CLI-specific intelligence.

### Additional Behavior

**Chrome filtering** — Strips box-drawing borders, separators, logo art, status bar from log output. Chrome is visible on viewport (faithful to real screen) but excluded from log (only meaningful content).

```ts
// Patterns recognized as chrome (not logged):
// ╭──────╮  ╰──────╯  │ ... │    — box borders
// ────────                       — separators
// ╭─╮╭─╮  ╰─╯╰─╯  █ ▘▝ █      — logo art
// shift+tab switch mode ...      — status bar
```

**Settle-based dedup** — TUI animations produce many viewport changes per second (spinner cycling). CopilotScreen debounces: only logs content after viewport has been stable for a settle period (default 300ms).

**Normalization** — Before dedup comparison, strips volatile prefixes:
- `● Thinking...` / `◉ Thinking...` → normalized to same string
- Spinner prefixes stripped for comparison

### Construction

```ts
class CopilotScreen extends AgentScreen {
  constructor(opts?: {
    cols?: number;
    rows?: number;
    logCapacity?: number;
    settleMs?: number;     // default 300
  });
}
```

### Future: Prompt & Error Detection

CopilotScreen is the natural home for prompt/error detection (currently planned, not yet implemented):

```ts
// Future API
on('prompt', (prompt: PendingPrompt) => void);
on('error', (error: DetectedError) => void);
on('idle', (info: { seconds: number }) => void);

get pendingPrompt(): PendingPrompt | null;
clearPrompt(): void;
```

**Prompt detection state machine** (future):

```
          ┌────────┐  pattern   ┌──────────────┐  300ms  ┌─────────────────┐
          │ running │──match──▶│ maybe_prompt │───────▶│ confirmed_prompt │
          └────────┘           └──────────────┘        └─────────────────┘
              ▲                      │                         │
              └──────────────────────┴─────────────────────────┘
                        (new output / resolve)
```

---

## Testing

Both classes are testable without a live PTY:

```ts
// Unit test — feed recorded data, assert viewport and log
const screen = new CopilotScreen();
for (const chunk of recordedChunks) {
  screen.write(chunk);
}
await screen.flush();

assert(screen.getViewport().length > 0);
assert(screen.getLog().every(line => !isChrome(line)));
```

**Recording replay** — `.jsonl` files from `PtySpawn --record` provide real ANSI data for testing. The recording is the contract between PtySpawn and AgentScreen.

---

## Adding New Agents

To support a new TUI agent (e.g. Claude Code):

```ts
class ClaudeScreen extends AgentScreen {
  // Override chrome patterns, settle timing, normalization
  // Add Claude-specific prompt/error patterns
}
```

Each agent's TUI has unique chrome — subclasses encode that knowledge.

---

## Open Questions

- [ ] Settle delay (300ms) — needs tuning against real Copilot sessions.
- [ ] Should log include input echoes? Currently only captures output changes.
- [ ] Multi-line prompt detection — match across consecutive viewport lines?
- [ ] Maximum viewport diff size before treating as "full repaint" (skip logging)?
