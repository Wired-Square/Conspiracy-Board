#!/usr/bin/env node
// The phase 11 performance scenario: launch the dev app on a throwaway library, drive a
// fixed script through the dev harness, and save the meter's report next to the library.
//
//   node scripts/perf-scenario.mjs --seed <dir>             seed a fresh library at <dir>
//   node scripts/perf-scenario.mjs --clone <source> <dir>   run on an APFS clone of <source>
//
// IDLE_TICKS=<n> sets how many 30 s ticks it idles for at the end (4 by default).
//
// Never point either at the real library: <dir> is replaced on every run.

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = [1420, 8792, 8793];
const HARNESS = 'http://127.0.0.1:8792/mcp';
const HTTP_CAP_MS = 30_000;
const LAUNCH_CAP_MS = 15 * 60_000;
const BOARD_CAP_MS = 180_000;
const IDLE_TICKS = Number(process.env.IDLE_TICKS ?? 4);
// WebKit checks its memory every 30 s and, over its threshold, releases it on the main thread.
const TICK_MS = 30_000;
const FLUSH_WAIT_MS = 3_000;
const STOP_CAP_MS = 15_000;
// Activating the window stalls its first frames, so the clock starts once it has settled.
const SETTLE_MS = 5_000;

// tauri dev and the seed need cargo, which a non-login shell may not have on PATH.
const ENV = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

function parseArgs([mode, ...rest]) {
  if (mode === '--seed' && rest.length === 1) return { lib: path.resolve(rest[0]) };
  if (mode === '--clone' && rest.length === 2) return { source: path.resolve(rest[0]), lib: path.resolve(rest[1]) };
  console.error('usage: perf-scenario.mjs --seed <dir> | --clone <source> <dir>');
  process.exit(2);
}

