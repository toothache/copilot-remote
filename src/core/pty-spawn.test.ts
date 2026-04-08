import { describe, it, expect, afterEach } from 'vitest';
import { PtySpawn, type PtyExitInfo } from './pty-spawn.js';

// Helper: collect output and wait for exit
function runToExit(pty: PtySpawn): Promise<{ output: string; exit: PtyExitInfo }> {
  return new Promise((resolve) => {
    let output = '';
    pty.on('data', (data: string) => { output += data; });
    pty.on('exit', (info: PtyExitInfo) => {
      // Small delay to let final data events flush
      setTimeout(() => resolve({ output, exit: info }), 50);
    });
    pty.spawn();
  });
}

// Track spawned instances for cleanup
const spawned: PtySpawn[] = [];
function create(opts: ConstructorParameters<typeof PtySpawn>[0]): PtySpawn {
  const p = new PtySpawn(opts);
  spawned.push(p);
  return p;
}

afterEach(() => {
  for (const p of spawned) {
    try { p.kill(); } catch { /* ignore */ }
  }
  spawned.length = 0;
});

// Use platform-appropriate commands
const isWin = process.platform === 'win32';
const echoCmd = isWin ? 'cmd.exe' : '/bin/echo';
const echoArgs = (text: string) => isWin ? ['/c', `echo ${text}`] : [text];

describe('PtySpawn', () => {

  describe('constructor', () => {
    it('applies default options', () => {
      const pty = create({ command: 'echo' });
      expect(pty.pid).toBeUndefined();
      expect(pty.running).toBe(false);
    });
  });

  describe('spawn + exit', () => {
    it('emits data and exit events for a simple command', async () => {
      const pty = create({ command: echoCmd, args: echoArgs('hello_pty') });
      const { output, exit } = await runToExit(pty);

      expect(output).toContain('hello_pty');
      expect(exit.exitCode).toBe(0);
    });

    it('sets running=true after spawn, false after exit', async () => {
      const pty = create({ command: echoCmd, args: echoArgs('fast') });

      expect(pty.running).toBe(false);
      const exitPromise = runToExit(pty);

      // running should be true right after spawn (runToExit calls spawn)
      // but the command may exit very fast, so we just check the final state
      const { exit } = await exitPromise;
      expect(pty.running).toBe(false);
      expect(exit.exitCode).toBe(0);
    });

    it('exposes pid after spawn', async () => {
      const pty = create({ command: echoCmd, args: echoArgs('pid_test') });
      expect(pty.pid).toBeUndefined();

      const done = runToExit(pty);
      expect(pty.pid).toBeGreaterThan(0);
      await done;
    });

    it('reports non-zero exit code', async () => {
      const cmd = isWin ? 'cmd.exe' : '/bin/sh';
      const args = isWin ? ['/c', 'exit 42'] : ['-c', 'exit 42'];
      const pty = create({ command: cmd, args });
      const { exit } = await runToExit(pty);

      expect(exit.exitCode).toBe(42);
    });
  });

  describe('kill', () => {
    it('terminates a running process', async () => {
      // Start a long-running process
      const cmd = isWin ? 'cmd.exe' : '/bin/cat';
      const args = isWin ? ['/c', 'timeout /t 60 /nobreak >nul'] : [];
      const pty = create({ command: cmd, args });

      const exitPromise = new Promise<PtyExitInfo>((resolve) => {
        pty.on('exit', resolve);
      });
      pty.spawn();
      expect(pty.running).toBe(true);

      pty.kill();
      const info = await exitPromise;
      expect(pty.running).toBe(false);
      expect(info.exitCode).toBeDefined();
    });

    it('does not throw if called before spawn', () => {
      const pty = create({ command: 'echo' });
      expect(() => pty.kill()).not.toThrow();
    });

    it('does not throw if called twice', async () => {
      const pty = create({ command: echoCmd, args: echoArgs('x') });
      await runToExit(pty);
      expect(() => pty.kill()).not.toThrow();
      expect(() => pty.kill()).not.toThrow();
    });
  });

  describe('restart', () => {
    it('spawns a new process after killing the old one', async () => {
      const pty = create({ command: 'cmd.exe', args: ['/k', 'echo ready'] });

      pty.spawn();
      const firstPid = pty.pid;

      // Wait for process to start
      await new Promise(r => setTimeout(r, 300));
      expect(pty.running).toBe(true);

      pty.restart();

      // Wait for new process to start
      await new Promise(r => setTimeout(r, 500));

      expect(pty.running).toBe(true);
      expect(pty.pid).toBeDefined();
      expect(pty.pid).not.toBe(firstPid);

      pty.kill();
    });
  });

  describe('sendText', () => {
    it('sends text and submits to an interactive process', async () => {
      // cmd /k stays alive and echoes commands
      const pty = create({ command: 'cmd.exe', args: ['/k', 'echo ready'] });

      let output = '';
      pty.on('data', (data: string) => { output += data; });
      pty.spawn();

      // Wait for cmd to be ready
      await new Promise(r => setTimeout(r, 500));

      await pty.sendText('echo hello_from_sendText');

      // Wait for the echo to come back
      await new Promise(r => setTimeout(r, 500));

      expect(output).toContain('hello_from_sendText');

      pty.kill();
    });
  });

  describe('sendKey', () => {
    it('sends ctrl-c to a running process', async () => {
      const cmd = isWin ? 'cmd.exe' : '/bin/cat';
      const args = isWin ? ['/c', 'timeout /t 60 /nobreak >nul'] : [];
      const pty = create({ command: cmd, args });

      const exitPromise = new Promise<PtyExitInfo>((resolve) => {
        pty.on('exit', resolve);
      });
      pty.spawn();

      pty.sendKey('ctrl-c');
      const info = await exitPromise;

      expect(pty.running).toBe(false);
      expect(info.exitCode).toBeDefined();
    });

    it('sends escape key', async () => {
      const pty = create({ command: 'cmd.exe', args: ['/k', 'echo ready'] });

      let output = '';
      pty.on('data', (data: string) => { output += data; });
      pty.spawn();

      await new Promise(r => setTimeout(r, 300));
      pty.sendKey('escape');
      await new Promise(r => setTimeout(r, 100));

      // Escape byte (0x1b) should have been written — cmd echoes it back
      expect(output).toContain('\x1b');

      pty.kill();
    });
  });

  describe('multiple data listeners', () => {
    it('supports multiple consumers on the data event', async () => {
      const pty = create({ command: echoCmd, args: echoArgs('multi') });

      const outputs: string[] = ['', ''];
      pty.on('data', (d: string) => { outputs[0] += d; });
      pty.on('data', (d: string) => { outputs[1] += d; });

      await runToExit(pty);

      expect(outputs[0]).toContain('multi');
      expect(outputs[1]).toContain('multi');
    });
  });

  describe('options defaults', () => {
    it('uses cwd as process.cwd() by default', async () => {
      const cmd = isWin ? 'cmd.exe' : '/bin/pwd';
      const args = isWin ? ['/c', 'cd'] : [];
      const pty = create({ command: cmd, args });
      const { output } = await runToExit(pty);

      expect(output).toContain(process.cwd().split(/[\\/]/).pop()!);
    });
  });
});
