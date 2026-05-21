#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const API_URL = 'http://127.0.0.1:3900/health';
const FRONTEND_URL = 'http://127.0.0.1:3901';
const HEALTH_INTERVAL_MS = 15_000;

let shuttingDown = false;
let publicUrl = '';

function log(scope, message) {
  const stamp = new Date().toLocaleTimeString();
  process.stdout.write(`[${stamp}] ${scope.padEnd(10)} ${message}\n`);
}

function pipeLines(stream, scope, onLine) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      onLine?.(line);
      log(scope, line);
    }
  });
}

class Service {
  constructor(name, command, args, options = {}) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.options = options;
    this.child = null;
    this.restartCount = 0;
  }

  start() {
    if (shuttingDown || this.child) return;
    log(this.name, `starting: ${this.command} ${this.args.join(' ')}`);
    const child = spawn(this.command, this.args, {
      cwd: root,
      env: { ...process.env, ...this.options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    pipeLines(child.stdout, this.name, this.options.onLine);
    pipeLines(child.stderr, this.name, this.options.onLine);
    child.once('error', (error) => {
      log(this.name, `failed to start: ${error.message}`);
      this.child = null;
      this.scheduleRestart();
    });
    child.once('exit', (code, signal) => {
      this.child = null;
      if (shuttingDown) return;
      log(this.name, `exited (${signal || code}); restarting`);
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (shuttingDown) return;
    this.restartCount += 1;
    const delay = Math.min(1500 * this.restartCount, 8000);
    setTimeout(() => this.start(), delay);
  }

  restart(reason) {
    if (reason) log(this.name, `restart requested: ${reason}`);
    this.restartCount = 0;
    if (!this.child) {
      this.start();
      return;
    }
    this.child.kill('SIGTERM');
    setTimeout(() => {
      if (this.child) this.child.kill('SIGKILL');
    }, 5000);
  }

  stop() {
    if (!this.child) return;
    this.child.kill('SIGTERM');
  }
}

async function runOnce(name, command, args, options = {}) {
  log(name, `running: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeLines(child.stdout, name, options.onLine);
  pipeLines(child.stderr, name, options.onLine);
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) {
    throw new Error(`${name} failed (${signal || code})`);
  }
}

const api = new Service('api', 'uv', [
  'run',
  'uvicorn',
  'main:app',
  '--app-dir',
  'backend',
  '--host',
  '127.0.0.1',
  '--port',
  '3900',
  '--reload',
]);

const frontend = new Service('frontend', 'bun', ['run', '--cwd', 'frontend', 'dev', '--', '--host', '0.0.0.0']);

const tunnel = new Service('tunnel', 'cloudflared', ['tunnel', '--protocol', 'http2', '--url', FRONTEND_URL], {
  onLine(line) {
    const match = line.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
    if (match && match[0] !== publicUrl) {
      publicUrl = match[0];
      log('public', `open from other devices: ${publicUrl}`);
    }
  },
});

async function waitFor(url, label, timeoutMs = 180_000) {
  const started = Date.now();
  while (!shuttingDown && Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return true;
    } catch {
      // keep waiting
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

async function isReady(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

async function watchdog() {
  while (!shuttingDown) {
    await new Promise(resolve => setTimeout(resolve, HEALTH_INTERVAL_MS));
    if (shuttingDown) return;

    try {
      const res = await fetch(API_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      if (api.child) api.restart(`health check failed at ${API_URL}`);
      else api.start();
    }

    try {
      const res = await fetch(FRONTEND_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      frontend.restart(`health check failed at ${FRONTEND_URL}`);
    }

    if (!tunnel.child) tunnel.start();
  }
}

async function main() {
  log('public', 'starting OmniVoice public preview');
  await runOnce('setup', 'bun', ['run', 'setup:api']);
  if (await isReady(API_URL)) {
    log('api', `already running at ${API_URL}`);
  } else {
    api.start();
    await waitFor(API_URL, 'backend');
    log('api', `ready at ${API_URL}`);
  }

  frontend.start();
  await waitFor(FRONTEND_URL, 'frontend');
  log('frontend', `ready at ${FRONTEND_URL}`);

  tunnel.start();
  watchdog();

  log('public', 'keep this terminal open to keep the local servers and public link alive');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('public', `received ${signal}; stopping services`);
    tunnel.stop();
    frontend.stop();
    api.stop();
    await Promise.race([
      Promise.all([
        tunnel.child ? once(tunnel.child, 'exit') : Promise.resolve(),
        frontend.child ? once(frontend.child, 'exit') : Promise.resolve(),
        api.child ? once(api.child, 'exit') : Promise.resolve(),
      ]),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
    process.exit(0);
  });
}

main().catch((error) => {
  log('public', error.message);
  process.exitCode = 1;
});
