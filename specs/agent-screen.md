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

Takes a `PtySpawn` instance and auto-wires `on('data')` internally. No manual `write()` needed — AgentScreen is a self-contained component.

```ts
class AgentScreen extends EventEmitter {
  constructor(pty: PtySpawn, opts?: {
    cols?: number;           // default: match pty or 120
    rows?: number;           // default: match pty or 40
    logCapacity?: number;    // max log lines in ring buffer, default 1000
    debounceMs?: number;     // silence trigger, default 300
    maxIntervalMs?: number;  // max time between log commits, default 2000
    maxHitCount?: number;    // data events before forced snapshot, default 50
  });
}
```

Internally owns an `@xterm/headless` Terminal (private implementation detail).

### No write() Method

AgentScreen subscribes to `pty.on('data')` in the constructor. Every PTY data event is fed to xterm-headless in real-time (keeps the virtual terminal in sync). The snapshot/log machinery runs on its own schedule.

Consumers interact through read-only getters and events — they don't push data.

### Output — Viewport (raw)

The current screen exactly as the TUI renders it, including chrome.

```ts
// All viewport lines (including chrome, empty lines trimmed from bottom)
get viewport(): string[];
```

### Output — Semantic Getters

Derived from `classifyViewport()` — subclass defines what each region means.

```ts
// Content lines only (chrome stripped)
get content(): string[];

// Agent's current input buffer (what the user is typing into the agent)
get input(): string;

// Pending prompt text (e.g., "Allow copilot to run npm install?")
get prompt(): string | null;
```

These call `classifyViewport()` internally and extract the relevant region.

### Output — Log

Append-only history of meaningful content. Built from viewport snapshots using **tail-overlap diff**.

```ts
// Last N log lines (default all)
getLog(n?: number): string[];

// Total log lines stored
get logSize(): number;
```

### Events

```ts
// Emitted when new lines are committed to the log
on('settled', (newLines: string[]) => void);
```

### Lifecycle

```ts
dispose(): void;   // clears timers, removes pty listener, disposes xterm
```

### Resize

AgentScreen listens to `pty.on('resize')` events (if available) and resizes the internal xterm terminal accordingly. Can also be called manually:

```ts
resize(cols: number, rows: number): void;
```

---

## Snapshot & Log Machinery

### Multi-trigger Debounce

Snapshots are **not** taken on every data event. Instead, three triggers control when a snapshot is taken and committed to the log:

| Trigger | Default | Purpose |
|---|---|---|
| **Debounce** | 300ms silence | Clean frame after TUI settles |
| **Max interval** | 2000ms | Captures content during long streams |
| **Hit count** | 50 data events | Captures during bursts |

**Whichever fires first** triggers a snapshot. After each snapshot, all counters reset.

```
On each pty data event:
  1. Feed data to xterm-headless (always, immediately)
  2. Reset debounce timer
  3. Increment hit counter
  4. If hit counter >= maxHitCount → snapshot now
  5. If time since last snapshot >= maxIntervalMs → snapshot now

On debounce timer fire (300ms silence):
  6. Snapshot now (clean frame — TUI has been quiet)
```

### Tail-Overlap Diff

When a snapshot fires, new content is identified by comparing the current viewport against the log tail:

```
Log tail:     [..., A, B, C]
Viewport:     [B, C, D, E, F]
                ↑ overlap ↑ new → append [D, E, F] to log
```

**Algorithm:** Find the longest suffix of the log that matches a prefix of the viewport (content lines only, after `classifyViewport()` + `normalizeLine()`). Everything after the overlap in the viewport is new content.

Edge cases:
- **No overlap found** — either a big scroll gap or full TUI repaint. Append all content lines.
- **Full overlap** — viewport is stale, nothing new. Skip.
- **Identical lines** — matching a *sequence* (not individual lines) disambiguates.
- **Content loss** — if content scrolls past between snapshots, it's lost. Acceptable — the debounce + max interval + hit count minimize this window.

Lines go through `normalizeLine()` before comparison to tolerate minor rendering differences (partial frames, spinner prefixes).

### Log Storage

Content is stored in a `RingBuffer<string>` (existing component). When capacity is reached, oldest lines are evicted.

---

## Subclass Hooks

AgentScreen defines two hooks that subclasses override:

### classifyViewport(lines: string[]): ScreenRegion[]

Given the raw viewport lines, classify each into a region type. Base class returns all lines as `content`.

```ts
type RegionType = 'content' | 'chrome' | 'input' | 'prompt';

interface ScreenRegion {
  type: RegionType;
  startRow: number;
  endRow: number;      // exclusive
  lines: string[];
}
```

### normalizeLine(line: string): string

