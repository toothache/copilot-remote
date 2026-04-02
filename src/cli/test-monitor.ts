#!/usr/bin/env node

/**
 * Monitor CLI — connects to a running test-pty session's monitor server
 * and displays ring buffer, live output, and control info.
 *
 * Usage:
 *   npx tsx src/cli/test-monitor.ts <port>
 *   npx tsx src/cli/test-monitor.ts <port> --lines 100
 */

import { connect } from 'node:net';

const port = parseInt(process.argv[2], 10);
if (!port) {
  console.error('Usage: test-monitor <port> [--lines N]');
  process.exit(1);
}

let requestLines: number | undefined;
const linesIdx = process.argv.indexOf('--lines');
if (linesIdx !== -1) requestLines = parseInt(process.argv[linesIdx + 1], 10);

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';

const socket = connect({ port, host: '127.0.0.1' });

let sessionName = '';
let sessionCommand = '';
let sessionPid = 0;
let sessionState = 'unknown';
let lineCount = 0;

function renderHeader(): void {
  console.clear();
  console.log(`${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║${RESET}  ${BOLD}copilot-remote monitor${RESET}                               ${BOLD}${CYAN}║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════╝${RESET}`);
  const stateColor = sessionState === 'running' ? GREEN : RED;
  console.log(`  Session: ${BOLD}${sessionName}${RESET}  Command: ${sessionCommand}  PID: ${sessionPid}`);
  console.log(`  State: ${stateColor}${sessionState}${RESET}  Lines: ${lineCount}  Port: ${port}`);
  console.log(`${DIM}${'─'.repeat(56)}${RESET}`);
}

function printLine(line: string, prefix?: string): void {
  const p = prefix ? `${DIM}${prefix}${RESET} ` : '';
  // Strip ANSI for cleaner monitor view
  const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
  if (clean.trim().length > 0) {
    console.log(`${p}${clean}`);
  }
}

let buf = '';
socket.on('data', (data) => {
  buf += data.toString();
  const parts = buf.split('\n');
  buf = parts.pop() ?? '';

  for (const part of parts) {
    if (!part.trim()) continue;
    try {
      const msg = JSON.parse(part);
      handleMessage(msg);
    } catch { /* ignore */ }
  }
});

function handleMessage(msg: {
  type: string;
  name?: string;
  command?: string;
  pid?: number;
  bufferSize?: number;
  state?: string;
  exitCode?: number;
  line?: string;
  lines?: string[];
}): void {
  switch (msg.type) {
    case 'hello':
      sessionName = msg.name ?? '';
      sessionCommand = msg.command ?? '';
      sessionPid = msg.pid ?? 0;
      lineCount = msg.bufferSize ?? 0;
      renderHeader();
      // Request initial lines
      if (requestLines) {
        socket.write(JSON.stringify({ type: 'get_ring', n: requestLines }) + '\n');
      }
      break;

    case 'state':
      sessionState = msg.state ?? 'unknown';
      renderHeader();
      if (msg.state === 'exited') {
        console.log(`\n${RED}${BOLD}● Agent exited (code: ${msg.exitCode})${RESET}`);
        setTimeout(() => process.exit(0), 1000);
      }
      break;

    case 'ring':
      if (msg.lines && msg.lines.length > 0) {
        console.log(`${DIM}── scrollback log (${msg.lines.length} lines) ──${RESET}`);
        for (const line of msg.lines) {
          console.log(`${DIM}│${RESET} ${line}`);
        }
        console.log(`${DIM}── end scrollback ──${RESET}`);
        console.log(`${DIM}${'─'.repeat(56)}${RESET}`);
        console.log(`${YELLOW}Live viewport:${RESET}`);
      }
      break;

    case 'viewport':
      // Clean viewport snapshot — resolved through virtual terminal
      if (msg.lines && msg.lines.length > 0) {
        lineCount += msg.lines.length;
        for (const line of msg.lines) {
          console.log(`${DIM}▸${RESET} ${line}`);
        }
      }
      break;

    case 'output':
      // Legacy raw output (kept for backward compat)
      lineCount++;
      if (msg.line) printLine(msg.line, '▸');
      break;
  }
}

socket.on('error', (err) => {
  console.error(`${RED}Connection error: ${err.message}${RESET}`);
  console.error(`Make sure test-pty is running with --monitor`);
  process.exit(1);
});

socket.on('close', () => {
  console.log(`\n${DIM}[monitor] Connection closed${RESET}`);
  process.exit(0);
});

// Handle Ctrl+C
process.on('SIGINT', () => {
  socket.destroy();
  process.exit(0);
});

console.log(`${DIM}Connecting to monitor on port ${port}...${RESET}`);
