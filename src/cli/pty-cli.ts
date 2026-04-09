#!/usr/bin/env node

/**
 * Minimal PTY wrapper CLI with command mode.
 *
 * Normal mode:  Keystrokes passthrough to agent PTY transparently.
 * Command mode: Ctrl+\ toggles. Overlay prompt on last row, PTY output paused.
 *               /cancel sends Ctrl+C, /quit exits, Escape returns to normal.
 *
 * Usage:
 *   npx tsx src/cli/pty-cli.ts <command> [args...]
 *   npx tsx src/cli/pty-cli.ts copilot
 */

import { PtySpawn } from '../core/pty-spawn.js';

// --- ANSI helpers ---
const ESC = '\x1b';
const CSI = `${ESC}[`;
const DIM = `${CSI}2m`;
const RESET = `${CSI}0m`;
const CYAN = `${CSI}36m`;
const YELLOW = `${CSI}33m`;
const BOLD = `${CSI}1m`;
const CLEAR_LINE = `${CSI}2K`;
const SHOW_CURSOR = `${CSI}?25h`;

const CTRL_BACKSLASH = '\x1c'; // Ctrl+\ raw byte

// --- Win32 input mode parser ---
// When a TUI app enables Win32 input mode (ESC[?9001h), the terminal sends
// keystrokes as: ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
interface Win32KeyEvent {
  vk: number;   // virtual key code
  uc: number;   // unicode character
  kd: boolean;  // key down
  cs: number;   // control key state
}

const W32_RE = /^\x1b\[(\d+);\d+;(\d+);(\d+);(\d+);\d+_$/;

function parseWin32Key(str: string): Win32KeyEvent | null {
  const m = str.match(W32_RE);
  if (!m) return null;
  return { vk: +m[1], uc: +m[2], kd: m[3] === '1', cs: +m[4] };
}

/** Extract a usable character from raw input or Win32 input event. */
function extractKey(data: Buffer): { char: string; isToggle: boolean; isW32: boolean } {
  const str = data.toString();

  // Raw byte: Ctrl+\ (works when Win32 input mode is NOT active)
  if (str === CTRL_BACKSLASH) {
    return { char: '', isToggle: true, isW32: false };
  }

  // Win32 input mode event
  const evt = parseWin32Key(str);
  if (evt) {
    if (!evt.kd) return { char: '', isToggle: false, isW32: true }; // key-up — ignore
    if (evt.uc === 0x1c) return { char: '', isToggle: true, isW32: true }; // Ctrl+backslash
    if (evt.vk === 27) return { char: ESC, isToggle: false, isW32: true }; // Escape
    if (evt.uc === 13) return { char: '\r', isToggle: false, isW32: true }; // Enter
    if (evt.uc === 8) return { char: '\x7f', isToggle: false, isW32: true }; // Backspace
    if (evt.uc >= 32) return { char: String.fromCharCode(evt.uc), isToggle: false, isW32: true };
    return { char: '', isToggle: false, isW32: true }; // modifier-only
  }

  // Plain byte(s)
  return { char: str, isToggle: false, isW32: false };
}

// --- Parse args ---
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: pty-cli <command> [args...]');
  console.error('  e.g. pty-cli copilot');
  process.exit(1);
}
const command = args[0];
const commandArgs = args.slice(1);

// --- Terminal dimensions ---
const totalRows = process.stdout.rows ?? 24;
const totalCols = process.stdout.columns ?? 80;

// --- State ---
let commandMode = false;
let inputBuffer = '';
let pausedOutput: string[] = [];

// --- Create PTY (full terminal size — no reserved rows) ---
const pty = new PtySpawn({
  command,
  args: commandArgs,
  cols: totalCols,
  rows: totalRows,
});

// --- ANSI cursor helpers ---

function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}

function saveCursor(): string { return `${ESC}7`; }
function restoreCursor(): string { return `${ESC}8`; }

// --- Overlay rendering (command mode only) ---

