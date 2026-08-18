// Senha e token de sessão, só com `node:crypto`.
//
// scrypt em vez de bcrypt/argon2 porque vem embutido no Node e o projeto não
// tem dependências. Os parâmetros abaixo são os recomendados para uso
// interativo; subir N deixa o login mais lento na mesma proporção.
//
// O hash guarda o sal junto, no formato `scrypt$<sal-hex>$<chave-hex>` — assim
// dá para trocar os parâmetros no futuro sem perder quem já tem conta.
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

// Sem validacao de email por design (pedido do usuario): so checa formato minimo.
function looksLikeEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+$/.test(s.trim());
}

module.exports = { hashPassword, verifyPassword, newToken, looksLikeEmail };