Normalize a line before diff comparison. Base class returns the line unchanged (trimEnd only). Subclass strips spinner prefixes, volatile decorations, etc.

---

## CopilotScreen (subclass)

Extends AgentScreen with Copilot CLI-specific knowledge.

### Construction

```ts
class CopilotScreen extends AgentScreen {
  constructor(pty: PtySpawn, opts?: {
    cols?: number;
    rows?: number;
    logCapacity?: number;
    debounceMs?: number;
    maxIntervalMs?: number;
    maxHitCount?: number;
  });
}
```

### classifyViewport() — Copilot-specific

Recognizes Copilot CLI's TUI layout:

```
╭─╮╭─╮ ╭─╮╭─╮ ...          ← chrome (logo art)
╰─╯╰─╯ ╰─╯╰─╯ ...          ← chrome (logo art)
                              ← chrome (empty)
  Here's what I'll do:        ← content
  1. Create the file           ← content
  2. Add the function          ← content
                              ← content (blank separator)
  ● Thinking...                ← content (with spinner)
╭──────────────────────╮      ← chrome (box border)
│ Allow copilot to     │      ← prompt
│ run `npm install`?   │      ← prompt
╰──────────────────────╯      ← chrome (box border)
  > yes                        ← input
  shift+tab to switch mode     ← chrome (status bar)
```

Chrome patterns:
- Box-drawing borders: `╭──╮`, `╰──╯`, `│ ... │` (border lines only)
- Separators: `────────`
- Logo art: `╭─╮╭─╮`, `╰─╯╰─╯`, `█`, `▘`, `▝`
- Status bar: lines containing `shift+tab`

### normalizeLine() — Copilot-specific

Strips volatile decorations before diff comparison:
- Spinner prefixes: `● `, `◉ `, `◎ `, `○ ` → stripped
- Trailing whitespace → stripped
- Cursor artifacts → stripped

This means `● Thinking...` and `◉ Thinking...` are treated as the same line for dedup.

### Future: Prompt & Error Detection

CopilotScreen is the natural home for prompt/error detection (planned, not yet implemented):

```ts
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

Both classes are testable **without a live PTY**. Use a mock PtySpawn that emits data events:

```ts
// Unit test — replay recorded data, assert viewport and log
const mockPty = new MockPtySpawn();
const screen = new CopilotScreen(mockPty);

for (const chunk of recordedChunks) {
  mockPty.emit('data', chunk);
}
// Wait for debounce to settle
await sleep(400);

expect(screen.viewport.length).toBeGreaterThan(0);
expect(screen.content.every(line => !isChrome(line))).toBe(true);
expect(screen.logSize).toBeGreaterThan(0);
```

**Recording replay** — `.jsonl` files from `PtySpawn --record` provide real ANSI data. The recording is the contract between PtySpawn and AgentScreen.

**Tail-overlap diff** is pure function — unit-testable independently:

```ts
expect(findNewLines(['A', 'B', 'C'], ['B', 'C', 'D', 'E'])).toEqual(['D', 'E']);
expect(findNewLines(['A', 'B'], ['A', 'B'])).toEqual([]);
expect(findNewLines([], ['X', 'Y'])).toEqual(['X', 'Y']);
```

---

## Adding New Agents

To support a new TUI agent (e.g. Claude Code):

```ts
class ClaudeScreen extends AgentScreen {
  classifyViewport(lines: string[]): ScreenRegion[] {
    // Claude-specific chrome patterns, prompt detection
  }
  normalizeLine(line: string): string {
    // Claude-specific volatile decoration stripping
  }
}
```

Each agent's TUI has unique chrome — subclasses encode that knowledge.

---

## Design Decisions & Rationale

| Decision | Rationale |
|---|---|
| Self-contained (takes PtySpawn, no write()) | Single wiring point, no external plumbing |
| xterm-headless is private | Implementation detail; consumers use semantic getters |
| Snapshot-based (not per-data-event) | Avoids processing every animation frame; decouples PTY throughput from log logic |
| Multi-trigger debounce | Clean frames from silence (300ms), no content loss during streams (2s/50 hits) |
| Tail-overlap diff | Immune to scroll position; naturally append-only; handles TUI repaints |
| Inheritance over composition | Prompt detection needs behavioral hooks (state machine), not just data/patterns |
| normalizeLine() hook | Tolerates partial rendering, spinner animation, cursor artifacts |
| Content loss acceptable | Rare for TUI apps; can be mitigated later (auto-summarize via agent) |

---

## Open Questions

- [ ] Should log include input echoes? Currently only captures output changes.
- [ ] Multi-line prompt detection — match across consecutive viewport lines?
- [ ] Maximum viewport diff size before treating as "full repaint" (skip logging)?
- [ ] Exact normalization patterns — needs tuning against real Copilot sessions.
