// Password hashing and session tokens, with `node:crypto` alone.
//
// scrypt instead of bcrypt/argon2 because it ships with Node and this project
// has no dependencies. The parameters below are the recommended ones for
// interactive use; raising N slows login down in the same proportion.
//
// The hash stores the salt with it, as `scrypt$<salt-hex>$<key-hex>`, so the
// parameters can change later without locking out existing accounts.
'use strict';

const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT.keylen, SCRYPT);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// No email validation by design: it only checks the minimum shape.
function looksLikeEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+$/.test(s.trim());
}

module.exports = { hashPassword, verifyPassword, newToken, looksLikeEmail };
