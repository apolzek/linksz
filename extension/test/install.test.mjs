// install.sh, on a copy of a flags file: it adds this folder to the
// --load-extension line Omarchy already has, in place, once, and takes it out
// again leaving the file as it was.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');
const SCRIPT = path.join(EXT, 'install.sh');

function run(file, ...args) {
  return execFileSync('bash', [SCRIPT, ...args], { env: { ...process.env, CHROMIUM_FLAGS_FILE: file }, encoding: 'utf8' });
}

function tmp(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-flags-'));
  const file = path.join(dir, 'chromium-flags.conf');
  if (content != null) fs.writeFileSync(file, content);
  return { file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const OMARCHY = '--ozone-platform=wayland\n--load-extension=/usr/share/omarchy/a,/usr/share/omarchy/b\n--no-default-browser-check\n';

test('it joins the line Omarchy has, where it is', () => {
  const t = tmp(OMARCHY);
  try {
    run(t.file);
    assert.equal(fs.readFileSync(t.file, 'utf8'),
      `--ozone-platform=wayland\n--load-extension=/usr/share/omarchy/a,/usr/share/omarchy/b,${EXT}\n--no-default-browser-check\n`);
    assert.equal(fs.readFileSync(`${t.file}.bak`, 'utf8'), OMARCHY, 'the previous file is kept');
  } finally { t.done(); }
});

test('twice is once', () => {
  const t = tmp(OMARCHY);
  try {
    run(t.file);
    const once = fs.readFileSync(t.file, 'utf8');
    assert.match(run(t.file), /Already/);
    assert.equal(fs.readFileSync(t.file, 'utf8'), once);
  } finally { t.done(); }
});

test('removing puts the file back as it was', () => {
  const t = tmp(OMARCHY);
  try {
    run(t.file);
    run(t.file, '--remove');
    assert.equal(fs.readFileSync(t.file, 'utf8'), OMARCHY);
  } finally { t.done(); }
});

test('with no line, or no file, it makes one, and removing drops it', () => {
  const t = tmp('--foo\n');
  try {
    run(t.file);
    assert.equal(fs.readFileSync(t.file, 'utf8'), `--foo\n--load-extension=${EXT}\n`);
    run(t.file, '--remove');
    assert.equal(fs.readFileSync(t.file, 'utf8'), '--foo\n');
  } finally { t.done(); }
  const n = tmp(null);
  try {
    run(n.file);
    assert.equal(fs.readFileSync(n.file, 'utf8'), `--load-extension=${EXT}\n`);
  } finally { n.done(); }
});
