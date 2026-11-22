const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { ALL_COLLEGES } = require('../miniprogram/utils/colleges');
const { CAMPUS_LIST, CATEGORY_MAP } = require('../miniprogram/utils/constants');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(setImmediate);
const input = (value) => ({ detail: { value } });
const tap = (dataset) => ({ currentTarget: { dataset } });
const completeUser = { _openid: 'buyer', profileComplete: true };
const product = (_id) => ({ _id, title: _id, cat: 'book', status: 'on', price: 20 });

function loadPage(name, { respond = () => [], stored = {}, user = null, wx = {}, profile } = {}) {
  const filename = path.join(__dirname, '../miniprogram', name === 'app' ? 'app.js' : 'pages/' + name + '/' + name + '.js');
  const calls = [];
  const delays = [];
  const toasts = [];
  const storage = new Map(Object.entries(stored));
  const app = {
    globalData: { userInfo: user, campus: CAMPUS_LIST[0], campusList: CAMPUS_LIST, categoryMap: CATEGORY_MAP },
    call(name, data) {
      calls.push({ name, data });
      return Promise.resolve(respond(data, name));
    },
    ensureProfile() { return profile ? profile() : Promise.resolve(this.globalData.userInfo); }
  };
  let definition;
  let stopped = 0;
  const register = (value) => { definition = value; };
  const runtime = {
    App: register,
    Page: register,
    getApp: () => app,
    require: createRequire(filename),
    setTimeout: (resume, delay) => { delays.push({ resume, delay }); },
    wx: {
      getStorageSync: (key) => storage.get(key) || '',
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key),
      showToast: (value) => toasts.push(value),
      stopPullDownRefresh: () => { stopped++; },
      ...wx
    }
  };
  vm.runInNewContext(readFileSync(filename, 'utf8'), runtime, { filename });
  if (definition.data) definition.data = structuredClone(definition.data);
  definition.setData = function (patch, done) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      const property = parts.pop();
      const target = parts.reduce((parent, name) => parent[name], this.data);
      target[property] = value;
    }
    if (done) done();
  };
  return { page: definition, app, calls, storage, delays, toasts, pullStops: () => stopped };
}

test('首次进入默认查全部在售商品，返回时按当前条件重新查询', async () => {
  const { page, calls } = loadPage('search', { respond: () => [product('fresh')] });
  page.onLoad();
  assert.equal(calls.length, 0);
  await page.onShow();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].data)), {
    action: 'search', keyword: '', cat: '', campus: '', college: '', condition: '', tradeType: ''
  });
  assert.equal(page.data.searched, true);
  assert.equal(page.data.list[0]._id, 'fresh');
  page.onKeyword(input(' 实验  '));
  await page.onCampus(input(1));
  page.onHide();
  await page.onShow();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].data.keyword, '实验');
  assert.equal(calls[2].data.campus, CAMPUS_LIST[0]);
});

test('首页类目和学院入口在显示时只查询一次，并清除不适用的学院筛选', async () => {
  const { page, calls, storage } = loadPage('search', {
    stored: { searchCat: 'book', searchCollege: ALL_COLLEGES[0] }
  });
  page.onLoad();
  await page.onShow();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.cat, 'book');
  assert.equal(calls[0].data.college, ALL_COLLEGES[0]);
  assert.equal(storage.size, 0);
  page.onHide();
  storage.set('searchCat', 'digital');
  await page.onShow();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].data.cat, 'digital');
  assert.equal(calls[1].data.college, '');
  assert.equal(page.data.collegeIndex, 0);
});

test('首次网络断开自动重试一次，查询成功之前保持加载状态', async () => {
  let attempt = 0;
  const { page, calls, delays } = loadPage('search', {
    respond: () => ++attempt === 1 ? Promise.reject(new Error('ECONNRESET')) : [product('retried')]
  });
  page.onLoad();
  const initial = page.onShow();
  await tick();
  assert.equal(page.data.loading, true);
  assert.equal(page.data.searched, false);
  assert.equal(delays.length, 1);
  assert.equal(delays[0].delay, 500);
  delays[0].resume();
  await initial;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].data, calls[1].data);
  assert.equal(page.data.list[0]._id, 'retried');
  assert.equal(page.data.loadError, '');
});

