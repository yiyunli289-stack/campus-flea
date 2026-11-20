'use strict';
const crypto = require('node:crypto');
const { assert, id, hash, equal, text, passwordHash, verifyPassword, publicAdmin, permit } = require('./core');
class Auth {
  constructor(store, env, audit, now = Date.now) { this.store = store; this.env = env; this.audit = audit; this.now = now; }
  async limit(key, maximum, windowMs) {
    const now = this.now(); const bucket = hash(key + ':' + Math.floor(now / windowMs));
    const allowed = await this.store.transaction(async tx => {
      const cur = await tx.get('rateLimits', bucket); const count = (cur?.count || 0) + 1;
      await tx.put('rateLimits', bucket, { count, expiresAt: now + windowMs }); return count <= maximum;
    });
    assert(allowed, 'RATE_LIMITED', '操作过于频繁，请稍后重试', 429);
  }
  async createAccount(actor, p, bootstrap = false) {
    if (!bootstrap) permit(actor, 'accounts');
    const username = text(p.username, 40, true).toLowerCase();
    assert(/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(username), 'INVALID_INPUT', '账号须为 3 至 40 位字母、数字或 _.-');
    assert(['super','reviewer','readonly'].includes(p.role), 'INVALID_ROLE', '角色无效');
    const digest = await passwordHash(p.password); const key = hash(username);
    return this.store.transaction(async tx => {
      assert(!await tx.get('adminUsers', key), 'CONFLICT', '账号已存在', 409);
      if (bootstrap) {
        assert(!await tx.get('systemLocks', 'bootstrap'), 'CONFLICT', '超级管理员已初始化', 409);
        await tx.put('systemLocks', 'bootstrap', { createdAt: this.now() });
      }
      const account = { _id: key, username, passwordHash: digest, role: p.role, active: true, sessionVersion: 1, createdAt: this.now() };
      await tx.put('adminUsers', key, account);
      const lock = await tx.get('systemLocks', 'super-count') || { count: 0 };
      if (p.role === 'super') await tx.put('systemLocks', 'super-count', { count: lock.count + 1 });
      await this.audit(tx, actor || { _id: 'bootstrap', role: 'system' }, 'admin.create', key, null, publicAdmin(account));
      return publicAdmin(account);
    });
  }
  async login(p, ip) {
    const username = text(p.username, 40, true).toLowerCase();
    await this.limit('login:account:' + username, 10, 15 * 60000);
    await this.limit('login:ip:' + ip, 40, 15 * 60000);
    const account = await this.store.get('adminUsers', hash(username));
    const valid = await verifyPassword(p.password, account?.passwordHash);
    if (!valid || !account?.active) {
      await this.store.transaction(tx => this.audit(tx, { _id: hash(username), role: 'anonymous' }, 'auth.failed', hash(username), null, { result: 'denied' }));
      assert(false, 'INVALID_CREDENTIALS', '账号或密码错误', 401);
    }
    const token = crypto.randomBytes(32).toString('base64url'); const csrf = crypto.randomBytes(24).toString('base64url');
    await this.store.transaction(async tx => {
      await tx.put('adminSessions', hash(token), { adminId: account._id, sessionVersion: account.sessionVersion, csrfHash: hash(csrf), expiresAt: this.now() + 8 * 3600000, lastAt: this.now() });
      await this.audit(tx, account, 'auth.login', account._id, null, { result: 'success' });
    });
    return { token, csrf, admin: publicAdmin(account) };
  }
  async session(token, csrf, write = false) {
    assert(token, 'UNAUTHENTICATED', '请登录管理后台', 401);
    const key = hash(token); const s = await this.store.get('adminSessions', key);
    assert(s && s.expiresAt > this.now() && s.lastAt + 30 * 60000 > this.now(), 'UNAUTHENTICATED', '登录已过期', 401);
    const a = await this.store.get('adminUsers', s.adminId);
    assert(a?.active && a.sessionVersion === s.sessionVersion, 'UNAUTHENTICATED', '登录已失效', 401);
    if (write) assert(equal(hash(csrf || ''), s.csrfHash), 'CSRF_REJECTED', '请求校验失败', 403);
    await this.store.transaction(async tx => {
      const current = await tx.get('adminSessions', key);
      assert(current?.expiresAt > this.now(), 'UNAUTHENTICATED', '登录已失效', 401);
      await tx.put('adminSessions', key, { ...current, lastAt: this.now() });
    });
    return a;
  }
  async logout(actor, token) {
    await this.store.transaction(async tx => {
      const s = await tx.get('adminSessions', hash(token));
      if (s) await tx.put('adminSessions', hash(token), { ...s, expiresAt: 0 });
      await this.audit(tx, actor, 'auth.logout', actor._id, null, { result: 'success' });
    });
  }
  async updateAccount(actor, p) {
    const self = p.id === actor._id && p.currentPassword;
    if (!self) permit(actor, 'accounts');
    const old = await this.store.get('adminUsers', p.id);
    assert(old, 'NOT_FOUND', '账号不存在', 404);
    if (self) assert(await verifyPassword(p.currentPassword, old.passwordHash), 'INVALID_CREDENTIALS', '原密码错误', 401);
    const digest = p.password ? await passwordHash(p.password) : null;
    if (self) assert(digest, 'INVALID_INPUT', '请输入新密码');
    return this.store.transaction(async tx => {
      const a = await tx.get('adminUsers', p.id); const next = { ...a, sessionVersion: a.sessionVersion + 1 };
      if (digest) next.passwordHash = digest;
      if (!self) {
        if (p.role !== undefined) { assert(['super','reviewer','readonly'].includes(p.role), 'INVALID_ROLE', '角色无效'); next.role = p.role; }
        if (p.active !== undefined) { assert(typeof p.active === 'boolean', 'INVALID_INPUT', '状态无效'); next.active = p.active; }
      }
      const beforeSuper = a.active && a.role === 'super'; const afterSuper = next.active && next.role === 'super';
      const lock = await tx.get('systemLocks', 'super-count');
      if (beforeSuper !== afterSuper) {
        const count = lock.count + (afterSuper ? 1 : -1);
        assert(count >= 1, 'LAST_SUPER', '至少保留一个有效超级管理员');
        await tx.put('systemLocks', 'super-count', { count });
      }
      await tx.put('adminUsers', a._id, next);
      await this.audit(tx, actor, 'admin.update', a._id, publicAdmin(a), publicAdmin(next), text(p.reason || '修改本人密码', 500, true));
      return publicAdmin(next);
    });
  }
}
module.exports = { Auth };
