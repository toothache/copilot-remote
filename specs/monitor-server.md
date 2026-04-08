# Spec — MonitorServer

## Responsibility

TCP server that exposes remote access to a running agent session. Reads from AgentScreen, writes to PtySpawn. Application-level component — wires core pieces for remote control.

---

## Layer

MonitorServer is **application-level**, not core. It depends on two core components:

- **AgentScreen** — reads viewport and log
- **PtySpawn** — writes input and monitors process state

```ts
interface MonitorServerOptions {
  pty: PtySpawn;
  screen: AgentScreen;
  name: string;           // human-friendly session name
  port?: number;          // 0 = auto-assign
}
```

---

## Protocol

Newline-delimited JSON over TCP on localhost.

### Push (server → client, unsolicited)

Sent automatically on connection and on state changes.

| Message | When |
|---------|------|
| `{ type: "hello", name, command, pid, port, startedAt }` | On connect |
| `{ type: "push_state", state, exitCode? }` | State change or on connect |

### Pull (client → server → client)

Client sends a request, server replies with a response.

| Request | Response |
|---------|----------|
| `{ type: "get_viewport" }` | `{ type: "viewport", lines: string[] }` |
| `{ type: "get_logs", n?: number }` | `{ type: "logs", lines: string[], total: number }` |
| `{ type: "get_info" }` | `{ type: "info", name, command, pid, state, port, startedAt, logSize }` |
| `{ type: "send_input", data: string }` | `{ type: "ok", action: "input_sent" }` |
| `{ type: "send_ctrl_c" }` | `{ type: "ok", action: "ctrl_c_sent" }` |

### Error Responses

When a request can't be fulfilled:

```json
{ "type": "error", "action": "send_input", "message": "agent not running" }
```

---

## Request Routing

| Request | Reads from | Writes to |
|---------|-----------|-----------|
| `get_viewport` | `screen.getViewport()` | — |
| `get_logs` | `screen.getLog(n)` | — |
| `get_info` | `screen.logSize` + internal state | — |
| `send_input` | — | `pty.sendText(data)` |
| `send_ctrl_c` | — | `pty.sendKey('ctrl-c')` |

This is why MonitorServer needs both `pty` and `screen` — reads go to screen, writes go to PTY.

---

## Service Discovery

On startup, writes a JSON file to a well-known path so clients can auto-connect:

```
~/.copilot-remote/monitor.json
```

```json
{
  "port": 8947,
  "pid": 13540,
  "name": "my-project",
  "command": "copilot",
  "startedAt": 1712345678000
}
```

Removed on `stop()`. Clients read this file to find the running server.

---

## Lifecycle

```ts
const monitor = new MonitorServer({ pty, screen, name: 'my-project' });
const port = await monitor.start();    // returns assigned port
// ... session runs ...
monitor.stop();                        // cleanup
```

- Binds to `127.0.0.1` only (localhost, no auth needed for MVP).
- Auto-assigns port if not specified.
- Tracks connected clients, cleans up on disconnect.
- Broadcasts exit event to all clients when agent exits.

---

## Open Questions

- [ ] Should MonitorServer support multiple simultaneous sessions? (Currently single-session)
- [ ] Authentication for non-localhost access? (Future, when bridging to WeChat)
- [ ] Should `get_viewport` filter empty lines? (Currently yes — matches client expectation)
