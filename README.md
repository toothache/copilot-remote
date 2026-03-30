# copilot-remote

Monitor, interact with, and control your Copilot CLI agent from WeChat — check status, approve prompts, and send commands from your phone.

## What It Does

Wraps an agent CLI (Copilot, Codex, Claude Code) in a PTY, monitors output for permission prompts and errors, and gives you remote control via WeChat.

```
┌───────────────────────────────────────────────────┐
│  Terminal                                         │
│  ┌─────────────┐    ┌──────────────────────────┐  │
│  │  Agent CLI  │◄──►│  PTY (node-pty)          │  │
│  │  (copilot)  │    │  ├─ OutputMonitor        │  │
│  └─────────────┘    │  ├─ PromptTracker        │  │
│                     │  ├─ InputRouter (HUD)    │  │
│                     │  └─ HudRenderer          │  │
│                     └────────────┬─────────────┘  │
│                                  │                │
│                     ┌────────────▼─────────────┐  │
│                     │  RemoteConnector         │  │
│                     │  └─ WeChatBridge         │  │
│                     └──────────────────────────┘  │
└───────────────────────────────────────────────────┘
         ▲                          │
         │ local keyboard           │ WeChat notifications
         │                          ▼
      [You at desk]           [You on phone]
```

## Getting Started

```bash
npm install
npm run build
npm start -- copilot --name my-project
```

## Development

```bash
npm run dev       # Run with tsx
npm test          # Run tests
```
