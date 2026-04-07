# copilot-remote — Dev Log & Plan

## One-liner
Monitor, interact with, and control your Copilot CLI agent from WeChat.

## What's Done (Steps 1 + Monitor Refactor complete)

### Specs
- `specs/overview.md` — Functional spec (all design decisions, component descriptions, command tables, data flow)
- `specs/pty-spawn.md` — PTY spawn component spec
- `specs/output-monitor.md` — Output monitor component spec

### Core Components
- **PtySpawn** (`src/core/pty-spawn.ts`) — Spawn agent CLI in PTY, passthrough, recording, Windows `.exe` auto-resolution via `where.exe`
- **ScreenBuffer** (`src/core/screen-buffer.ts`) — `@xterm/headless` virtual terminal. Resolves all ANSI into clean text. Viewport-only (no log responsibility):
  - `getViewport()` — current screen content (for pattern matching)
  - `getViewportText()` — viewport as single string
  - `getLines()` — scrollback for non-TUI apps only
- **ContentLog** (`src/core/content-log.ts`) — Semantic log from viewport changes. Hybrid settle-based + whitelist approach:
  - Known-final lines (`● response`, `└ summary`) → logged immediately
  - Other changes → 300ms debounce, only settled content logged
  - Spinner prefixes (`●◉◎○`) normalized → one entry per event
  - Thinking counters collapsed → one entry
  - Chrome (borders, separators, status bar) → dropped entirely
  - User input captured from `ptySpawn.write()` directly, not from screen
- **AgentProfile** (`src/core/agent-profile.ts`) — Pluggable agent-specific patterns:
  - `isChrome()` — TUI chrome to drop (borders, separators, status bar, path line)
  - `isImmediate()` — known-final content to log without debounce
  - `normalize()` — canonical form for dedup (strip spinners, counters)
  - `copilotProfile` — Copilot CLI implementation
- **RingBuffer** (`src/core/ring-buffer.ts`) — Fixed-capacity circular buffer
- **Recorder** (`src/core/recorder.ts`) — `.jsonl` session recording with timestamps
- **MonitorServer** (`src/core/monitor-server.ts`) — Pull-based TCP server. Clients request data on demand; server pushes only state changes + exit:
  - `get_viewport`, `get_logs`, `get_info` (read)
  - `send_input`, `send_ctrl_c` (write)
  - `push_state` on connect + exit (push)
  - Auto-advertises port via `~/.copilot-remote/monitor.json`

### Test CLIs
- `src/cli/test-pty.ts` — Live PTY mode, `--record`, `--replay`, `--monitor`. Auto-detects copilot command → uses `copilotProfile`
- `src/cli/test-monitor.ts` — Interactive monitor client with `//` commands (`//screen`, `//logs`, `//info`, `//send`, `//ctrl-c`, `//help`). Auto-detects port from `monitor.json`
- `src/cli/test-screen-buffer.ts` — Replay recordings through ScreenBuffer, verify clean output

### Verified
- Real Copilot CLI v1.0.17: spawn, interact, record, replay — all working
- ScreenBuffer correctly resolves ANSI into clean viewport text
- MonitorServer pull-based protocol: `//screen`, `//logs`, `//info`, `//send`, `//ctrl-c` all verified
- ContentLog settle-based approach eliminates spinner/typing/counter noise from logs

## Key Technical Decisions

- **Explicit local/remote mode** — one controller at a time, no race conditions, no atomic clear needed
- **`//` prefix** for monitor commands, `/` passthrough to agent CLI (avoids collision with Copilot's `/plan`, `/model`, etc.)
- **AgentProfile interface** — pluggable agent-specific patterns. MVP: Copilot only. Future: Claude, Codex
- **300ms prompt confirmation delay** (configurable, down from prototype's 1.5s)
- **ContentLog over viewport-diff-to-log** — viewport diffing was fundamentally wrong for TUI apps (spinners, typing, counters produce duplicate entries). ContentLog uses settle-based debounce + whitelist for clean semantic logs
- **`@xterm/headless` is CJS** — import as: `import xtermHeadless from '@xterm/headless'` then `const { Terminal } = xtermHeadless`
- **Windows node-pty** needs `.exe` suffix — `resolveCommand()` uses `where.exe` to auto-resolve
- **Pull-based monitor protocol** — clients request data on demand (`get_viewport`, `get_logs`, `get_info`); server only pushes state changes. Eliminates viewport flood from old streaming approach
- **Monitor port auto-detection** — server writes `~/.copilot-remote/monitor.json` on start; client reads it. No manual port passing needed

## Build Order (Remaining)

### Step 2: OutputMonitor ← NEXT
- `OutputMonitor`: state machine over ScreenBuffer's `getViewport()`/`getViewportText()`
- State machine: `running → maybe_prompt → confirmed_prompt`
- Emit events: `prompt-detected`, `error-detected`, `thinking`, `idle`
- Use recorded sessions to author and test regex patterns
- Integrate prompt/error patterns into `copilotProfile`

### Step 3: HudRenderer + InputRouter
- ANSI overlay at terminal bottom
- `Ctrl+]` toggle HUD, `Ctrl+\` mode switch (local/remote)
- Local approve/deny hotkeys
- `//` command parsing and dispatch

### Step 4: WeChatBridge + RemoteConnector
- WeChat SDK integration
- Command parsing with `//` prefix
- Output digest (5s batch, 30-line cap)
- Push notifications for permission prompts
- QR code login, credential persistence at `~/.agent-monitor/wechat-session.json`

## Open Questions
- Should `--record` be on by default during prototype phase?
- Exact Copilot CLI prompt regex patterns (need more recorded sessions)
- ContentLog settle delay (300ms) — may need tuning based on real usage
- Monitor auto-launch on Windows: current approach (PowerShell Start-Process + temp .cmd) untested interactively