function listening(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

// Only a library this script made is ever replaced, so a mistyped path can't wipe a real one.
const MARK = '.perf-scenario';

function prepareLibrary({ source, lib }) {
  if (existsSync(lib)) {
    if (!existsSync(path.join(lib, MARK))) {
      console.error(`${lib} exists and wasn't made by this script; pick a fresh directory.`);
      process.exit(2);
    }
    rmSync(lib, { recursive: true });
  }
  mkdirSync(path.dirname(lib), { recursive: true });
  if (source) {
    execFileSync('cp', ['-c', '-R', source, lib]);
    // The clone's library MCP would claim 8793 with the installed app's Keychain token.
    execFileSync('sqlite3', [path.join(lib, 'library.sqlite'), "DELETE FROM library_state WHERE key LIKE 'library_mcp%'"]);
  } else {
    execFileSync('cargo', ['test', '--lib', 'seed_library_for_the_scenario', '--', '--ignored'], {
      cwd: path.join(ROOT, 'src-tauri'),
      env: { ...ENV, CONSPIRACY_SEED_DIR: lib },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  }
  writeFileSync(path.join(lib, MARK), '');
}

class Harness {
  constructor(token) {
    this.token = token;
    this.session = null;
    this.id = 0;
  }

  async post(body) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}`,
      ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
    };
    const res = await fetch(HARNESS, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(HTTP_CAP_MS) });
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    this.session ??= res.headers.get('mcp-session-id');
    const text = await res.text();
    const data = text.split('\n').find((line) => line.startsWith('data: {'));
    return data ? JSON.parse(data.slice(6)) : text.trim().startsWith('{') ? JSON.parse(text) : null;
  }

  async connect() {
    await this.post({
      jsonrpc: '2.0',
      id: ++this.id,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'perf-scenario', version: '1' } },
    });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async call(name, args = {}) {
    const reply = await this.post({ jsonrpc: '2.0', id: ++this.id, method: 'tools/call', params: { name, arguments: args } });
    const result = reply?.result;
    const text = result?.content?.map((c) => c.text).join('') ?? JSON.stringify(reply);
    if (!result || result.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
    return result.structuredContent ?? JSON.parse(text);
  }
}

async function until(what, capMs, check) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (e) {
      if (e.fatal) throw e;
    }
    if (Date.now() - started > capMs) throw new Error(`timed out after ${capMs / 1000} s waiting for ${what}`);
    await sleep(1000);
  }
}

function webContentPids() {
  try {
    return execFileSync('pgrep', ['-f', 'com.apple.WebKit.WebContent']).toString().trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Physical footprint in MB of the WebContent processes that appeared since launch. */
function footprintMb(pids) {
  return pids.map((pid) => {
    try {
      const out = execFileSync('footprint', ['-p', pid], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).toString();
      const match = out.match(/Footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
      const scale = { KB: 1 / 1024, MB: 1, GB: 1024 }[match?.[2]] ?? NaN;
      return { pid, mb: match ? Math.round(Number(match[1]) * scale) : null };
    } catch {
      return { pid, mb: null };
    }
  });
}

async function drive(h, out) {
  const view = async (label) => {
    await h.call('click', { selector: '.toolbar button[aria-label^="View:"]' });
    await h.call('wait_for', { selector: '[role=menuitemradio]', text: label, state: 'visible', timeout_ms: 5000 });
    await h.call('click', { selector: '[role=menuitemradio]', text: label });
  };
  const editorOpen = () => h.call('wait_for', { selector: 'dialog[aria-label="Edit card"]', state: 'visible', timeout_ms: 10_000 });
  const closeEditor = async () => {
    await h.call('click', { selector: 'dialog[aria-label="Edit card"] [aria-label="Close"]' });
    await h.call('wait_for', { selector: 'dialog[aria-label="Edit card"]', state: 'gone', timeout_ms: 10_000 });
  };
  const settle = () => sleep(1500);
  const count = async (selector) => (await h.call('query', { selector })).matches.length;
  const dom = async (...selectors) => {
    const counts = {};
    for (const selector of selectors) counts[selector] = await count(`${selector} *`);
    return counts;
  };

  out.dom = { board: await dom('body', '.board-canvas', '.timeline') };
  log('record view and back');
  await view('Record');
  await h.call('wait_for', { selector: '.record-row', state: 'visible', timeout_ms: 30_000 });
  await settle();
  out.dom.record = await dom('body', '.board-canvas', '.record', '.timeline');
  await view('Board');
  await h.call('wait_for', { selector: '.record', state: 'gone', timeout_ms: 30_000 });
  await settle();

  await view('Record');
  await h.call('wait_for', { selector: '.record-row', state: 'visible', timeout_ms: 30_000 });
  await settle();
  log('open a card editor five times');
  for (let i = 0; i < 5; i++) {
    await h.call('click', { selector: '.record-row', index: i });
    await editorOpen();
    await settle();
    await closeEditor();
    await settle();
  }

  // Undo is the toast's button after each delete: the harness's `press` sends no
  // modifiers, so Cmd+Z can't be sent, and the toast offers only the latest delete.
  log('delete five cards, undoing each');
  for (let i = 0; i < 5; i++) {
    const before = (await h.call('board_summary')).cards;
    await h.call('click', { selector: '.record-row', index: 0 });
    await editorOpen();
    await h.call('click', { selector: 'dialog[aria-label="Edit card"] .card-delete', text: 'Delete card' });
    await h.call('click', { selector: 'dialog[aria-label="Edit card"] .card-delete', text: 'Really delete?' });
    await until('the delete', 30_000, async () => (await h.call('board_summary')).cards === before - 1);
    await settle();
    await h.call('click', { selector: '.undo-toast button', text: 'Undo' });
    await until('the undo', 30_000, async () => (await h.call('board_summary')).cards === before);
    await settle();
  }

  await view('Board');
  await h.call('wait_for', { selector: '.record', state: 'gone', timeout_ms: 30_000 });
  await sleep(FLUSH_WAIT_MS);
  out.beforeIdle = await h.call('perf_report');
  out.footprintBeforeIdle = footprintMb(out.webContent);
  log(`idle ${(IDLE_TICKS * TICK_MS) / 1000} s`);
  const idleFrom = Date.now();
  out.footprintIdle = [];
  for (let tick = 0; tick < IDLE_TICKS; tick++) {
    await sleep(TICK_MS);
    out.footprintIdle.push(footprintMb(out.webContent));
  }
  out.idle = { from: idleFrom, to: Date.now() };
  await sleep(FLUSH_WAIT_MS);
  out.report = await h.call('perf_report');
}

/** Frame gaps over 50 ms the idle window added, and those over 250 ms that the dev log names. */
function idleGaps(out, logText) {
  const gaps = (report) => report.ops.find((o) => o.name === 'ui:frame gap')?.count ?? 0;
  const day = new Date(out.idle.from).toISOString().slice(0, 10);
  const logged = [...logText.matchAll(/\[(\d\d:\d\d:\d\d)\]\[[^\]]+\]\[WARN\] \[perf\] ui:frame gap took (\d+) ms/g)]
    .map(([, time, ms]) => ({ at: Date.parse(`${day}T${time}Z`), ms: Number(ms) }))
    .filter(({ at }) => at >= out.idle.from - 1000 && at <= out.idle.to + 1000);
  return { count: gaps(out.report) - gaps(out.beforeIdle), over250Ms: logged.map((g) => g.ms) };
}

function stop(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      resolve();
    }, STOP_CAP_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function main() {
  const target = parseArgs(process.argv.slice(2));
  const busy = PORTS.map((port) => [port, listening(port)]).filter(([, pids]) => pids);
  if (busy.length) {
    console.error(`Ports in use, so nothing was started: ${busy.map(([p, pids]) => `${p} (pid ${pids.replace(/\n/g, ', ')})`).join('; ')}`);
    process.exit(1);
  }

  log(target.source ? 'cloning the library' : 'seeding the library');
  prepareLibrary(target);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(path.dirname(target.lib), `perf-${path.basename(target.lib)}-${stamp}.json`);
  const logPath = reportPath.replace(/\.json$/, '.log');

  const token = randomBytes(24).toString('hex');
  const before = new Set(webContentPids());
  const logFd = openSync(logPath, 'w');
  log(`launching pnpm dev (log ${logPath})`);
  const child = spawn('pnpm', ['dev'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...ENV, CONSPIRACY_LIBRARY_DIR: target.lib, CONSPIRACY_MCP_TOKEN: token },
  });
  const out = { library: target.source ? 'clone' : 'seeded', startedAt: new Date().toISOString() };
  let failed = null;
  try {
    const h = new Harness(token);
    await until('the dev harness', LAUNCH_CAP_MS, async () => {
      if (child.exitCode !== null) throw Object.assign(new Error('pnpm dev exited'), { fatal: true });
      await h.connect();
      return true;
    });
    const summary = await until('the board', BOARD_CAP_MS, async () => {
      const s = await h.call('board_summary');
      return s.cards > 0 && s;
    });
    log(`board open: ${summary.cards} cards, ${summary.connections} connections, ${summary.clusters} clusters`);
    out.board = { cards: summary.cards, connections: summary.connections, clusters: summary.clusters };
    await until('the extraction queue', BOARD_CAP_MS, async () => (await h.call('jobs_pending')).pending === 0);
    execFileSync('osascript', ['-e', 'tell application "System Events" to set frontmost of (first process whose name contains "onspiracy") to true']);
    out.webContent = webContentPids().filter((pid) => !before.has(pid));
    await sleep(SETTLE_MS);
    out.footprintOpen = footprintMb(out.webContent);
    out.launch = await h.call('perf_report');
    await h.call('perf_reset');
    await drive(h, out);
    out.idleGaps = idleGaps(out, readFileSync(logPath, 'utf8'));
  } catch (e) {
    failed = e;
  } finally {
    log('stopping');
    await stop(child);
  }
  writeFileSync(reportPath, JSON.stringify(out, null, 2));
  const left = PORTS.map((port) => [port, listening(port)]).filter(([, pids]) => pids);
  if (left.length) console.error(`Still listening after the stop: ${left.map(([p, pids]) => `${p} (${pids})`).join('; ')}`);
  if (failed) {
    console.error(`Scenario failed: ${failed.message}`);
    process.exit(1);
  }
  log(`idle frame gaps over 50 ms: ${out.idleGaps.count}`);
  log(`report: ${reportPath}`);
}

await main();
