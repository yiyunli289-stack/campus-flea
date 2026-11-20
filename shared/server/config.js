'use strict';
const { assert, text, confirm, id } = require('./core');
const { defaultRules, rentalRestrictions } = require('./defaults');
const configKeys = ['categories','campuses','colleges','majors','courses','tags','conditions','noteLevels','rentalRestrictions','safetyTip'];
function validateConfig(p) {
  assert(p && typeof p === 'object' && !Array.isArray(p), 'INVALID_CONFIG', '配置格式无效');
  p = { rentalRestrictions, ...p };
  assert(Object.keys(p).every(k => configKeys.includes(k)), 'INVALID_CONFIG', '包含未知配置项');
  for (const key of configKeys.filter(k => k !== 'safetyTip')) {
    assert(Array.isArray(p[key]) && p[key].length <= 1000, 'INVALID_CONFIG', `${key} 须为数组，最多1000项`);
    const seen = new Set();
    for (const x of p[key]) {
      const code = text(x.code, 80, true); text(x.name, 100, true);
      assert(!['__proto__','prototype','constructor'].includes(code),'INVALID_CONFIG','编码不得使用保留字');
      assert(!seen.has(code) && typeof x.active === 'boolean', 'INVALID_CONFIG', `${key} 编码重复或缺少启停状态`); seen.add(code);
      if (x.parent) assert(p[key].some(v => v.code === x.parent && v.code !== code), 'INVALID_CONFIG', '父节点不存在');
      let node = x; const trail = new Set();
      while (node?.parent) { assert(!trail.has(node.code), 'INVALID_CONFIG', '不能循环引用父节点'); trail.add(node.code); node = p[key].find(v => v.code === node.parent); }
      if (key === 'categories') {
        assert(Array.isArray(x.fields) && x.fields.length <= 30, 'INVALID_CONFIG', '每类目最多30个字段');
        const fieldKeys = new Set();
        for (const f of x.fields) {
          assert(/^[a-z][a-zA-Z0-9_]{0,39}$/.test(f.code) && !['__proto__','prototype','constructor'].includes(f.code) && !fieldKeys.has(f.code), 'INVALID_CONFIG', '字段编码无效或重复'); fieldKeys.add(f.code);
          text(f.name, 80, true); assert(['text','number','enum'].includes(f.type), 'INVALID_CONFIG', '字段类型无效');
          if (f.type === 'enum') assert(Array.isArray(f.options) && f.options.length > 0 && f.options.length <= 100 && f.options.every(v => typeof v === 'string' && v.length <= 80), 'INVALID_CONFIG', '枚举选项无效');
        }
      }
    }
  }
  for (const code of ['无笔记','少量','较多','大量']) assert(p.noteLevels.some(x => x.code === code && x.active), 'INVALID_CONFIG', '必须保留四种笔记等级');
  for (const rule of rentalRestrictions) assert(p.rentalRestrictions.some(x => x.code===rule.code && x.active), 'INVALID_CONFIG', '基础租用禁限品类必须保留');
  for (const code of ['book','digital','life','stationery','sports','clothes','other']) assert(p.categories.some(x => x.code === code), 'INVALID_CONFIG', '必须保留基础类目编码');
  text(p.safetyTip, 500, true);
  return JSON.parse(JSON.stringify(p));
}
function validateRules(p) {
  assert(Object.keys(p).every(k => Object.hasOwn(defaultRules,k)), 'INVALID_CONFIG', '风控配置包含未知字段');
  for (const key of ['offerPerHour','messagePerMinute','reportPerHour']) assert(Number.isInteger(p[key]) && p[key] >= 1 && p[key] <= 10000, 'INVALID_CONFIG', '限频阈值须为1至10000整数');
  assert(Number.isInteger(p.priceChangeSeconds) && p.priceChangeSeconds >= 300 && p.priceChangeSeconds <= 86400, 'INVALID_CONFIG', '改价间隔不得短于5分钟');
  assert(p.lowPriceRatio > 0 && p.lowPriceRatio < 1 && ['review','block'].includes(p.action), 'INVALID_CONFIG', '风险动作或价格比例无效');
  assert(p.lowPriceByCategory && typeof p.lowPriceByCategory === 'object' && !Array.isArray(p.lowPriceByCategory) && Object.values(p.lowPriceByCategory).every(v => Number.isFinite(v) && v >= 0), 'INVALID_CONFIG', '类目低价阈值无效');
  assert(Array.isArray(p.prohibitedTerms) && p.prohibitedTerms.length <= 300 && p.prohibitedTerms.every(v => typeof v === 'string' && v.trim() && v.length <= 80), 'INVALID_CONFIG', '禁用词配置无效');
  return JSON.parse(JSON.stringify(p));
}
async function saveVersion(service, actor, p) {
  const kind = p.kind === 'rules' ? 'rules' : 'public';
  const content = kind === 'rules' ? validateRules(p.content) : validateConfig(p.content);
  const key = id();
  await service.store.transaction(async tx => {
    await tx.put('configVersions', key, { kind, content, state: 'draft', createdBy: actor._id, createdAt: service.now() });
    await service.audit(tx, actor, 'config.draft', key, null, { kind });
  });
  return { _id: key };
}
async function publishVersion(service, actor, p) {
  const reason = confirm(p);
  return service.store.transaction(async tx => {
    const v = await tx.get('configVersions', p.id); assert(v, 'NOT_FOUND', '配置版本不存在', 404);
    assert(['public','rules'].includes(v.kind),'INVALID_CONFIG','请选择类目字典或风控配置版本');
    const content = v.kind === 'rules' ? validateRules(v.content) : validateConfig(v.content);
    const before = await tx.get('settings', v.kind);
    await tx.put('settings', v.kind, { version: p.id, content, publishedAt: service.now() });
    await tx.put('configVersions', p.id, { ...v, state: 'published', publishedAt: service.now() });
    await service.audit(tx, actor, 'config.publish', p.id, before, { version: p.id, kind: v.kind, content: v.content }, reason);
    return { version: p.id };
  });
}
module.exports = { validateConfig, validateRules, saveVersion, publishVersion };