function showOverlay(): void {
  // "[CMD] > " = 8 visible chars, columns are 1-based
  const cursorCol = 9 + inputBuffer.length;
  process.stdout.write(
    saveCursor() +
    moveTo(totalRows, 1) + CLEAR_LINE +
    `${YELLOW}${BOLD}[CMD]${RESET} ${CYAN}> ${RESET}${inputBuffer}` +
    moveTo(totalRows, cursorCol) + SHOW_CURSOR
  );
}

function clearOverlay(): void {
  process.stdout.write(
    moveTo(totalRows, 1) + CLEAR_LINE + restoreCursor()
  );
}

function enterCommandMode(): void {
  commandMode = true;
  inputBuffer = '';
  pausedOutput = [];
  showOverlay();
}

function exitCommandMode(): void {
  commandMode = false;
  inputBuffer = '';
  clearOverlay();
  // Flush buffered PTY output
  if (pausedOutput.length > 0) {
    for (const chunk of pausedOutput) {
      process.stdout.write(chunk);
    }
    pausedOutput = [];
  }
}

// --- Input handling ---

function handlePassthroughKey(data: Buffer): void {
  const { isToggle } = extractKey(data);

  if (isToggle) {
    enterCommandMode();
    return;
  }

  // Forward ORIGINAL bytes so Win32 input events pass through intact to the TUI
  pty.writeRaw(data.toString());
}

function handleCommandKey(data: Buffer): void {
  const { char, isToggle } = extractKey(data);

  if (isToggle) {
    exitCommandMode();
    return;
  }

  // Win32 key-up or modifier-only events produce empty char — ignore
  if (!char) return;

  // Escape — back to passthrough
  if (char === ESC) {
    exitCommandMode();
    return;
  }

  // Enter — submit
  if (char === '\r' || char === '\n') {
    const text = inputBuffer.trim();
    inputBuffer = '';

    if (!text) {
      showOverlay();
      return;
    }

    // Local commands
    if (text === '/quit' || text === '/exit') {
      cleanup();
      process.exit(0);
    }

    if (text === '/cancel') {
      pty.sendKey('ctrl-c');
      exitCommandMode();
      return;
    }

    if (text === '/help') {
      process.stdout.write(
        saveCursor() +
        moveTo(totalRows - 1, 1) + CLEAR_LINE +
        `${DIM}/cancel  /quit  /help  or type text to send  Esc=back${RESET}`
      );
      showOverlay();
      return;
    }

    // Send text to agent, then exit command mode
    exitCommandMode();
    pty.sendText(text);
    return;
  }

  // Backspace
  if (char === '\x7f' || char === '\b') {
    if (inputBuffer.length > 0) {
      inputBuffer = inputBuffer.slice(0, -1);
      showOverlay();
    }
    return;
  }

  // Ignore remaining control chars and escape sequences
  if (char.charCodeAt(0) < 32 || char.startsWith(ESC)) {
    return;
  }

  // Regular character
  inputBuffer += char;
  showOverlay();
}

// --- Setup ---

function setup(): void {
  // Raw mode for key capture
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Route stdin
  process.stdin.on('data', (data: Buffer) => {
    if (commandMode) {
      handleCommandKey(data);
    } else {
      handlePassthroughKey(data);
    }
  });

  // PTY output
  pty.on('data', (data: string) => {
    if (commandMode) {
      // Buffer output while in command mode — prevents TUI from overwriting overlay
      pausedOutput.push(data);
    } else {
      process.stdout.write(data);
    }
  });

  pty.on('exit', ({ exitCode }) => {
    cleanup();
    console.log(`\n${DIM}[pty-cli] Agent exited (code ${exitCode})${RESET}`);
    process.exit(exitCode);
  });

  // Startup hint
  process.stderr.write(`${DIM}[pty-cli] Ctrl+\\ = command mode${RESET}\n`);

  pty.spawn();
}

function cleanup(): void {
  process.stdout.write(SHOW_CURSOR);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
}

// Graceful shutdown
let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) process.exit(130);
  shuttingDown = true;
  cleanup();
  pty.kill();
  setTimeout(() => process.exit(130), 2000);
});
process.on('SIGTERM', () => {
  cleanup();
  pty.kill();
  process.exit(0);
});

// Go
setup();
