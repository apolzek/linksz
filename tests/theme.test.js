'use strict';

// The look: omarchy.org's, Tokyo Night when dark and Catppuccin Latte when
// light. What these hold is what breaks quietly: a colour used and never
// defined, the two copies of the dark palette drifting apart, a font that is
// not there offline.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
const sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');

// The declarations of one rule, as a map. Only for the token blocks, which
// hold nothing but custom properties.
function tokens(body) {
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function block(selectorPattern) {
  const m = new RegExp(`${selectorPattern}\\s*\\{([^{}]*)\\}`).exec(css);
  assert.ok(m, `no rule for ${selectorPattern}`);
  return tokens(m[1]);
}

const light = block(':root');
const darkBySystem = block(':root:not\\(\\[data-theme="light"\\]\\)');
const darkByChoice = block(':root\\[data-theme="dark"\\]');

test('the dark palette is the same whether the system or the person picks it', () => {
  assert.deepEqual(darkBySystem, darkByChoice);
});

test('dark sets every colour light does', () => {
  const colours = Object.keys(light).filter((k) => !['--radius', '--radius-sm', '--side-w', '--mono', '--font'].includes(k));
  assert.deepEqual(Object.keys(darkByChoice).sort(), colours.sort());
});

test('dark is Tokyo Night and light is Catppuccin Latte', () => {
  assert.equal(darkByChoice['--bg'], '#1a1b26');
  assert.equal(darkByChoice['--text'], '#c0caf5');
  assert.equal(darkByChoice['--accent'], '#9ece6a');
  assert.equal(light['--bg'], '#eff1f5');
  assert.equal(light['--text'], '#4c4f69');
  assert.equal(light['--accent'], '#1e66f5');
});

test('every custom property used is defined', () => {
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  for (const name of used) assert.ok(name in light, `${name} is used and never defined`);
});

test('corners are square, and only dots are round', () => {
  for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) {
    assert.ok(['0', '50%', 'var(--radius)', 'var(--radius-sm)'].includes(m[1].trim()), `border-radius: ${m[1]}`);
  }
  assert.equal(light['--radius'], '0');
  assert.equal(light['--radius-sm'], '0');
});

test('the font ships with the app and is there offline', () => {
  const src = /@font-face\s*\{[^}]*url\("([^"]+)"\)/.exec(css);
  assert.ok(src, 'no @font-face');
  const file = path.join(WEB, src[1]);
  assert.ok(fs.existsSync(file), `${src[1]} is missing`);
  assert.equal(fs.readFileSync(file).subarray(0, 4).toString(), 'wOF2', 'not a woff2 file');
  assert.ok(sw.includes(`'${src[1]}'`), `sw.js does not precache ${src[1]}`);
  assert.ok(fs.existsSync(path.join(WEB, 'fonts', 'OFL.txt')), 'the font licence travels with it');
  assert.match(light['--font'], /--mono/, 'everything is set in the mono face');
});

/* ---------------- legible text ---------------- */

// WCAG contrast between two #rrggbb colours.
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the caption under a chosen segment takes the colour of the button', () => {
  assert.match(css, /\.segmented button\.on small\s*\{[^}]*color:\s*inherit/,
    'muted grey on the accent is unreadable');
});

for (const [name, theme] of [['light', light], ['dark', darkByChoice]]) {
  test(`segmented captions read in ${name}, chosen or not`, () => {
    assert.ok(contrast(theme['--on-accent'], theme['--accent']) >= 4.5, 'on the accent');
    assert.ok(contrast(theme['--muted'], theme['--surface-2']) >= 4.5, 'on the track');
  });
}
