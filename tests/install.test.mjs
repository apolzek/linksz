// install.sh, the desktop install, in a throwaway home: what it writes, that
// the service it writes really serves the app, and that --remove takes it all
// out but the vault.
//
// systemctl is a stub on PATH, so nothing here touches the session of whoever
// runs the suite: `restart` runs the unit's own ExecStart with its own
// Environment lines, `stop` and `disable --now` kill it.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STUB = `#!/usr/bin/env bash
unit="$XDG_CONFIG_HOME/systemd/user/linksz.service"
pidf="$HOME/.stub-pid"
# Waits for it to go, as systemctl stop does.
stop() {
  [[ -f $pidf ]] || return 0
  local pid; pid=$(cat "$pidf"); rm -f "$pidf"
  kill "$pid" 2>/dev/null
  while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done
}
case " $* " in
  *" restart "*|*" start "*)
    stop
    env $(sed -n 's/^Environment=//p' "$unit") $(sed -n 's/^ExecStart=//p' "$unit") >"$HOME/.stub-log" 2>&1 &
    echo $! >"$pidf" ;;
  *" stop "*|*" --now "*) stop ;;
esac
exit 0
`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A connection of its own each time: a kept-alive one would outlive the server
// that a re-install restarts.
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('it installs a service that serves the app, a launcher and a menu entry, and takes them out', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linksz-install-'));
  const bin = path.join(home, 'stub-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'systemctl'), STUB, { mode: 0o755 });
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    PATH: `${bin}:${process.env.PATH}`,
    LINKSZ_SOURCE: ROOT,
    LINKSZ_PORT: String(port),
  };
  const run = (...args) => execFileSync('bash', [path.join(ROOT, 'install.sh'), ...args], { env, encoding: 'utf8' });
  const appHome = path.join(home, '.local', 'share', 'linksz');

  try {
    run();

    const unit = fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'linksz.service'), 'utf8');
    assert.match(unit, /^Environment=LINKSZ_HOST=127\.0\.0\.1$/m, 'only this machine reaches it');
    assert.match(unit, new RegExp(`^Environment=LINKSZ_DB=${appHome}/data/bookmarks.db$`, 'm'));

    const desktop = fs.readFileSync(path.join(home, '.local', 'share', 'applications', 'Linksz.desktop'), 'utf8');
    assert.match(desktop, new RegExp(`^Exec=${appHome}/bin/linksz$`, 'm'));
    assert.ok(fs.existsSync(path.join(home, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', 'linksz.png')));

    assert.ok(fs.existsSync(path.join(appHome, 'app', 'extension', 'install.sh')), 'the extension comes with it');
    assert.ok(!fs.existsSync(path.join(appHome, 'app', 'extension', 'test')), 'its tests do not');
    assert.ok(!fs.existsSync(path.join(appHome, 'app', 'web', 'nginx.conf')), 'build inputs are not served');

    const base = `http://localhost:${port}`;
    const health = JSON.parse((await get(`${base}/api/health`)).body);
    assert.equal(health.service, 'linksz');
    const page = await get(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.body, /<html/i, 'the PWA, from the same origin');
    assert.ok(fs.existsSync(path.join(appHome, 'data', 'bookmarks.db')), 'the vault is where it said');

    // Again is an update: same files, still serving.
    run();
    assert.equal((await get(`${base}/api/health`)).status, 200);

    run('--remove');
    assert.ok(!fs.existsSync(path.join(appHome, 'app')));
    assert.ok(!fs.existsSync(path.join(home, '.local', 'share', 'applications', 'Linksz.desktop')));
    assert.ok(!fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'linksz.service')));
    assert.ok(fs.existsSync(path.join(appHome, 'data', 'bookmarks.db')), 'the vault stays');
    await assert.rejects(get(`${base}/api/health`), 'and nothing answers any more');
  } finally {
    try { process.kill(Number(fs.readFileSync(path.join(home, '.stub-pid'), 'utf8'))); } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  }
});
