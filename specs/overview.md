# Functional Spec — copilot-remote

## One-liner

Wrap your AI coding agent in a PTY — monitor output, handle prompts, and control it remotely when you're away.

---

## Problem

AI coding agents (Copilot CLI, Codex, Claude Code) block on permission prompts and crash silently. If you're away from the terminal, you lose time.

## Solution

A PTY wrapper that:
1. Lets you use the agent normally in your terminal (transparent passthrough).
2. Understands agent output — filters TUI chrome, extracts meaningful content.
3. Detects permission prompts, errors, and idle state.
4. Connects to WeChat so you can approve/deny/query from your phone.

---

## Architecture

Two layers. Core is a reusable library. Application wires core pieces for the specific use case.

### Core (library — no networking, no UI)

```
PtySpawn                    AgentScreen (base)
  │ spawn, sendText, kill     │ ANSI → clean text, viewport, log
  │ sendKey, events           │
  │                           CopilotScreen (subclass)
  │                             │ chrome filter, settle dedup,
  │                             │ prompt/error detection
  └─── on('data') ───────────▶ │
```

**PtySpawn** — Generic PTY wrapper. Spawns a process, exposes raw I/O hooks. Knows nothing about agents.

**AgentScreen** — Virtual terminal that resolves ANSI escape sequences into clean text. Provides viewport (current screen) and log (meaningful output history). Base class is agent-agnostic.

**CopilotScreen** — Subclass of AgentScreen with Copilot CLI knowledge: chrome patterns (box borders, spinners, status bar), settle-based dedup, prompt/error regex patterns.

### Application (wiring, networking, UI)

- **MonitorServer** — TCP server for remote access. Takes `{ pty: PtySpawn, screen: AgentScreen }`.
- **CLI entry point** — Creates PtySpawn + CopilotScreen, hooks them together, starts MonitorServer.
- **HudRenderer, InputRouter, WeChatBridge** — future application-level components.

### Data Flow

```
PtySpawn ──on('data')──▶ CopilotScreen ──▶ viewport / log
    │                                           │
    │                                           ▼
    └─────────────── MonitorServer (reads screen, writes pty)
                           │
                      [Remote Client]
```

---

## Interaction Modes

| Mode | Terminal | WeChat | How to enter |
|------|----------|--------|-------------|
| **Local** (default) | Full control | Notifications only | Hotkey reclaim, or startup |
| **Remote** | Read-only mirror | Full control | Hotkey delegate, or auto on idle |

Only one side has control at a time. Switching is explicit (hotkey) or automatic (idle timeout).

---

## Command Namespacing

| Prefix | Routed to | Examples |
|--------|-----------|---------|
| `//` (double slash) | **Monitor commands** (ours) | `//status`, `//approve` |
| `/` (single slash) | **Agent passthrough** | `/autopilot`, `/model gpt-4` |
| Plain text | **Agent stdin** | "refactor the auth module" |

---

## CLI Interface

```bash
copilot-remote <agent-command> [options]

copilot-remote copilot --name my-project
copilot-remote "claude --continue" --name backend

--name <name>          Session name
--cwd <dir>            Working directory
--no-wechat            Disable WeChat
--record               Record session to .jsonl
--replay <file>        Replay a recording (no live PTY)
```

---

## What This Is NOT

- Not a daemon or multi-agent orchestrator (future phase).
- Not a terminal multiplexer (no tmux, no attach/detach).
- No LLM supervisor / auto-approve (future phase).
- No authentication/encryption in MVP.
