# Spec — EventsReader + SessionDiscovery

## Responsibility

Discover and tail the Copilot CLI's local session events file (`events.jsonl`), providing structured, lossless access to the agent's conversation — messages, tool calls, permission requests, and lifecycle events — without PTY scraping.

---

## Why This Exists

Copilot CLI already serializes every session event to `~/.copilot/session-state/{uuid}/events.jsonl` as NDJSON. This is the same data that powers Copilot's `/remote` feature (streamed to GitHub's backend for web/mobile access).

By tailing this file locally, copilot-remote gets:
- **Exact user prompts and assistant responses** (no viewport parsing)
- **Structured tool calls** (name, arguments, results)
- **Permission requests** (no regex matching needed)
- **Session lifecycle** (compaction, mode changes, model changes)
- **Lossless history** (no content lost between viewport snapshots)

This complements the PTY/AgentScreen layer, which provides live visual state.

---

## Session State Layout

```
~/.copilot/session-state/           (or $COPILOT_HOME/session-state/)
  ├── {session-uuid}/
  │     ├── workspace.yaml          ← cwd, repository, branch, session ID
  │     ├── events.jsonl            ← structured event stream (NDJSON, append-only)
  │     ├── session.db              ← SQLite (session-specific state)
  │     ├── inuse.{PID}.lock        ← one per active process (PID = content)
  │     └── ...
  └── session-store.db              ← global index (SQLite)
```

- `COPILOT_HOME` env var overrides the default `~/.copilot` base path.
- Lock files: `inuse.{PID}.lock` contains the PID as text. One lock per active process; a session may have multiple (main + subagents).
- `workspace.yaml` fields: `id`, `cwd`, `git_root`, `repository`, `branch`, `summary`, `created_at`, `updated_at`.

---

## SessionDiscovery

Finds the session folder for a Copilot process that copilot-remote spawned via PtySpawn.

### Algorithm

```
PtySpawn.spawn('copilot') → wrapper PID
  │
  ├─ Copilot spawns two processes:
  │    wrapper copilot.exe (no session UUID in args)
  │      └─ agent copilot.exe --resume {UUID} (actual agent)
  │
  ├─ Walk process tree: find child copilot.exe of wrapper PID
  │    → agent PID
  │
  └─ Scan session-state/*/inuse.{agentPID}.lock
       → session folder path
       → events.jsonl path
```

### Interface

```ts
class SessionDiscovery {
  constructor(opts?: {
    copilotHome?: string;   // default: $COPILOT_HOME || ~/.copilot
    pollIntervalMs?: number; // how often to re-scan, default 500
  });

  // Find session folder for a given PtySpawn process
  // Resolves when session is discovered (lock file appears)
  // Rejects after timeout
  discover(ptyPid: number, timeoutMs?: number): Promise<SessionInfo>;

  dispose(): void;
}

interface SessionInfo {
  sessionId: string;          // UUID from workspace.yaml or folder name
  sessionDir: string;         // full path to session folder
  eventsPath: string;         // full path to events.jsonl
  workspaceMeta: {            // parsed workspace.yaml
    cwd: string;
    repository?: string;
    branch?: string;
  };
  agentPid: number;           // the actual copilot agent PID
}
```

### Process Tree Scan

- **Windows**: `Get-CimInstance Win32_Process` or `wmic` — query `ParentProcessId` to find children
- **Linux/macOS**: `/proc/{pid}/children` or `pgrep -P {pid}`
- Node.js: use `child_process.execSync` to query OS-specific APIs

### Edge Cases

- **Fresh session (not `--resume`)**: child copilot.exe may not have UUID in args. Fall back to lock file scan.
- **Multiple copilot.exe children**: pick the one with a matching lock file.
- **Wrapper re-execs**: the PID from PtySpawn may itself be the agent (no wrapper). Check lock files for the PtySpawn PID directly first.
- **Slow startup**: Copilot may take seconds to create the session folder. `discover()` polls until found or timeout.

---

## EventsReader

Tails `events.jsonl` and emits parsed, typed events.

### Interface

```ts
class EventsReader extends EventEmitter {
  constructor(eventsPath: string, opts?: {
    startFromEnd?: boolean;   // true = only new events; false = replay all (default: true)
    pollIntervalMs?: number;  // file poll interval, default 100
  });

  // Start tailing
  start(): void;

  // Stop tailing
  stop(): void;

  // Read all events from file (one-shot, for replay/testing)
  static readAll(eventsPath: string): CopilotEvent[];

  dispose(): void;
}
```

### Events Emitted

