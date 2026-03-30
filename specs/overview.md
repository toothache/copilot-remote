# Functional Spec — copilot-remote

## One-liner

Wrap your Copilot CLI in a PTY — monitor status, handle permission prompts, and interact with it from WeChat when you're away.

---

## Problem

AI coding agents (Copilot CLI, Codex, Claude Code) block on permission prompts and crash silently. If you're away from the terminal, you lose time.

## Solution

A PTY wrapper that:
1. Lets you use the agent normally in your terminal (transparent passthrough).
2. Monitors output for permission prompts and errors via regex.
3. Shows a HUD overlay with status and hotkeys.
4. Connects to WeChat so you can approve/deny/query from your phone.
5. Uses explicit **local/remote mode** — one controller at a time, no race conditions.

---

## Interaction Modes

| Mode | Terminal | WeChat | How to enter |
|------|----------|--------|-------------|
| **Local** (default) | Full control — type, approve, deny | Notifications only (read-only) | Hotkey reclaim, or startup default |
| **Remote** | Read-only mirror (output visible) | Full control — approve, deny, send input | Hotkey delegate, or auto on idle timeout |

Only one side has control at a time. Switching is explicit (hotkey) or automatic (idle timeout).

---

## Components

### 1. OutputMonitor

Watches PTY stdout for permission prompts, errors, and idle state.

- Strips ANSI, buffers lines, matches agent-specific regex patterns.
- On match → waits **300ms** for more output to rule out false positives → emits `prompt_detected`.
- Holds `pendingPrompt` state (label + approveInput/denyInput). Active mode controller reads it and writes to PTY.
- Tracks idle state (configurable timeout, default 30s).
- Uses pluggable **AgentProfile** for patterns (see Agent Profiles section).

```
PTY stdout → strip ANSI → line buffer → regex match → 300ms confirm → event
```

**Events:** `prompt_detected`, `error_detected`, `idle`

### 2. InputRouter

Routes keyboard input based on current interaction mode.

- **Local mode, passthrough:** Keystrokes go straight to PTY.
- **Local mode, HUD active (Ctrl+]):** `a`=approve, `d`=deny, `s`=status, `?`=help, `Esc`=exit HUD.
- **Remote mode:** Terminal input is blocked (read-only mirror). Only mode-switch hotkey works.
- **Mode-switch hotkey** (e.g. Ctrl+\): Toggles between local and remote mode.

### 3. HudRenderer

ANSI overlay at terminal bottom. Uses scroll region to avoid overwriting agent output.

Displays:
- Agent name, state (running / waiting / error / idle)
- Pending prompt (if any) with approve/deny hints
- Current mode indicator (LOCAL / REMOTE)
- Hotkey cheatsheet

### 4. RemoteConnector

Bridges WeChat messages to the agent. Active only in remote mode for control; sends notifications in both modes.

#### Command Namespacing

