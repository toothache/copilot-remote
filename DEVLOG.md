# copilot-remote — Dev Log & Plan

## One-liner
Monitor, interact with, and control your Copilot CLI agent from WeChat.

## What's Done (Steps 1 complete)

### Specs
- `specs/overview.md` — Functional spec (all design decisions, component descriptions, command tables, data flow)
- `specs/pty-spawn.md` — PTY spawn component spec
- `specs/output-monitor.md` — Output monitor component spec

### Core Components
- **PtySpawn** (`src/core/pty-spawn.ts`) — Spawn agent CLI in PTY, passthrough, recording, Windows `.exe` auto-resolution via `where.exe`
- **ScreenBuffer** (`src/core/screen-buffer.ts`) — `@xterm/headless` virtual terminal. Resolves all ANSI (cursor movement, erase, spinners, alternate screen) into clean text. Two APIs:
  - `getViewport()` — current screen content (for pattern matching)
  - `getLines()` — log of resolved viewport snapshots + scrollback
- **RingBuffer** (`src/core/ring-buffer.ts`) — Fixed-capacity circular buffer (used internally by ScreenBuffer)
- **Recorder** (`src/core/recorder.ts`) — `.jsonl` session recording with timestamps
- **MonitorServer** (`src/core/monitor-server.ts`) — TCP server streaming clean viewport snapshots to monitor clients

### Test CLIs
- `src/cli/test-pty.ts` — Live PTY mode, `--record`, `--replay`, `--monitor`, `--monitor-port`
- `src/cli/test-monitor.ts` — Monitor client, connects to MonitorServer
- `src/cli/test-screen-buffer.ts` — Replay recordings through ScreenBuffer, verify clean output

### Verified
- Real Copilot CLI v1.0.16-1: spawn, interact, record, replay — all working
- ScreenBuffer correctly resolves 388 raw output chunks into clean text (no spinner noise)

## Key Technical Decisions

- **Explicit local/remote mode** — one controller at a time, no race conditions, no atomic clear needed
- **`//` prefix** for monitor commands, `/` passthrough to agent CLI (avoids collision with Copilot's `/plan`, `/model`, etc.)
- **AgentProfile interface** — pluggable agent-specific patterns. MVP: Copilot only. Future: Claude, Codex
- **300ms prompt confirmation delay** (configurable, down from prototype's 1.5s)
- **ScreenBuffer over naive RingBuffer** — Copilot CLI uses alternate screen buffer, so scrollback is empty during operation. ScreenBuffer captures viewport diffs into log instead.
- **`@xterm/headless` is CJS** — import as: `import xtermHeadless from '@xterm/headless'` then `const { Terminal } = xtermHeadless`
- **Windows node-pty** needs `.exe` suffix — `resolveCommand()` uses `where.exe` to auto-resolve
- **Monitor commands**: `//approve`, `//deny`, `//status`, `//logs [N]`, `//cancel` (Ctrl+C), `//restart`, `//cheatsheet`, `//help`
- **Output access**: push (5s digest, 30 lines) + pull (`//logs N`, 1000-line ring buffer)

## Build Order (Remaining)

### Step 2: OutputMonitor + CopilotProfile ← NEXT
- `AgentProfile` interface: regex patterns for permission prompts, errors, thinking state
- `OutputMonitor`: thin layer over ScreenBuffer's `getViewport()`/`getViewportText()`
- State machine: `running → maybe_prompt → confirmed_prompt`
- Emit events: `prompt-detected`, `error-detected`, `thinking`, `idle`
- Use recorded sessions to author and test regex patterns

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
- Monitor auto-launch on Windows: current approach (PowerShell Start-Process + temp .cmd) untested interactively
