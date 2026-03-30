# Spec — Output Monitor

## Responsibility

Watch PTY output for permission prompts, errors, and idle state. Hold the pending prompt so the active mode controller (local HUD or remote WeChat) can resolve it.

---

## Pipeline

```
PTY onData(chunk)
  → feed(chunk)
    → strip ANSI
    → split into lines (buffer partial lines)
    → match each line against AgentProfile patterns
      → prompt match? → enter maybe_prompt, start 300ms timer
      → error match?  → emit error_detected
      → no match      → reset idle timer
```

---

## State Machine

```
                 (new output, no match)
              ┌──────────────────────────┐
              ▼                          │
          ┌────────┐   pattern    ┌──────────────┐  300ms timeout  ┌───────────────────┐
          │ running │───match────▶│ maybe_prompt │────────────────▶│ confirmed_prompt  │
          └────────┘              └──────────────┘                 └───────────────────┘
              ▲                        │                                  │
              │               (new output cancels)              (approve/deny/new output)
              │                        │                                  │
              └────────────────────────┴──────────────────────────────────┘
```

- **running**: Normal operation. Matching lines against patterns.
- **maybe_prompt**: A pattern matched. Waiting 300ms for more output that might cancel it (e.g. a multi-line message that only partially looks like a prompt).
- **confirmed_prompt**: Prompt confirmed. `pendingPrompt` is set. Waiting for resolution.

---

## Pending Prompt State

OutputMonitor owns the pending prompt. The active mode controller reads it and writes approve/deny input to PTY.

```ts
interface PendingPrompt {
  label: string;           // e.g. "file_write", "shell_exec"
  matchedLine: string;     // the raw line that triggered detection
  detectedAt: number;      // Date.now()
  approveInput: string;    // what to write to PTY for yes (e.g. "y\n")
  denyInput: string;       // what to write to PTY for no (e.g. "n\n")
}
```

```ts
// OutputMonitor public API for prompt state
pendingPrompt: PendingPrompt | null;

// Called by mode controller after writing approve/deny to PTY
clearPrompt(): void;
```

When a prompt is resolved (locally or remotely), the controller writes to PTY and calls `clearPrompt()`. OutputMonitor returns to `running` state.

---

## Events

| Event | Payload | When |
|-------|---------|------|
| `prompt_detected` | `PendingPrompt` | 300ms after pattern match with no cancellation |
| `prompt_cleared` | `{ label, resolvedBy: 'local' \| 'remote' }` | After clearPrompt() is called |
| `error_detected` | `{ line: string, pattern: string }` | Error pattern matched |
| `idle` | `{ idleSeconds: number }` | No output for configured timeout |
| `active` | `{}` | Output resumed after idle |

---

## Line Buffering

PTY output arrives in arbitrary chunks (not line-aligned). The monitor must buffer partial lines:

```
chunk 1: "Allow write to src/in"
chunk 2: "dex.ts? (y/n)\n✓ Processing..."
```

→ Lines extracted: `["Allow write to src/index.ts? (y/n)", "✓ Processing..."]` (second line still buffering)

---

## Agent Profile Integration

OutputMonitor takes an `AgentProfile` at construction. It uses the profile's patterns for matching.

```ts
class OutputMonitor extends EventEmitter {
  constructor(profile: AgentProfile, options?: {
    confirmDelay?: number;   // default 300ms
    idleTimeout?: number;    // default 30s
  });

  feed(chunk: string): void;

  get pendingPrompt(): PendingPrompt | null;
  clearPrompt(): void;
  getState(): 'running' | 'maybe_prompt' | 'confirmed_prompt';
}
```

---

## AgentProfile (reiterated from overview)

```ts
interface AgentProfile {
  id: string;
  promptPatterns: PromptPattern[];
  errorPatterns: ErrorPattern[];
  cheatsheet: CheatsheetEntry[];
}

interface PromptPattern {
  regex: RegExp;
  label: string;
  approveInput: string;
  denyInput: string;
}

interface ErrorPattern {
  regex: RegExp;
  label: string;
}

interface CheatsheetEntry {
  command: string;
  description: string;
}
```

---

## Copilot Profile (MVP)

Hardcoded patterns based on known Copilot CLI output. To be refined against real recordings.

```ts
const copilotProfile: AgentProfile = {
  id: 'copilot',
  promptPatterns: [
    // TODO: capture real Copilot CLI prompt formats from recordings
    // Examples of expected shapes:
    // "Allow copilot to write to src/index.ts? (y/n)"
    // "Allow copilot to run `npm install`? (y/n)"
    // "Allow copilot to delete src/old.ts? (y/n)"
  ],
  errorPatterns: [
    // TODO: capture real error formats from recordings
  ],
  cheatsheet: [
    { command: '/autopilot', description: 'Switch to auto-pilot mode' },
    { command: '/plan', description: 'Switch to plan mode' },
    { command: '/model <name>', description: 'Switch model' },
    { command: '/help', description: 'Show Copilot help' },
  ],
};
```

**Key dependency:** We need real Copilot CLI recordings (from PTY spawn + `--record`) to finalize the regex patterns. Step 1 (PTY spawn) unblocks this.

---

## Replay Mode Integration

When running `copilot-remote --replay <file>`, the OutputMonitor receives the same `feed()` calls but from the recording file instead of a live PTY. Timing is preserved — chunks arrive at their recorded intervals.

This allows testing pattern detection without a live agent:

```bash
# Record a real session
copilot-remote copilot --record

# Replay and test detection
copilot-remote --replay ~/.copilot-remote/recordings/my-project-20260330.jsonl
```

---

## Open Questions

- [ ] Should we match multiple lines together (e.g. prompt spans 2 lines)? Start with single-line.
- [ ] Should idle detection pause during `maybe_prompt` / `confirmed_prompt` states?
- [ ] Debounce multiple rapid prompt detections (agent asks 3 things in a row)?
