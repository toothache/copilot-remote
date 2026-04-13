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

**Dual data path**: PTY layer for live visual state, Events layer for structured content.

```
PtySpawn                    AgentScreen (base)         SessionDiscovery
  │ spawn, sendText, kill     │ ANSI → viewport/log      │ PID → session folder
  │ sendKey, writeRaw         │                           │
  │                           CopilotScreen (subclass)  EventsReader
  │                             │ chrome filter, dedup     │ tail events.jsonl
  └─── on('data') ───────────▶ │                          │ structured events
                                                          │ messages, tools,
                                                          │ permissions, lifecycle
```

**PtySpawn** — Generic PTY wrapper. Spawns a process, exposes raw I/O hooks. Knows nothing about agents.

**AgentScreen** — Virtual terminal (xterm-headless) resolving ANSI into clean text. Snapshot-based viewport + tail-overlap log. Visual camera.

**CopilotScreen** — AgentScreen subclass with Copilot CLI knowledge: chrome patterns, normalization, region classification.

**SessionDiscovery** — Finds Copilot CLI's session folder by walking the process tree from PtySpawn's PID to the child copilot.exe PID, then matching `inuse.{PID}.lock` in `~/.copilot/session-state/`.

**EventsReader** — Tails `events.jsonl` from the discovered session folder. Emits typed events: user messages, assistant responses, tool calls, permission requests, session lifecycle. Lossless transcript.

### Application (wiring, networking, UI)

- **MonitorServer** — TCP server for remote access. Takes `{ pty, screen, events }`.
- **CLI entry point** — Creates PtySpawn + CopilotScreen + EventsReader, wires them together.
- **HudRenderer, InputRouter, WeChatBridge** — future application-level components.

### Data Flow

```
                        ┌──────────────────┐
PtySpawn ─on('data')──▶ │  CopilotScreen   │──▶ viewport (live visual)
  │                     │  (xterm-headless) │──▶ content log (visual)
  │                     └──────────────────┘
  │
  │  (same copilot.exe process)
  │
  │                     ┌──────────────────┐
  └─ PID ──▶ Discovery ▶│  EventsReader    │──▶ messages, tool calls
             (lock file) │  (events.jsonl)  │──▶ permission requests
                         └──────────────────┘──▶ session lifecycle
                                │
                  WeChat Bridge consumes both:
                  ├─ EventsReader → rich notifications
                  └─ AgentScreen  → viewport on demand
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
