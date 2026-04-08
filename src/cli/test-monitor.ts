#!/usr/bin/env node

/**
 * Monitor CLI — interactive client for copilot-remote monitor server.
 *
 * Pull-based: request data on demand with // commands.
 * Push: receives state changes and exit notifications automatically.
 *
 * Usage:
 *   npx tsx src/cli/test-monitor.ts [port]
 *
 * Commands:
 *   //screen          Show current viewport (what the agent sees)
 *   //logs [N]        Show last N log lines (default all)
 *   //info            Show session info (PID, state, uptime, log size)
 *   //send <text>     Send text input to the agent
 *   //ctrl-c          Send Ctrl+C to the agent
 *   //help            Show this help
 *   //quit            Disconnect
 */

import { connect, type Socket } from 'node:net';
import { createInterface, type Interface as RLInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { MONITOR_INFO_PATH } from '../core/monitor-server.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';

function resolvePort(): number {
  const arg = parseInt(process.argv[2], 10);
  if (arg > 0) return arg;
  try {
    const info = JSON.parse(readFileSync(MONITOR_INFO_PATH, 'utf-8'));
    if (info.port > 0) {
      console.log(`${DIM}Auto-detected session: ${info.name} (${info.command}, PID ${info.pid})${RESET}`);
      return info.port;
    }
  } catch { /* no info file */ }
  console.error('No running monitor server found.');
  console.error('Either start test-pty with --monitor, or pass a port: test-monitor <port>');
  process.exit(1);
}

const port = resolvePort();

// --- Connection ---

const socket: Socket = connect({ port, host: '127.0.0.1' });
let rl: RLInterface;

// Session state
let sessionName = '';
let sessionCommand = '';
let sessionPid = 0;
let sessionState = 'unknown';

function formatUptime(startedAt: number): string {
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

function showHelp(): void {
  console.log(`
${BOLD}${CYAN}copilot-remote monitor${RESET} — commands:

  ${BOLD}//screen${RESET}          Current viewport (what the agent sees on screen)
  ${BOLD}//logs [N]${RESET}        Last N log lines (default: all)
  ${BOLD}//info${RESET}            Session info (PID, state, uptime)
  ${BOLD}//send <text>${RESET}     Send text input to agent PTY
  ${BOLD}//ctrl-c${RESET}          Send Ctrl+C to the agent
  ${BOLD}//help${RESET}            This help
  ${BOLD}//quit${RESET}            Disconnect
`);
}

// --- Send request to server ---

function request(msg: object): void {
  try {
    socket.write(JSON.stringify(msg) + '\n');
  } catch { /* socket gone */ }
}

// --- Handle server messages ---

function handleMessage(msg: Record<string, unknown>): void {
  switch (msg.type) {
    case 'hello':
      sessionName = (msg.name as string) ?? '';
      sessionCommand = (msg.command as string) ?? '';
      sessionPid = (msg.pid as number) ?? 0;
      console.log(`${GREEN}●${RESET} Connected to ${BOLD}${sessionName}${RESET} (${sessionCommand}, PID ${sessionPid}, port ${port})`);
      console.log(`${DIM}Type //help for commands${RESET}`);
      break;

    case 'push_state':
      sessionState = (msg.state as string) ?? 'unknown';
      if (msg.state === 'exited') {
        console.log(`\n${RED}${BOLD}● Agent exited${RESET} (code: ${msg.exitCode})`);
        setTimeout(() => process.exit(0), 500);
      } else {
        console.log(`${DIM}[state: ${sessionState}]${RESET}`);
      }
      break;

    case 'viewport': {
      const lines = msg.lines as string[];
      console.log(`\n${BOLD}${CYAN}── viewport (${lines.length} lines) ──${RESET}`);
      for (const line of lines) {
        console.log(line);
      }
      console.log(`${CYAN}── end ──${RESET}`);
      break;
    }

    case 'logs': {
      const lines = msg.lines as string[];
      const total = msg.total as number;
      console.log(`\n${BOLD}${YELLOW}── logs (${lines.length}/${total} total) ──${RESET}`);
      for (const line of lines) {
        console.log(line);
      }
      console.log(`${YELLOW}── end ──${RESET}`);
      break;
    }

    case 'info': {
      const stateColor = msg.state === 'running' ? GREEN : RED;
      console.log(`\n${BOLD}Session info:${RESET}`);
      console.log(`  Name:     ${BOLD}${msg.name}${RESET}`);
      console.log(`  Command:  ${msg.command}`);
      console.log(`  PID:      ${msg.pid}`);
      console.log(`  State:    ${stateColor}${msg.state}${RESET}`);
      console.log(`  Port:     ${msg.port}`);
      console.log(`  Uptime:   ${formatUptime(msg.startedAt as number)}`);
      console.log(`  Log size: ${msg.logSize} lines`);
      if (msg.exitCode !== undefined) {
        console.log(`  Exit:     ${msg.exitCode}`);
      }
      break;
    }

    case 'ok':
      console.log(`${GREEN}✓${RESET} ${msg.action}`);
      break;
  }
}

// --- Parse incoming JSON stream ---

let buf = '';
socket.on('data', (data) => {
  buf += data.toString();
  const parts = buf.split('\n');
  buf = parts.pop() ?? '';
  for (const part of parts) {
    if (!part.trim()) continue;
    try {
      handleMessage(JSON.parse(part));
    } catch { /* ignore */ }
  }
});

// --- Handle user commands ---

function handleCommand(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (!trimmed.startsWith('//')) {
    console.log(`${DIM}Commands start with //. Type //help for list.${RESET}`);
    return;
  }

  const parts = trimmed.slice(2).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case 'screen':
    case 'viewport':
      request({ type: 'get_viewport' });
      break;

    case 'logs':
    case 'log': {
      const n = parseInt(parts[1], 10) || undefined;
      request({ type: 'get_logs', ...(n && { n }) });
      break;
    }

    case 'info':
    case 'status':
      request({ type: 'get_info' });
      break;

    case 'send': {
      const text = parts.slice(1).join(' ');
      if (!text) {
        console.log(`${RED}Usage: //send <text>${RESET}`);
      } else {
        request({ type: 'send_input', data: text });
      }
      break;
    }

    case 'ctrl-c':
    case 'cancel':
      request({ type: 'send_ctrl_c' });
      break;

    case 'help':
      showHelp();
      break;

    case 'quit':
    case 'exit':
      socket.destroy();
      process.exit(0);
      break;

    default:
      console.log(`${RED}Unknown command: //${cmd}${RESET}. Type //help for list.`);
  }
}

// --- Socket lifecycle ---

socket.on('error', (err) => {
  console.error(`${RED}Connection error: ${err.message}${RESET}`);
  console.error('Make sure test-pty is running with --monitor');
  process.exit(1);
});

socket.on('close', () => {
  console.log(`\n${DIM}[monitor] Connection closed${RESET}`);
  process.exit(0);
});

// --- Interactive readline ---

socket.on('connect', () => {
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${DIM}//${RESET} `,
  });

  rl.on('line', (line) => {
    handleCommand(line);
    rl.prompt();
  });

  rl.on('close', () => {
    socket.destroy();
    process.exit(0);
  });

  setTimeout(() => rl.prompt(), 200);
});

console.log(`${DIM}Connecting to monitor on port ${port}...${RESET}`);