To avoid collision with agent CLI commands (e.g. Copilot's `/plan`, `/model`, `/autopilot`):

| Prefix | Routed to | Examples |
|--------|-----------|---------|
| `//` (double slash) | **Monitor commands** (ours) | `//status`, `//help`, `//approve` |
| `/` (single slash) | **Agent passthrough** (agent's own commands) | `/autopilot`, `/model gpt-4`, `/plan` |
| Plain text | **Agent stdin** (typed as-is) | "refactor the auth module" |

#### Monitor Commands (inbound, `//` prefix)

| Command | Action | Availability |
|---------|--------|-------------|
| `//approve` | Resolve pending prompt with approve | Remote mode, prompt pending |
| `//deny` | Resolve pending prompt with deny | Remote mode, prompt pending |
| `//status` | Reply with agent state + recent output summary | Both modes |
| `//logs [N]` | Get last N lines from ring buffer (default 50) | Both modes |
| `//cancel` | Send Ctrl+C (SIGINT) to agent process | Remote mode |
| `//restart` | Kill agent, respawn fresh PTY with same command. Monitor + WeChat stay connected. | Remote mode |
| `//cheatsheet` | Show common commands for the detected agent type | Both modes |
| `//help` | List monitor commands | Both modes |

#### Agent Passthrough (inbound, `/` prefix or plain text)

Forwarded directly to PTY stdin. The agent interprets its own commands — we don't need to know agent internals. Examples:

- `/autopilot` → switches Copilot to auto-pilot mode
- `/model gpt-4` → switches Copilot's model
- `/plan` → switches Copilot to plan mode
- `fix the login bug` → natural language input to agent

#### Outbound Notifications (agent → WeChat)

| Trigger | Message | Mode |
|---------|---------|------|
| Prompt detected | "🔐 Permission needed: {label}\nReply //approve or //deny" | Both |
| Error detected | "❌ Error: {summary}" | Both |
| Prompt resolved locally | "✅ Approved locally" / "⛔ Denied locally" | Both |
| Mode switched | "📱 Remote mode active" / "🖥️ Local mode reclaimed" | Both |
| Agent exited | "🛑 Agent exited (code: N)" | Both |
| Agent restarted | "🔄 Agent restarted" | Both |
| Output digest | Last 30 lines, every 5s | Remote only |

#### Output Access (two tiers)

| Tier | Mechanism | Detail level |
|------|-----------|-------------|
| **Push** (automatic) | Output digest every 5s | Last 30 lines — follow along passively |
| **Pull** (on demand) | `//logs N` command | Up to 1000 lines from ring buffer |

### 5. WeChatBridge

Thin SDK wrapper for WeChat connectivity.

- QR code login flow (displays in terminal via `qrcode-terminal`).
- Credential persistence (`~/.copilot-remote/wechat-session.json`).
- Auto-reconnect on session expiry.
- `sendText()`, `reply()`, message event listener.

---

## Agent Profiles

Pluggable abstraction for agent-specific behavior. MVP ships with Copilot CLI only, but the interface supports adding Claude/Codex later without refactoring.

```ts
interface AgentProfile {
  /** Agent identifier */
  id: string;                      // e.g. "copilot", "claude", "codex"

  /** Regex patterns for detecting permission prompts */
  promptPatterns: PromptPattern[];

  /** Regex patterns for detecting errors */
  errorPatterns: RegExp[];

  /** Common agent commands for //cheatsheet */
  cheatsheet: CheatsheetEntry[];
}

interface PromptPattern {
  regex: RegExp;
  label: string;              // e.g. "file_write", "shell_exec"
  approveInput: string;       // what to write to PTY for yes
  denyInput: string;          // what to write to PTY for no
}

interface CheatsheetEntry {
  command: string;            // e.g. "/autopilot"
  description: string;        // e.g. "Switch to auto-pilot mode"
}
```

**MVP:** Hardcoded `CopilotProfile` with known prompt/error patterns and cheatsheet.
**Future:** Load from config file, add Claude/Codex profiles.

---

## Mode Switching

```
┌────────┐  Ctrl+\ or idle timeout  ┌────────┐
│ LOCAL  │─────────────────────────▶│ REMOTE │
│        │◀─────────────────────────│        │
└────────┘       Ctrl+\ reclaim     └────────┘
```

**Idle auto-delegate:**
- Configurable timeout (default: 5 minutes of no keystrokes).
- When triggered: switch to remote mode, notify WeChat that session is waiting.
- User reclaims with hotkey.

---

## CLI Interface

```bash
# Start with agent command
copilot-remote <agent-command> [options]

# Examples
copilot-remote copilot --name my-project
copilot-remote "claude --continue" --name backend
copilot-remote codex --no-wechat

# Options
--name <name>          Human-friendly session name
--cwd <dir>            Working directory for the agent
--no-wechat            Disable WeChat (local-only mode)
--idle-timeout <sec>   Idle timeout before auto-delegate (default: 300)
--confirm-delay <ms>   Prompt confirmation delay (default: 300)
```

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Terminal                                                     │
│                                                              │
│  stdin ──▶ InputRouter ──▶ PTY stdin ──▶ Agent CLI          │
│                │                            │                │
│                │ (HUD actions)    PTY stdout │                │
│                ▼                            ▼                │
│          OutputMonitor ──────────────────▶ HudRenderer    │
│           │  pendingPrompt    │                            │
│           │                   │                            │
│           ▼                   ▼                            │
│       PTY write        RemoteConnector                     │
│       (approve/deny)       │       ▲                       │
│           ▲                ▼       │                       │
│           │           WeChatBridge                         │
│           │                │       ▲                       │
│           └────────────────┘       │                       │
│           (remote approve/deny)    │                       │
└──────────────────────────────────────│───────────────────────┘
                                       │
                                  [Your Phone]
```

---

## What This Is NOT (Scope Boundaries)

- Not a daemon or multi-agent orchestrator (future phase).
- Not a terminal multiplexer (no tmux, no attach/detach).
- Not a replacement for local terminal — remote is an additional control channel.
- No authentication/encryption in MVP (localhost + WeChat's own auth).
- No LLM supervisor / auto-approve (future phase).
