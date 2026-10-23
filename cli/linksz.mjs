#!/usr/bin/env node
// Linksz from the desktop, for the shortcuts the desktop install binds and for
// scripts. It talks to the same backend as the app, with a session of its own.
//
//   linksz login           sign this computer's shortcuts in, with the vault's key
//   linksz logout          sign them out
//   linksz pick            find a link in the Omarchy menu and open it
//   linksz save [url]      save a link (the copied one when none is given) to Temporary
//   linksz search <words>  print what matches, one "title<TAB>url" per line
//
// No dependencies: Node built-ins, plus the desktop's own commands, looked up
// on PATH (omarchy-menu-select, wl-paste, notify-send, xdg-open).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const TEMP_FOLDER = 'Temporary';
const DEVICE = 'Desktop shortcuts';
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'linksz');
const CONFIG = path.join(CONFIG_DIR, 'cli.json');
// Rows handed to the menu. Past this, the least used are left out: the menu
// takes its options on a command line, which has a length limit.
const PICK_MAX = 4000;

/* ---------------- plumbing ---------------- */

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // The token is a session: readable by this user only, like an ssh key.
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(CONFIG, 0o600);
}

const server = () => (process.env.LINKSZ_URL || loadConfig().server || 'http://localhost:8080').replace(/\/+$/, '');

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(p, { method = 'GET', body, token = loadConfig().token } = {}) {
  let res;
  try {
    res = await fetch(server() + p, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(`Linksz is not answering on ${server()}`, 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `error ${res.status}`, res.status);
  return data;
}

const has = (cmd) => spawnSync('sh', ['-c', `command -v "$1" >/dev/null`, 'sh', cmd]).status === 0;

// A desktop notification when there is a desktop to show it, the terminal
// otherwise. Never the reason a command fails.
function notify(title, body = '', { error = false } = {}) {
  if (has('notify-send')) {
    spawnSync('notify-send', ['-a', 'Linksz', ...(error ? ['-u', 'critical'] : []), title, body]);
  }
  (error ? console.error : console.log)(body ? `${title}: ${body}` : title);
}

function openUrl(url) {
  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => notify('Could not open the link', url, { error: true }));
  child.unref();
}

// No session yet: from a shortcut there is no terminal to ask in, so one is
// opened for the login.
function needLogin() {
  const self = process.env.LINKSZ_BIN || 'linksz';
  if (!process.stdin.isTTY && has('omarchy-launch-floating-terminal-with-presentation')) {
    spawn('omarchy-launch-floating-terminal-with-presentation', [`${self} login`], { detached: true, stdio: 'ignore' }).unref();
  }
  notify('Sign the shortcuts in first', `Run: ${self} login`, { error: true });
  return 1;
}

/* ---------------- links ---------------- */

// A link as typed or copied: one line, http(s), or a bare domain that gets
// https in front, the way the app's own paste does.
export function linkFrom(text) {
  const line = String(text || '').trim().split(/\s+/)[0] || '';
  if (/^https?:\/\/[^\s/]+\.[^\s]+/i.test(line) || /^https?:\/\/localhost\b/i.test(line)) return line;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(line)) return `https://${line}`;
  return '';
}

// Pinned first, in their order; then by how often and how lately each was
// opened; what was never opened after that, newest first.
export function pickOrder(items) {
  return [...items].sort((a, b) => {
    const pa = a.pinned > 0 ? a.pinned : Infinity;
    const pb = b.pinned > 0 ? b.pinned : Infinity;
    if (pa !== pb) return pa - pb;
    return (b.opens || 0) - (a.opens || 0) || (b.last_open_at || 0) - (a.last_open_at || 0)
      || (b.created_at || 0) - (a.created_at || 0);
  });
}

const oneLine = (s) => String(s || '').replace(/[\t\r\n]+/g, ' ').trim();

// One menu row: "<glyph><TAB><title><TAB><subtext>". The menu searches the
// subtext as well, so the folder and the address are findable too.
export function pickRow(b) {
  const glyph = b.pinned > 0 ? '★' : '';
  let host = '';
  try { host = new URL(b.url).hostname.replace(/^www\./, ''); } catch { /* no url */ }
  const title = oneLine(b.title) || host || oneLine(b.url);
  const where = oneLine(b.folder) || 'Unfiled';
  return `${glyph}\t${title}\t${where} · ${oneLine(b.url)}`;
}

