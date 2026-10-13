// Access keys and session tokens, with `node:crypto` alone.
//
// A vault has no username and no password. It has one access key: 160 random
// bits written in Crockford base32, in groups of four so a person can read it
// back. The key is the only thing anyone types, and it is shown once, when it
// is made.
//
// Only its SHA-256 is stored. A slow hash (scrypt, as the passwords had) earns
// its cost against guessable secrets; against 160 random bits it buys nothing,
// and a plain digest is what lets a key be looked up by its hash in one indexed
// query instead of being tried against every vault in turn.
//
// Typing the key in exchanges it for a session token, so a device holds a token
// that can be revoked on its own, and a rotated key leaves no device holding the
// old one.
'use strict';

const crypto = require('node:crypto');

// Crockford's alphabet: no I, L, O or U, so nothing reads as something else.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_CHARS = 32;   // 32 x 5 bits = 160 bits

function newAccessKey() {
  const bytes = crypto.randomBytes(KEY_CHARS);
  let out = '';
  for (let i = 0; i < KEY_CHARS; i++) out += ALPHABET[bytes[i] & 31];
  return out.match(/.{4}/g).join('-');
}

// What was typed, reduced to the 32 characters that matter. Case, spaces and
// dashes are noise, and the letters Crockford leaves out are read as the digits
// they look like, which is the point of that alphabet.
function normalizeKey(raw) {
  return String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '');
}

function hashKey(raw) {
  const key = normalizeKey(raw);
  if (key.length !== KEY_CHARS) return null;
  return crypto.createHash('sha256').update(key).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { newAccessKey, normalizeKey, hashKey, newToken, KEY_CHARS };
