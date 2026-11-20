'use strict';
const crypto = require('node:crypto');
const { Auth } = require('./auth');
const { assert, id, hash, mask, text, Fault, canonical } = require('./core');
const { defaultConfig, defaultRules, rentalRestrictions } = require('./defaults');

function reportStateFilter(state) {
  return { $or: [{ state }, { state: { $exists: false }, status: state }] };
}
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !/password|token|secret|csrf|rawContent|evidence/i.test(k))
    .map(([k,v]) => [k, /contact|openid|ipAddress/i.test(k) ? mask(v) : scrub(v)]));
}
class Service {
  constructor(store, provider, env = process.env, now = Date.now) {
    this.store = store; this.provider = provider; this.env = env; this.now = now;
    assert(env.AUDIT_SECRET?.length >= 32, 'CONFIG_ERROR', 'AUDIT_SECRET 须至少32字符', 503);
    this.audit = this.audit.bind(this);
    this.auth = new Auth(store, env, this.audit, now);
  }
  async initialize(colleges = []) {
    await this.store.transaction(async tx => {
      for (const [key, content] of [['public',defaultConfig(colleges)],['rules',defaultRules]]) {
        if (!await tx.get('settings', key)) {
          const version = 'initial-' + key;
          await tx.put('settings', key, { version, content, publishedAt: this.now() });
          await tx.put('configVersions', version, { kind: key, content, state: 'published', createdAt: this.now(), publishedAt: this.now() });
        }
      }
    });
  }
  async audit(tx, actor, action, targetId, before, after, reason = '') {
    const head = await tx.get('systemLocks', 'audit-head') || { sequence: 0, digest: '' };
    const record = { _id: id(), sequence: head.sequence + 1, actorId: actor?._id || 'system', role: actor?.role || 'system', action, targetId: targetId || '',
      before: scrub(before), after: scrub(after), reason, createdAt: this.now(), previousHash: head.digest,
      retainUntil: this.now() + 3 * 366 * 86400000 };
    record.digest = crypto.createHmac('sha256', this.env.AUDIT_SECRET).update(canonical(record)).digest('hex');
    await tx.put('auditLogs', record._id, record);
    await tx.put('systemLocks', 'audit-head', { sequence: record.sequence, digest: record.digest });
  }
  async setting(key) {
    const s = await this.store.get('settings',key);
    assert(s, 'NOT_INITIALIZED', '请先初始化治理配置', 503);
    if (key==='public' && !s.content.rentalRestrictions) s.content.rentalRestrictions=structuredClone(rentalRestrictions);
    return s;
  }
  async user(openid, capability, tx = this.store, requireProfile = true) {
    assert(openid, 'UNAUTHENTICATED', '请先登录', 401);
    const users = tx === this.store ? await tx.find('users', { _openid: openid }, { limit: 1 }) : [];
    const key = users[0]?._id || (await this.store.find('users',{ _openid: openid },{limit:1}))[0]?._id;
    const u = key ? await tx.get('users', key) : null;
    assert(u, 'PROFILE_REQUIRED', '请先登录并完善资料', 403);
    if (capability) {
      assert(u.accountStatus !== 'banned' && u.accountStatus !== 'deleted', 'ACCOUNT_BANNED', '账号已封禁，请查看治理通知', 403);
      const restricted = u.accountStatus === 'restricted' && (!u.restrictedUntil || u.restrictedUntil > this.now()) && (u.restrictions || []).includes(capability);
      assert(!restricted, 'ACCOUNT_RESTRICTED', '账号当前不能执行此操作', 403);
      if (requireProfile) assert(u.profileComplete && u.nickName && u.contact && u.campus, 'PROFILE_REQUIRED', '请先完善资料', 403);
    }
    return u;
  }
  async blocked(a, b, tx = this.store) {
    return !!((await tx.get('userBlocks', hash(a + ':' + b)))?.active || (await tx.get('userBlocks', hash(b + ':' + a)))?.active);
  }
  async guardPair(a, b, tx = this.store) { assert(!await this.blocked(a,b,tx), 'USER_BLOCKED', '拉黑关系存在，无法报价或发送消息', 403); }
  async visible(g, tx = this.store) {
    if (!g || g.moderationStatus !== 'approved' || g.enforcement === 'removed') return false;
    const owner = await this.user(g.sellerId, null, tx, false).catch(e => { if (e.code === 'PROFILE_REQUIRED') return null; throw e; });
    return !!owner && owner.accountStatus !== 'banned' && owner.accountStatus !== 'deleted';
  }
  async notify(tx, ownerId, type, targetId, content) {
    const key = hash(ownerId + ':' + type + ':' + targetId);
    if (!await tx.get('notifications', key)) await tx.put('notifications', key, { ownerId, type, targetId, content, read: false, createdAt: this.now() });
  }
  async enqueue(tx, kind, targetId, data = {}) {
    const key = hash(kind + ':' + targetId);
    const now = this.now();
    if (!await tx.get('outboxTasks', key)) await tx.put('outboxTasks', key, { kind, targetId, data: { createdAt: now, ...data }, state: 'pending', attempts: 0, nextAt: now, createdAt: now });
  }
  async risk(openid, type, targetId, facts, action = 'review') {
    const key = id();
    await this.store.transaction(async tx => {
      await tx.put('riskEvents', key, { ownerId: openid, type, targetId, facts, action, state: 'pending', createdAt: this.now() });
    });
    return key;
  }
  async rate(openid, type, maximum, ms) {
    try { await this.auth.limit(type + ':' + openid, maximum, ms); }
    catch (e) { if (e.code === 'RATE_LIMITED') await this.risk(openid, 'frequency:' + type, openid, { maximum, windowMs: ms }, 'block'); throw e; }
  }
  async signedDocument(doc) {
    if (!doc) return doc;
    const copy = structuredClone(doc);
    const fields = ['images','innerPhotos'];
    for (const field of fields) if (Array.isArray(copy[field])) copy[field] = (await this.provider.urls(copy[field].filter(file => typeof file === 'string'))).filter(Boolean);
    if (copy.avatarUrl?.startsWith('cloud://')) copy.avatarUrl = (await this.provider.urls([copy.avatarUrl]))[0];
    if (copy.sellerAvatar?.startsWith('cloud://')) copy.sellerAvatar = (await this.provider.urls([copy.sellerAvatar]))[0];
    if(copy.sellerId) {
      const seller=await this.user(copy.sellerId,null,this.store,false);
      copy.sellerName=seller.moderationStatus==='approved'?seller.nickName:'校园用户';
      if(seller.moderationStatus!=='approved') copy.sellerAvatar='';
    }
    return copy;
  }
  async signedEvidence(doc) {
    const copy = { ...doc };
    const fields = ['images', 'innerPhotos', 'avatarUrl', 'imageUrl'];
    for (const key of fields) {
      if (Array.isArray(copy[key])) copy[key] = (await this.provider.urls(copy[key].filter(file => typeof file === 'string'))).filter(Boolean);
      else if (typeof copy[key] === 'string' && copy[key].startsWith('cloud://')) [copy[key]] = await this.provider.urls([copy[key]]);
    }
    return copy;
  }
  safeUser(u) { const { contact, _openid, pendingProfile, ...rest } = u; return { ...rest, contact: mask(contact) }; }
  async mini(name, p, openid) {
    const handlers = require('./business');
    const govern = require('./governance');
    if (name === 'config') {
      if (p.action === 'booklists') return require('./booklists').publicList(this, p);
      if (p.action === 'booklist.feedback') return require('./booklists').submitFeedback(this, p, openid);
      const c = await this.setting('public'); return { version: c.version, ...c.content };
    }
    if (name === 'governance' || name === 'report') return govern.miniGovernance(this, name, p, openid);
    const handler = handlers[name]; assert(handler, 'NOT_FOUND', '未知业务接口', 404);
    return handler(this, p, openid);
  }
}
module.exports = { Service, scrub, reportStateFilter };