/* ---------------- commands ---------------- */

async function readKey() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  process.stdout.write('Access key of the vault (it is not shown): ');
  process.stdin.setRawMode(true);
  let key = '';
  for await (const chunk of process.stdin) {
    for (const ch of chunk.toString('utf8')) {
      if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdout.write('\n'); return key.trim(); }
      if (ch === '\u0003') { process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
      if (ch === '\u007f') key = key.slice(0, -1); else key += ch;
    }
  }
  return key.trim();
}

const commands = {
  async login() {
    const key = await readKey();
    if (!key) { console.error('No key given.'); return 1; }
    const r = await api('/api/auth/key', { method: 'POST', body: { key, device: DEVICE }, token: '' });
    saveConfig({ server: server(), token: r.token });
    console.log(`Signed in to ${r.user?.name || 'the vault'} on ${server()}. It shows in Settings as “${DEVICE}”.`);
    return 0;
  },

  async logout() {
    const cfg = loadConfig();
    if (cfg.token) await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    fs.rmSync(CONFIG, { force: true });
    console.log('Signed out.');
    return 0;
  },

  async pick() {
    if (!loadConfig().token) return needLogin();
    const { items } = await api(`/api/bookmarks?limit=${PICK_MAX}`);
    const links = pickOrder(items.filter((b) => /^https?:/i.test(b.url || ''))).slice(0, PICK_MAX);
    if (!links.length) { notify('No links yet', 'Save one first'); return 0; }
    const rows = links.map(pickRow);
    const menu = spawnSync('omarchy-menu-select', ['Linksz'], { input: `${rows.join('\n')}\n`, encoding: 'utf8' });
    if (menu.error) { notify('The Omarchy menu is not here', 'omarchy-menu-select was not found', { error: true }); return 1; }
    const chosen = String(menu.stdout || '').replace(/\n$/, '');
    if (!chosen) return 0;
    // The menu gives back "<title><TAB><subtext>": the row without its glyph.
    const i = rows.findIndex((r) => r.slice(r.indexOf('\t') + 1) === chosen);
    if (i < 0) return 0;
    const b = links[i];
    openUrl(b.url);
    await api('/api/bookmarks/open', { method: 'POST', body: { id: b.id } }).catch(() => {});
    return 0;
  },

  async save(arg) {
    if (!loadConfig().token) return needLogin();
    let text = arg;
    if (!text) {
      const paste = spawnSync('wl-paste', ['--no-newline'], { encoding: 'utf8' });
      text = paste.error ? '' : paste.stdout;
    }
    const url = linkFrom(text);
    if (!url) { notify('Nothing to save', 'What was copied is not a link', { error: true }); return 1; }

    const same = await api(`/api/bookmarks?url=${encodeURIComponent(url)}`);
    if (same.items.length) {
      const where = same.items.map((b) => b.folder || 'Unfiled').join(', ');
      notify('Already saved', `${same.items[0].title || url} is in ${where}`);
      return 0;
    }
    let title = '';
    try { title = (await api(`/api/title?url=${encodeURIComponent(url)}`)).title || ''; } catch { /* the address will do */ }
    if (!title) { try { title = new URL(url).hostname.replace(/^www\./, ''); } catch { title = url; } }
    await api('/api/bookmarks', { method: 'POST', body: { url, title, folder: TEMP_FOLDER } });
    notify(`Saved to ${TEMP_FOLDER}`, title);
    return 0;
  },

  async search(...words) {
    if (!loadConfig().token) return needLogin();
    const q = words.join(' ');
    const { items } = await api(`/api/bookmarks?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    for (const b of items) console.log(`${oneLine(b.title)}\t${b.url}`);
    return 0;
  },
};

async function main(argv) {
  const [name, ...args] = argv;
  const run = commands[name];
  if (!run) {
    console.error('Usage: linksz [login | logout | pick | save [url] | search <words>]');
    return name ? 2 : 0;
  }
  try {
    return await run(...args);
  } catch (err) {
    // A session signed out from Settings: the next shortcut asks again.
    if (err.status === 401 && name !== 'login') {
      fs.rmSync(CONFIG, { force: true });
      return needLogin();
    }
    notify('Linksz', err.message, { error: true });
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main(process.argv.slice(2));
}
