'use strict';
const crypto = require('node:crypto');
const { Auth } = require('./auth');
const { assert, id, hash, mask, text, Fault, canonical } = require('./core');
const trade = require('./trade-state');
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
  async findUser(openid, tx = this.store) {
    if (!openid) return null;
    const rows = await this.store.find('users', { _openid: openid }, { limit: 50 });
    const key = rows.find(u => u.accountStatus === 'deleted')?._id
      || rows.find(u => u.accountStatus === 'banned')?._id
      || rows.find(u => u.accountStatus === 'restricted')?._id
      || rows.find(u => u.accessEpoch)?._id
      || rows.find(u => u._id === hash('user:' + openid))?._id || rows[0]?._id;
    return key ? tx.get('users', key) : null;
  }
  async user(openid, capability, tx = this.store, requireProfile = true) {
    assert(openid, 'UNAUTHENTICATED', '请先登录', 401);
    const u = await this.findUser(openid, tx);
    assert(u, 'PROFILE_REQUIRED', '请先登录并完善资料', 403);
    if (capability) {
      assert(u.accountStatus !== 'deleted', 'ACCOUNT_DELETED', '账号已注销', 403);
      assert(u.accountStatus !== 'banned', 'ACCOUNT_BANNED', '账号已封禁，请查看治理通知', 403);
      assert(trade.accountState(u, this.now()).allowedCapabilities.includes(capability),
        'ACCOUNT_RESTRICTED', '账号当前不能执行此操作', 403);
      if (requireProfile) assert(u.profileComplete && u.nickName && u.contact && u.campus, 'PROFILE_REQUIRED', '请先完善资料', 403);
    }
    return u;
  }
  async blocked(a, b, tx = this.store) {
    return !!((await tx.get('userBlocks', hash(a + ':' + b)))?.active || (await tx.get('userBlocks', hash(b + ':' + a)))?.active);
  }
  async guardPair(a, b, tx = this.store) { assert(!await this.blocked(a,b,tx), 'USER_BLOCKED', '拉黑关系存在，无法报价或发送消息', 403); }
  async listingState(g, tx = this.store) {
    const { seller, buyer } = await trade.parties(this, g, g?.buyerId, tx);
    return trade.listingState(g, seller, buyer);
  }
  async visible(g, tx = this.store) {
    return ['on', 'locked', 'off', 'sold'].includes(await this.listingState(g, tx)) &&
      !trade.blockedAccount(await this.findUser(g.sellerId, tx));
  }
  async chatAvailable(c, g, tx = this.store) {
    const { seller, buyer } = await trade.parties(this, g, c?.buyerId, tx);
    return trade.livePair(g, c, seller, buyer, this.now(), 'message') &&
      !await this.blocked(c.sellerId, c.buyerId, tx);
  }
  async contactAvailable(c, g, seller, buyer, tx = this.store) {
    if (!trade.livePair(g, c, seller, buyer, this.now(), 'offer') ||
        !trade.livePair(g, c, seller, buyer, this.now(), 'message') ||
        ![seller, buyer].every(u => trade.accountState(u, this.now()).accountStatus === 'normal') ||
        await this.blocked(c.sellerId, c.buyerId, tx)) return false;
    return g.status === 'locked' || !!(c.contactConsent?.seller && c.contactConsent?.buyer);
  }
  async notify(tx, ownerId, type, targetId, content) {
    const key = hash(ownerId + ':' + type + ':' + targetId);
    if (!await tx.get('notifications', key)) await tx.put('notifications', key, { ownerId, type, targetId, content, read: false, createdAt: this.now() });
  }
  async enqueue(tx, kind, targetId, data = {}, runAt) {
    const key = hash(kind + ':' + targetId);
    const now = this.now();
    if (!await tx.get('outboxTasks', key)) await tx.put('outboxTasks', key, { kind, targetId, data: { createdAt: now, ...data }, state: 'pending', attempts: 0, nextAt: runAt || now, createdAt: now });
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
      const seller=await this.findUser(copy.sellerId) || {};
      copy.sellerName=(!seller.moderationStatus || seller.moderationStatus==='approved') && !trade.blockedAccount(seller) ? seller.nickName : '校园用户';
      if(copy.sellerName==='校园用户') copy.sellerAvatar='';
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