```ts
// Generic event shape (all events have this)
interface CopilotEvent {
  type: string;
  id: string;
  timestamp: string;          // ISO 8601
  parentId: string | null;    // causal chain
  data: Record<string, unknown>;
}

// Typed event subtypes
on('event', (event: CopilotEvent) => void);                    // all events
on('user.message', (event: UserMessageEvent) => void);          // user input
on('assistant.message', (event: AssistantMessageEvent) => void); // agent response
on('tool.execution_start', (event: ToolStartEvent) => void);
on('tool.execution_complete', (event: ToolCompleteEvent) => void);
on('session.start', (event: SessionStartEvent) => void);
on('session.shutdown', (event: CopilotEvent) => void);
on('session.remote_steerable_changed', (event: RemoteSteerableEvent) => void);
on('abort', (event: CopilotEvent) => void);
// ... additional typed events as needed
```

### Key Event Types Discovered

| Type | Data Fields | Purpose |
|---|---|---|
| `session.start` | sessionId, version, producer, copilotVersion, context | Session created |
| `session.shutdown` | — | Session ended |
| `session.resume` | — | Session resumed |
| `session.warning` | warningType, message | Warnings (e.g., remote disabled) |
| `session.info` | infoType, message | Info (auth, MCP connected) |
| `session.remote_steerable_changed` | remoteSteerable: boolean | /remote toggled |
| `session.compaction_start/complete` | — | Context compaction |
| `session.mode_changed` | — | Mode switch (interactive/plan) |
| `session.model_change` | — | Model changed |
| `user.message` | content, transformedContent, attachments | User prompt |
| `assistant.turn_start` | turnId | Agent starts processing |
| `assistant.turn_end` | — | Agent finishes turn |
| `assistant.message` | messageId, content, toolRequests[], reasoningText | Agent response |
| `tool.execution_start` | toolCallId, toolName, arguments | Tool invoked |
| `tool.execution_complete` | toolCallId, toolName, success, result | Tool result |
| `hook.start/end` | hookType, input | Hook lifecycle |
| `subagent.started/completed` | — | Subagent lifecycle |
| `abort` | — | Operation cancelled |
| `system.notification` | — | System notices |

### File Tailing Strategy

- Use `fs.watch` or `fs.watchFile` for change detection
- On change: read from last known offset to EOF
- Parse new bytes as NDJSON lines (handle partial lines at EOF)
- Emit parsed events
- **No file locking** — events.jsonl is append-only, safe to read concurrently

---

## REST API (future — noted for reference)

Copilot CLI also exposes session events via SSE:

```
GET https://api.enterprise.githubcopilot.com/agents/sessions/{sessionId}/logs
```

- Format: `data: {json}\n\n` (Server-Sent Events)
- Same events as events.jsonl, slightly different envelope:
  - User messages: `{role:"user", content, source, created}` (flatter)
  - Assistant messages: OpenAI chat.completion.chunk format (choices[].delta)
  - Other events: same `{type, id, timestamp, parentId, data}` shape
- Requires GitHub authentication
- This is how `/remote` works — local CLI pushes events to this endpoint, web/mobile consumes them

**Not implementing in MVP** — local events.jsonl is sufficient. REST API enables future "truly remote" mode where copilot-remote doesn't need to be on the same machine.

---

## Integration with copilot-remote

### Dual Data Path

```
┌─────────────────────────────────────────────────────┐
│                    copilot-remote                     │
│                                                       │
│  PTY Layer (visual)              Events Layer (data)  │
│  ├─ PtySpawn wraps copilot.exe   ├─ SessionDiscovery  │
│  ├─ AgentScreen → viewport/log   │  (PID → lock file) │
│  └─ Local terminal passthrough   ├─ EventsReader      │
│                                  │  (tail events.jsonl)│
│                                  └─ Structured events  │
│                                                       │
│  WeChat Bridge consumes BOTH:                         │
│  ├─ EventsReader → rich notifications                 │
│  │  (tool calls, errors, permission requests)         │
│  └─ AgentScreen → viewport snapshot on demand         │
│     ("show me current screen")                        │
└─────────────────────────────────────────────────────┘
```

- **EventsReader** is the primary content source for WeChat notifications — structured, lossless.
- **AgentScreen** is the visual camera — for on-demand "what's on screen?" queries.
- Both are wired to the same PtySpawn/Copilot process.

---

## Testing

### SessionDiscovery Tests

```ts
// Mock filesystem with session-state dirs and lock files
// Verify PID matching, timeout behavior, edge cases
```

### EventsReader Tests

```ts
// Feed a real events.jsonl (or synthetic) as a test fixture
// Verify event parsing, type discrimination, tail behavior
const events = EventsReader.readAll('fixtures/session-events.jsonl');
expect(events.filter(e => e.type === 'user.message')).toHaveLength(5);
expect(events[0].type).toBe('session.start');
```

### Integration Test

```ts
// Start a live Copilot session via PtySpawn
// Use SessionDiscovery to find the session
// Use EventsReader to tail events
// Verify events match what the PTY displays
```

---

## Open Questions

- [ ] Can we detect permission requests from events alone? (tool execution that blocks = pending permission)
- [ ] Does events.jsonl flush immediately or buffer? (affects tail latency)
- [ ] Should we also read session.db for additional state?
- [ ] Handle session compaction — does events.jsonl get truncated or rewritten?
