#!/usr/bin/env node

/**
 * Test CLI for copilot-remote PTY spawn.
 *
 * Usage:
 *   npx tsx src/cli/test-pty.ts <command> [args...]
 *   npx tsx src/cli/test-pty.ts --record <command> [args...]
 *   npx tsx src/cli/test-pty.ts --monitor <command> [args...]   # auto-launch monitor terminal
 *   npx tsx src/cli/test-pty.ts --replay <file>
 *
 * Examples:
 *   npx tsx src/cli/test-pty.ts copilot                          # Just PTY passthrough
 *   npx tsx src/cli/test-pty.ts --record --monitor copilot       # Record + monitor window
 *   npx tsx src/cli/test-pty.ts --replay ~/.copilot-remote/recordings/session.jsonl
 */

import { PtySpawn } from '../core/index.js';
import { MonitorServer } from '../core/monitor-server.js';
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn as cpSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let record = false;
  let replay: string | null = null;
  let name = 'test';
  let monitor = false;
  let monitorPort = 0; // 0 = auto-assign

  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--record') {
      record = true;
    } else if (args[i] === '--replay') {
      replay = args[++i];
    } else if (args[i] === '--name') {
      name = args[++i];
    } else if (args[i] === '--monitor') {
      monitor = true;
    } else if (args[i] === '--monitor-port') {
      monitor = true;
      monitorPort = parseInt(args[++i], 10);
    } else {
      filtered.push(args[i]);
    }
  }

  return { record, replay, name, monitor, monitorPort, command: filtered[0], args: filtered.slice(1) };
}

async function runReplay(filePath: string): Promise<void> {
  const rl = createInterface({ input: createReadStream(filePath) });
  let lastT = 0;

  for await (const line of rl) {
    const entry = JSON.parse(line);
    const delay = entry.t - lastT;
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    lastT = entry.t;

    switch (entry.type) {
      case 'spawn':
        console.log(`\x1b[2m[replay] Spawn: ${entry.command} ${entry.args.join(' ')} (${entry.cols}x${entry.rows})\x1b[0m`);
        break;
      case 'output':
        process.stdout.write(entry.data);
        break;
      case 'input':
        console.log(`\x1b[2m[replay] Input: ${JSON.stringify(entry.data)}\x1b[0m`);
        break;
      case 'resize':
        console.log(`\x1b[2m[replay] Resize: ${entry.cols}x${entry.rows}\x1b[0m`);
        break;
      case 'exit':
        console.log(`\x1b[2m[replay] Exit: code ${entry.code}\x1b[0m`);
        break;
    }
  }
}

async function runLive(command: string, args: string[], name: string, record: boolean, monitor: boolean, monitorPort: number): Promise<void> {
  if (!command) {
    console.error('Usage: test-pty [--record] [--monitor] [--name <name>] <command> [args...]');
    console.error('       test-pty --replay <file>');
    process.exit(1);
  }

  const ptySpawn = new PtySpawn({ command, args, name, record });

  let monitorServer: MonitorServer | undefined;

  // Tap: display output
  ptySpawn.on('data', (data: string) => {
    process.stdout.write(data);
  });

  // Tap: exit handler
  ptySpawn.on('exit', ({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    monitorServer?.stop();
    const reason = signal !== undefined ? `signal ${signal}` : `code ${exitCode}`;
    console.log(`\n\x1b[2m[copilot-remote] Agent exited (${reason})\x1b[0m`);
    if (record && ptySpawn.recordingPath) {
      console.log(`\x1b[2m[copilot-remote] Recording saved: ${ptySpawn.recordingPath}\x1b[0m`);
    }
    process.exit(exitCode);
  });

  ptySpawn.spawn();

  // Start monitor server if requested
  if (monitor) {
    monitorServer = new MonitorServer({ ptySpawn, name, command });
    const assignedPort = await monitorServer.start(monitorPort);
    console.log(`\x1b[2m[copilot-remote] Monitor server on port ${assignedPort}\x1b[0m`);
    launchMonitorTerminal(assignedPort);
  }

  // Raw mode stdin → PTY
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('data', (data: Buffer) => {
    ptySpawn.write(data.toString());
  });

  // Resize handling
  process.stdout.on('resize', () => {
    ptySpawn.resize(
      process.stdout.columns ?? 80,
      process.stdout.rows ?? 24,
    );
  });

  // Graceful shutdown
  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) process.exit(130);
    shuttingDown = true;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    monitorServer?.stop();
    ptySpawn.kill();
    setTimeout(() => process.exit(130), 2000);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function launchMonitorTerminal(port: number): void {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const monitorScript = join(thisDir, 'test-monitor.ts');
  const projectRoot = join(thisDir, '..', '..');

  if (process.platform === 'win32') {
    // Write a temp batch file, then use PowerShell Start-Process to open it
    // in a new window — avoids cmd.exe `start` quoting nightmares
    const batPath = join(tmpdir(), `copilot-remote-monitor-${port}.cmd`);
    writeFileSync(batPath, [
      '@echo off',
      `cd /d "${projectRoot}"`,
      `npx tsx "${monitorScript}" ${port}`,
      'pause',
    ].join('\r\n') + '\r\n');
    cpSpawn('powershell.exe', [
      '-NoProfile', '-Command',
      `Start-Process -FilePath "${batPath}"`,
    ], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    console.log(`\x1b[2m[copilot-remote] If monitor window didn't open, run manually:\n  npx tsx ${monitorScript} ${port}\x1b[0m`);
  } else {
    // Try common terminal emulators on Linux/macOS
    const term = process.env.TERM_PROGRAM;
    if (term === 'Apple_Terminal' || term === 'iTerm.app') {
      cpSpawn('open', ['-a', 'Terminal', '--args', `npx tsx "${monitorScript}" ${port}`], {
        detached: true, stdio: 'ignore',
      }).unref();
    } else {
      // Fallback: print instructions
      console.log(`\x1b[2m[copilot-remote] Open another terminal and run: npx tsx ${monitorScript} ${port}\x1b[0m`);
    }
  }
}

// Main
const parsed = parseArgs(process.argv);

if (parsed.replay) {
  runReplay(parsed.replay).catch(err => {
    console.error('Replay error:', err);
    process.exit(1);
  });
} else {
  runLive(parsed.command, parsed.args, parsed.name, parsed.record, parsed.monitor, parsed.monitorPort);
}
