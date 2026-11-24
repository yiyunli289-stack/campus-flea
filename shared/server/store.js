'use strict';
const { id } = require('./core');
const clone = v => v == null ? v : structuredClone(v);
function checked(result) {
  if (result?.code && result.code !== 0) { const error = new Error(result.message || result.code); error.code = result.code; error.status = 503; throw error; }
  return result;
}
function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(f => matches(doc, f));
    const actual = doc[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value).every(([op, x]) => ({ $in: () => x.includes(actual), $ne: () => actual !== x,
        $gt: () => actual > x, $gte: () => actual >= x, $lte: () => actual <= x, $exists: () => Object.hasOwn(doc, key) === x,
        $contains: () => String(actual || '').toLowerCase().includes(String(x).toLowerCase()) }[op]?.() || false));
    }
    return actual === value;
  });
}
class MemoryStore {
  constructor(data = {}, persist) { this.data = clone(data); this.persist = persist; this.queue = Promise.resolve(); }
  async get(table, key) { return clone(this.data[table]?.[key] || null); }
  async find(table, filter = {}, opts = {}) {
    let list = Object.values(this.data[table] || {}).filter(d => matches(d, filter));
    if (opts.sort) list.sort((a, b) => ((a[opts.sort] > b[opts.sort]) - (a[opts.sort] < b[opts.sort])) * (opts.asc ? 1 : -1));
    return clone(list.slice(opts.skip || 0, (opts.skip || 0) + (opts.limit || 50)));
  }
  async count(table, filter = {}) { return Object.values(this.data[table] || {}).filter(d => matches(d, filter)).length; }
  async put(table, key, doc) { (this.data[table] ||= {})[key] = { ...clone(doc), _id: key }; return key; }
  async add(table, doc) { const key = doc._id || id(); await this.put(table, key, doc); return key; }
  async transaction(fn) {
    const run = this.queue.then(async () => {
      const before = clone(this.data);
      try { const result = await fn(this); if (this.persist) await this.persist(clone(this.data)); return result; }
      catch (e) { this.data = before; throw e; }
    });
    this.queue = run.catch(() => {}); return run;
  }
}
class CloudStore {
  constructor(db, base = db) { this.db = db; this.base = base; }
  async get(table, key) {
    try { const r = checked(await this.db.collection(table).doc(key).get()); return Array.isArray(r.data) ? r.data[0] || null : r.data || null; }
    catch (e) {
      if (/DOCUMENT_NOT_EXIST|DOCUMENT_NOT_FOUND/.test(String(e.code)) ||
          /^(?:document (?:not found|does not exist)|文档不存在)[.!]?$/i.test(String(e.message).trim())) return null;
      throw e;
    }
  }
  filter(f) {
    const cmd = this.base.command; const out = {};
    for (const [k, v] of Object.entries(f)) {
      if (k === '$or') { out.$or = v.map(x => this.filter(x)); continue; }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        let expr;
        for (const [op, x] of Object.entries(v)) {
          const next = op === '$contains' ? this.base.RegExp({ regexp: String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' }) : cmd[({ $in: 'in', $ne: 'neq', $gt: 'gt', $gte: 'gte', $lte: 'lte', $exists: 'exists' })[op]](x);
          expr = expr ? cmd.and(expr, next) : next;
        }
        out[k] = expr;
      } else out[k] = v;
    }
    if (out.$or) { const parts = out.$or; delete out.$or; return cmd.and(out, cmd.or(parts)); }
    return out;
  }
  async find(table, f = {}, opts = {}) {
    let q = this.db.collection(table).where(this.filter(f));
    if (opts.fields) q = q.field(opts.fields);
    if (opts.sort) q = q.orderBy(opts.sort, opts.asc ? 'asc' : 'desc');
    return checked(await q.skip(opts.skip || 0).limit(opts.limit || 50).get()).data;
  }
  async count(table, f = {}) { return checked(await this.db.collection(table).where(this.filter(f)).count()).total; }
  async put(table, key, doc) {
    const data = { ...doc }; delete data._id;
    // @cloudbase/node-sdk 4 uses the Web v3 database API: set(document), not the v3 {data} envelope.
    checked(await this.db.collection(table).doc(key).set(data)); return key;
  }
  async add(table, doc) { const key = doc._id || id(); await this.put(table, key, doc); return key; }
  async transaction(fn) { return this.base.runTransaction(tx => fn(new CloudStore(tx, this.base))); }
}
module.exports = { MemoryStore, CloudStore, matches };