test('首次网络失败只补试一次，切回页面后可恢复并区分成功的空结果', async () => {
  let fail = true;
  const { page, calls, delays, pullStops } = loadPage('search', {
    respond: () => fail ? Promise.reject(new Error('network connection lost')) : []
  });
  page.onLoad();
  const initial = page.onShow();
  await tick();
  delays[0].resume();
  await initial;
  assert.equal(calls.length, 2);
  assert.equal(delays.length, 1);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.searched, false);
  assert.ok(page.data.loadError);
  fail = false;
  page.onHide();
  await page.onShow();
  assert.equal(calls.length, 3);
  assert.equal(page.data.searched, true);
  assert.equal(page.data.list.length, 0);
  assert.equal(page.data.loadError, '');
  await page.onPullDownRefresh();
  assert.equal(pullStops(), 1);
});

test('业务失败不触发网络重试，同一查询失败时保留最近成功的列表', async () => {
  const failure = Object.assign(new Error('search database timeout'), { biz: true });
  let fail = true;
  const { page, delays } = loadPage('search', {
    respond: () => fail ? Promise.reject(failure) : [product('previous')]
  });
  page.onLoad();
  await page.onShow();
  assert.equal(delays.length, 0);
  fail = false;
  await page.onShow();
  fail = true;
  await page.onShow();
  assert.equal(page.data.list[0]._id, 'previous');
  assert.ok(page.data.loadError);
});

for (const change of ['离开页面', '修改查询']) {
  test(change + '后取消首次网络重试', async () => {
    const { page, calls, delays } = loadPage('search', { respond: () => Promise.reject(new Error('timeout')) });
    page.onLoad();
    const initial = page.onShow();
    await tick();
    if (change === '离开页面') page.onHide();
    else page.onKeyword(input('new'));
    delays[0].resume();
    await initial;
    assert.equal(calls.length, 1);
    if (change === '离开页面') assert.equal(page.data.loadError, '');
  });
}

test('搜索条件快速切换和页面卸载时忽略旧响应', async () => {
  const old = deferred();
  const current = deferred();
  const hidden = deferred();
  const pending = [old, current, hidden];
  const { page } = loadPage('search', { respond: () => pending.shift().promise });
  page.onLoad();
  const first = page.onShow();
  const filtered = page.onCat(tap({ key: 'book' }));
  current.resolve([product('new')]);
  await filtered;
  old.resolve([product('old')]);
  await first;
  assert.equal(page.data.list[0]._id, 'new');
  const refresh = page.onShow();
  page.onUnload();
  hidden.resolve([product('unmounted')]);
  await refresh;
  assert.equal(page.data.list[0]._id, 'new');
});

test('首页切换筛选后只显示新结果，回到首页会刷新', async () => {
  const old = deferred();
  let count = 0;
  const { page, calls } = loadPage('index', {
    respond: () => ++count === 1 ? old.promise : [product('list-' + count)]
  });
  page.onLoad();
  const initial = page.onShow();
  await page.onTab(tap({ tab: 'book' }));
  old.resolve([product('old')]);
  await initial;
  assert.equal(calls[1].data.cat, 'book');
  assert.equal(page.data.goods[0]._id, 'list-2');
  page.onHide();
  await page.onShow();
  assert.equal(page.data.goods[0]._id, 'list-3');
});

const readPages = [
  { name: 'message', service: 'chat', action: 'conversations', key: 'list', response: (id) => [{ _id: id, sellerId: 'other', unreadBuyer: 2 }] },
  { name: 'chat', service: 'chat', action: 'messages', key: 'messages', response: (id) => ({ messages: [{ _id: id, fromId: 'buyer' }], other: {} }) },
  { name: 'detail', service: 'goods', action: 'detail', key: 'goods', response: product },
  { name: 'my-goods', service: 'goods', action: 'myGoods', key: 'list', response: (id) => [product(id)] }
];

