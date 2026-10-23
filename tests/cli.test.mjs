// The command line the desktop shortcuts run, against a real backend on a
// throwaway vault. The desktop's own commands (the Omarchy menu, the
// clipboard, notifications, the browser) are stubs on PATH that write down
// what they were asked, so nothing here touches the session running the suite.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { linkFrom, pickOrder, pickRow } from '../cli/linksz.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'linksz.mjs');
const { createApp } = require('../api/server.js');

/* ---------------- the pure parts ---------------- */

test('a link is what was copied, with https in front of a bare domain', () => {
  assert.equal(linkFrom('  https://example.com/a?b=1 \n'), 'https://example.com/a?b=1');
  assert.equal(linkFrom('github.com/apolzek/linksz'), 'https://github.com/apolzek/linksz');
  assert.equal(linkFrom('http://localhost:8080/x'), 'http://localhost:8080/x');
  for (const nope of ['', 'just some words', 'ftp://example.com', 'javascript:alert(1)', 'nodot']) {
    assert.equal(linkFrom(nope), '', JSON.stringify(nope));
  }
});

test('the menu lists the pinned first, then the most used', () => {
  const items = [
    { id: 'old', opens: 0, created_at: 1 },
    { id: 'busy', opens: 9, created_at: 2 },
    { id: 'pin2', pinned: 2, created_at: 3 },
    { id: 'recent', opens: 9, last_open_at: 50, created_at: 4 },
    { id: 'pin1', pinned: 1, created_at: 5 },
    { id: 'new', opens: 0, created_at: 6 },
  ];
  assert.deepEqual(pickOrder(items).map((b) => b.id), ['pin1', 'pin2', 'recent', 'busy', 'new', 'old']);
});

test('a row carries a glyph for the pinned, and no tab or newline of its own', () => {
  assert.equal(pickRow({ title: 'A\ttitle\nhere', url: 'https://www.example.com/x', folder: 'dev', pinned: 1 }),
    '★\tA title here\tdev · https://www.example.com/x');
  assert.equal(pickRow({ title: '', url: 'https://example.com/', folder: '' }), '\texample.com\tUnfiled · https://example.com/');
});

/* ---------------- against the backend ---------------- */

function stubs(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  const stub = (name, body = '') => fs.writeFileSync(path.join(bin, name),
    `#!/usr/bin/env bash\nprintf '%s\\t%s\\n' ${JSON.stringify(name)} "$*" >>${JSON.stringify(log)}\n${body}\n`, { mode: 0o755 });
  stub('notify-send');
  stub('xdg-open');
  stub('omarchy-launch-floating-terminal-with-presentation');
  stub('wl-paste', `cat ${JSON.stringify(path.join(dir, 'clipboard'))}`);
  // The menu picks the row named in $dir/choose, and keeps what it was shown.
  stub('omarchy-menu-select', `cat >${JSON.stringify(path.join(dir, 'menu.rows'))}
while IFS= read -r row; do [[ $row == *"$(cat ${JSON.stringify(path.join(dir, 'choose'))})"* ]] && { printf '%s\\n' "\${row#*$'\\t'}"; exit 0; }; done <${JSON.stringify(path.join(dir, 'menu.rows'))}`);
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

test('login, save, pick and search, as the shortcuts run them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linksz-cli-'));
  const app = createApp(path.join(dir, 'vault.db'));
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { bin, calls } = stubs(dir);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: path.join(dir, 'config'), LINKSZ_URL: base };
  // Not spawnSync: the backend runs in this process, and would never answer.
  const cli = (args, input = '') => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  const api = (p, token, body) => fetch(base + p, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

  try {
    const vault = await fetch(`${base}/api/auth/vault`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cli' }) }).then((r) => r.json());

    let r = await cli(['save', 'https://example.com/']);
    assert.equal(r.status, 1, 'with no session, nothing is saved');
    assert.match(calls(), /omarchy-launch-floating-terminal-with-presentation\t.*login/, 'and a terminal opens for the login');

    r = await cli(['login'], `${vault.key}\n`);
    assert.equal(r.status, 0, r.stderr);
    const cfg = path.join(dir, 'config', 'linksz', 'cli.json');
    assert.equal(fs.statSync(cfg).mode & 0o777, 0o600, 'the token is readable by its owner only');
    const sessions = (await api('/api/auth/sessions', vault.token)).sessions.map((s) => s.name);
    assert.ok(sessions.includes('Desktop shortcuts'), 'and Settings lists it by name');

    // An address on a name that does not resolve: the title comes from it.
    r = await cli(['save', 'https://linksz.invalid/a-saved-article-name']);
    assert.equal(r.status, 0, r.stderr);
    let all = (await api('/api/bookmarks', vault.token)).items;
    assert.deepEqual(all.map((b) => [b.title, b.folder]), [['A Saved Article Name', 'Temporary']]);
    assert.match(calls(), /notify-send\t-a Linksz Saved to Temporary A Saved Article Name/);

    r = await cli(['save', 'https://linksz.invalid/a-saved-article-name']);
    assert.equal((await api('/api/bookmarks', vault.token)).total, 1, 'the same link twice is saved once');
    assert.match(calls(), /Already saved/);

    fs.writeFileSync(path.join(dir, 'clipboard'), 'docs.example.com/guide');
    r = await cli(['save']);
    assert.equal(r.status, 0, r.stderr);
    all = (await api('/api/bookmarks', vault.token)).items;
    assert.ok(all.some((b) => b.url === 'https://docs.example.com/guide'), 'with no argument it saves what was copied');

    fs.writeFileSync(path.join(dir, 'clipboard'), 'not a link at all');
    assert.equal((await cli(['save'])).status, 1, 'and refuses what is not a link');

    // Pinned first in the menu; the chosen one opens and counts.
    const pinned = await api('/api/bookmarks', vault.token, { title: 'Pinned one', url: 'https://pinned.example/', pinned: 1 });
    fs.writeFileSync(path.join(dir, 'choose'), 'docs.example.com');
    r = await cli(['pick']);
    assert.equal(r.status, 0, r.stderr);
    const rows = fs.readFileSync(path.join(dir, 'menu.rows'), 'utf8').trim().split('\n');
    assert.equal(rows[0], '★\tPinned one\tUnfiled · https://pinned.example/', 'the pinned link comes first');
    assert.equal(rows.length, 3);
    assert.match(calls(), /xdg-open\thttps:\/\/docs\.example\.com\/guide/, 'the picked link opens');
    all = (await api('/api/bookmarks', vault.token)).items;
    assert.equal(all.find((b) => b.url === 'https://docs.example.com/guide').opens, 1, 'and its open is counted');
    assert.equal(all.find((b) => b.id === pinned.item.id).opens, 0);

    r = await cli(['search', 'article']);
    assert.equal(r.stdout, 'A Saved Article Name\thttps://linksz.invalid/a-saved-article-name\n');

    // Signed out from Settings: the next shortcut asks again.
    const mine = (await api('/api/auth/sessions', vault.token)).sessions.find((s) => s.name === 'Desktop shortcuts');
    await api('/api/auth/sessions/revoke', vault.token, { id: mine.id });
    r = await cli(['pick']);
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(cfg), false, 'a refused session is forgotten');
  } finally {
    app.server.close();
    app.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
