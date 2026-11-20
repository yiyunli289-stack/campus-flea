'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
class Fault extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function assert(ok, code, message, status) { if (!ok) throw new Fault(code, message, status); }
const id = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function equal(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function text(value, max = 500, required = false) {
  assert(value === undefined || typeof value === 'string', 'INVALID_INPUT', '文本格式错误');
  const out = (value || '').trim();
  assert(out.length <= max && (!required || out.length > 0), 'INVALID_INPUT', `请输入${required ? '非空且' : ''}不超过 ${max} 字的内容`);
  return out;
}
function money(value) {
  const n = Number(value);
  assert(Number.isFinite(n) && n > 0 && n <= 999999 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-7, 'INVALID_PRICE', '金额必须为正数，最多两位小数');
  return Math.round(n * 100) / 100;
}
function publicAdmin(a) { return { _id: a._id, username: a.username, role: a.role, active: a.active, createdAt: a.createdAt }; }
function mask(s) { return !s ? '' : String(s).slice(0, 2) + '***' + String(s).slice(-2); }
const roles = {
  super: ['read', 'evidence', 'moderate', 'configure', 'accounts', 'audit'],
  reviewer: ['read', 'evidence', 'moderate', 'audit'],
  readonly: ['read']
};
function permit(actor, permission) { assert(actor && roles[actor.role]?.includes(permission), 'FORBIDDEN', '没有此操作权限', 403); }
function confirm(p) { assert(p.confirm === true, 'CONFIRM_REQUIRED', '请二次确认操作'); return text(p.reason, 500, true); }
async function passwordHash(password) {
  assert(typeof password === 'string' && password.length >= 12 && password.length <= 128, 'WEAK_PASSWORD', '密码长度须为 12 至 128 位');
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + (await scrypt(password, salt, 64)).toString('hex');
}
async function verifyPassword(password, digest) {
  const [salt, expected] = (digest || '').split(':');
  // Also perform expensive work for unknown accounts to reduce account enumeration.
  const actual = await scrypt(String(password || '').slice(0, 128), salt || 'unknown-account', 64);
  return !!expected && equal(actual.toString('hex'), expected);
}
module.exports = { Fault, assert, id, hash, canonical, equal, text, money, publicAdmin, mask, roles, permit, confirm, passwordHash, verifyPassword };