for (const { name, service, action, key, response } of readPages) {
  test(name + ' 初次进入和切回均加载，同一读取失败保留数据', async () => {
    let next = 0;
    const { page, calls } = loadPage(name, {
      user: completeUser,
      respond: () => ++next === 3 ? Promise.reject(new Error('unavailable')) : response('data-' + next)
    });
    const id = () => (Array.isArray(page.data[key]) ? page.data[key][0] : page.data[key])._id;
    if (page.onLoad) page.onLoad({ id: 'route-item' });
    await page.onShow();
    assert.equal(id(), 'data-1');
    page.onHide();
    await page.onShow();
    assert.equal(id(), 'data-2');
    await page.onShow();
    assert.equal(id(), 'data-2');
    assert.equal(calls.length, 3);
    assert.equal(calls[0].name, service);
    assert.equal(calls[0].data.action, action);
    if (name === 'detail') assert.equal(calls[0].data.id, 'route-item');
    if (name === 'chat') assert.equal(calls[0].data.conversationId, 'route-item');
  });
}

test('报价按当前子标签加载，切换后过期请求不能覆盖结果', async () => {
  const first = deferred();
  const { page, calls } = loadPage('offers', {
    user: completeUser,
    respond: (data) => data.action === 'received' ? first.promise : [{ _id: 'sent', price: 20 }]
  });
  page.onLoad({ goodsId: 'g1' });
  const received = page.onShow();
  await tick();
  await page.onTab(tap({ tab: 'sent' }));
  first.resolve([{ _id: 'old' }]);
  await received;
  assert.equal(page.data.received.length, 0);
  assert.equal(page.data.sent[0]._id, 'sent');
  page.onHide();
  await page.onShow();
  assert.deepEqual(calls.map(({ data }) => [data.action, data.goodsId]), [
    ['received', 'g1'], ['sent', 'g1'], ['sent', 'g1']
  ]);
});

test('隐藏页等到资料校验完成也不再发列表查询', async () => {
  const pending = deferred();
  const { page, calls } = loadPage('my-goods', { profile: () => pending.promise });
  const initial = page.onShow();
  page.onHide();
  pending.resolve(completeUser);
  await initial;
  assert.equal(calls.length, 0);
});

test('并发校验共用一次登录，仅仍可见的页面触发资料补全', async () => {
  const pending = deferred();
  const prompts = [];
  const { page: app } = loadPage('app', { wx: { navigateTo: (data) => prompts.push(data.url) } });
  let requests = 0;
  app.call = () => { requests++; return pending.promise; };
  const hidden = assert.rejects(app.ensureProfile(() => false), /请先完善资料/);
  const visible = assert.rejects(app.ensureProfile(), /请先完善资料/);
  pending.resolve({ _openid: 'new', profileComplete: false });
  await Promise.all([hidden, visible]);
  assert.equal(requests, 1);
  assert.deepEqual(prompts, ['/pages/profile/profile']);
});

test('发布、个人资料和 OCR 确认页返回后保留用户输入和选图', () => {
  const publish = loadPage('publish', { user: completeUser });
  publish.page.onLoad();
  publish.page.onShow();
  publish.page.onInput({ ...input('草稿'), ...tap({ field: 'title' }) });
  publish.page.onCampus(input(0));
  publish.page.setData({ images: ['local.jpg'] });
  publish.app.globalData.userInfo = { ...completeUser, campus: CAMPUS_LIST[1] };
  publish.page.onShow();
  assert.equal(publish.page.data.title, '草稿');
  assert.equal(publish.page.data.campus, CAMPUS_LIST[0]);
  assert.equal(publish.page.data.images[0], 'local.jpg');

  const profile = loadPage('profile', { user: { ...completeUser, nickName: '原昵称' } });
  profile.page.onShow();
  assert.equal(profile.page.data.nickName, '原昵称');
  profile.app.globalData.userInfo = { ...completeUser, nickName: '缓存更新' };
  profile.page.onShow();
  assert.equal(profile.page.data.nickName, '缓存更新');
  profile.page.onNickName(input('未保存的昵称'));
  profile.page.onShow();
  assert.equal(profile.page.data.nickName, '未保存的昵称');

  const ocr = loadPage('ocr-review', { stored: { ocrCandidates: { list: [{ title: '扫描结果' }], source: 'scan' } } });
  ocr.page.onLoad();
  ocr.page.onItemInput({ ...input('校对后的书名'), ...tap({ i: 0, field: 'title' }) });
  if (ocr.page.onShow) ocr.page.onShow();
  assert.equal(ocr.page.data.list[0].title, '校对后的书名');
  assert.equal(publish.calls.length + profile.calls.length + ocr.calls.length, 0);
});
