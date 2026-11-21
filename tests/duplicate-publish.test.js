'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const jpeg = require('../cloudfunctions/goods/node_modules/jpeg-js');
const {PNG} = require('../cloudfunctions/goods/node_modules/pngjs');
const {publishWithReminder, publicListing, fingerprint, similarImage, similarTitle, matchesAttributes} =
  require('../cloudfunctions/goods/duplicate-publish');

const env = 'qa-env';
const merchant = {_id:'seller-user', _openid:'seller', nickName:'卖家', contact:'test', campus:'江安'};
const file = (name, owner = 'seller') => 'cloud://' + env + '.bucket/goods-images/' + owner + '/' + name + '.jpg';
const cover = 'cloud://' + env + '.bucket/covers/9780306406157.jpg';
const listing = (extra = {}) => ({
  _openid:'seller', sellerId:'seller', cat:'digital', title:'无线降噪蓝牙耳机', condition:'几乎全新',
  campus:'江安', price:90, images:[file('current')], ...extra
});
const active = (extra = {}) => listing({_id:'legacy', status:'on', images:[file('old')], ...extra});
const request = suffix => ({requestId:'publish-test-' + suffix});

function database(rows = []) {
  let state = {
    goods:new Map(rows.map(row => [row._id, structuredClone(row)])),
    users:new Map([[merchant._id, structuredClone(merchant)]])
  };
  let queue = Promise.resolve();
  const clone = value => structuredClone(value);
  function collection(getState, key) {
    const entries = () => getState()[key];
    return {
      doc(id) {
        return {
          async get() { return {data:clone(entries().get(id) || null)}; },
          async set({data}) { entries().set(id, {...clone(data), _id:id}); },
          async update({data}) { entries().set(id, {...entries().get(id), ...clone(data)}); }
        };
      },
      where(filter) {
        let docs = [...entries().values()].filter(row => Object.entries(filter).every(([field, value]) =>
          typeof value === 'object' ? row[field] > value.gt : row[field] === value));
        const result = {async get() { return {data:clone(docs)}; }};
        return {
          ...result,
          field() { return this; },
          orderBy() { docs.sort((a,b) => a._id.localeCompare(b._id)); return this; },
          limit(size) { docs = docs.slice(0,size); return this; }
        };
      }
    };
  }
  return {
    command:{gt:gt => ({gt})},
    collection:key => collection(() => state,key),
    runTransaction(fn) {
      const next = queue.then(async () => {
        const snapshot = clone(state);
        const result = await fn({collection:key => collection(() => snapshot,key)});
        state = snapshot;
        return result;
      });
      queue = next.catch(() => {});
      return next;
    },
    get goods() { return state.goods; },
    get user() { return state.users.get(merchant._id); }
  };
}

function image(width, height, variant = 0) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const col = Math.floor(x * 9 / width);
    const row = Math.floor(y * 8 / height);
    const shade = (col * (43 + variant) + row * (29 - variant) + (col * row % 7) * 20) % 220 + 16;
    const i = (y * width + x) * 4;
    data[i] = data[i+1] = data[i+2] = shade;
    data[i+3] = 255;
  }
  return {width, height, data};
}

const photo = jpeg.encode(image(90,80),90).data;

test('首次提醒不写商品，取消保持原记录，确认及同请求重试只写一条', async () => {
  const db = database([active()]);
  const publish = (data, params) => publishWithReminder(db, merchant, data, params, env, async () => photo);
  const params = request('first');
  const data = listing({title:'无 线降噪蓝牙耳机！', price:123});
  const warn = await publish(data, params);
  assert.equal(warn.errCode, 'DUPLICATE_PUBLISH');
  assert.deepEqual(warn.data.matches, [{_id:'legacy', title:'无线降噪蓝牙耳机'}]);
  assert.equal(db.goods.size, 1);
  assert.equal(db.user.goodsPublishRevision, undefined);

  assert.equal((await publish({...data, price:44}, {...params, duplicateConfirmation:warn.data.confirmation})).errCode, 'DUPLICATE_PUBLISH');
  const published = await publish(data, {...params, duplicateConfirmation:warn.data.confirmation});
  assert.equal(published.code, 0);
  assert.equal(db.goods.size, 2);
  assert.deepEqual(await publish(data, params), published);
  assert.equal((await publish({...data,price:321}, params)).errCode, 'PUBLISH_REQUEST_CHANGED');
  const view = publicListing(db.goods.get(published.data._id));
  assert.equal(view.publishPhotoSignatures, undefined);
  assert.equal(view.publishRequestHash, undefined);
});

test('跨文件相同内容和轻度缩放压缩均能识别，图片变化明显时排除', async () => {
  const original = fingerprint(photo);
  const resized = fingerprint(jpeg.encode(image(180,160),58).data);
  const png = fingerprint(PNG.sync.write(image(90,80)));
  const different = fingerprint(PNG.sync.write(image(90,80,31)));
  assert.notEqual(original.content,resized.content);
  assert.ok(original.visual && resized.visual && png.visual);
  assert.equal(similarImage(original,resized),true);
  assert.equal(similarImage(original,png),true);
  assert.equal(similarImage(original,different),false);
  const db = database([active()]);
  const result = await publishWithReminder(db,merchant,listing(),request('compressed'),env,
    async id => id === file('old') ? photo : jpeg.encode(image(180,160),58).data);
  assert.equal(result.errCode,'DUPLICATE_PUBLISH');
});

test('标题类型与关键属性区别明确时排除，ISBN-10 和 ISBN-13 可匹配', () => {
  assert.equal(similarTitle('无线降噪蓝牙耳机', '无线通话蓝牙耳机'),false);
  assert.equal(similarTitle('ＩＰｈｏｎｅ 14 手机 128g', 'iPhone 14 手机128G'),true);
  assert.equal(similarTitle('iPhone 13 手机', 'iPhone 14 手机'),false);
  assert.equal(similarTitle('大学物理上下册教材', '大学物理上下册教材！'),true);
  assert.equal(matchesAttributes(listing({title:'iPhone 14 Pro Max'}), listing({title:'iPhone 14 Pro'})),false);
  assert.equal(matchesAttributes(listing({model:'A50'}),listing({model:'A51'})),false);
  const a = listing({cat:'book', isbn:'0-306-40615-2', edition:'第 1 版'});
  assert.equal(matchesAttributes(a,{...a,isbn:'9780306406157',edition:'第1版'}),true);
  assert.equal(matchesAttributes(a,{...a,isbn:'9787300000000'}),false);
  assert.equal(matchesAttributes(a,{...a,edition:'第2版'}),false);
  assert.equal(matchesAttributes(a,{...a,condition:'轻微使用'}),false);
});

test('其他卖家、非在售、违规、通用封面或其他人的文件不参与比较', async () => {
  const a = active({cat:'book', title:'大学物理教材', isbn:'9780306406157', images:[cover]});
  const db = database([
    a,
    {...a,_id:'other', sellerId:'other', images:[file('old','other')]},
    {...a,_id:'off', status:'off', images:[file('old')]},
    {...a,_id:'sold', status:'sold', images:[file('old')]},
    {...a,_id:'locked', status:'locked', images:[file('old')]},
    {...a,_id:'removed', enforcement:'removed', images:[file('old')]},
    {...a,_id:'wrong-owner', images:[file('old','someone')]},
    {...a,_id:'wrong-env', images:['cloud://other-env.bucket/goods-images/seller/photo.jpg']}
  ]);
  const reads = [];
  const publish = (data, params) => publishWithReminder(db,merchant,data,params,env,async id => { reads.push(id); return photo; });
  assert.equal((await publish(listing({...a,images:[cover]}),request('catalog'))).code,0);
  assert.deepEqual(reads,[]);
  assert.equal((await publish(listing({...a,images:[file('current')]}),request('normal'))).code,0);
  assert.deepEqual(reads,[file('current')]);
});

test('候选可跨查询页，旧记录缺指纹时按需读取', async () => {
  const unrelated = Array.from({length:50},(_,i) => active({_id:'a' + String(i).padStart(2,'0'),title:'无关桌椅'}));
  const db = database([...unrelated,active({_id:'z-match'})]);
  const reads = [];
  const result = await publishWithReminder(db,merchant,listing(),request('page'),env,async id => { reads.push(id); return photo; });
  assert.equal(result.errCode,'DUPLICATE_PUBLISH');
  assert.deepEqual(reads,[file('old'),file('current')]);
  assert.equal(db.goods.get('z-match').publishPhotoSignatures,undefined);
});

test('同卖家两台设备首次扫描并发时，后提交重新检查并提示', async () => {
  const db = database();
  let ready;
  const barrier = new Promise(resolve => { ready = resolve; });
  let readers = 0;
  const read = async () => {
    readers++;
    if (readers === 2) ready();
    await barrier;
    return photo;
  };
  const [a,b] = await Promise.all([
    publishWithReminder(db,merchant,listing({images:[file('device-a')]}),request('device-a'),env,read),
    publishWithReminder(db,merchant,listing({images:[file('device-b')]}),request('device-b'),env,read)
  ]);
  assert.deepEqual([a.code,b.code].sort(),[-1,0]);
  assert.equal([a,b].find(result => result.code === -1).errCode,'DUPLICATE_PUBLISH');
  assert.equal(db.goods.size,1);
  assert.equal(db.user.goodsPublishRevision,1);
});

test('goods.publish 使用微信上下文的卖家身份并返回原有响应结构', async t => {
  const db = database([
    active({images:[file('current')]}),
    active({_id:'other-goods', sellerId:'other', images:[file('current','other')]})
  ]);
  const sdkPath = require.resolve('../cloudfunctions/goods/node_modules/wx-server-sdk');
  const goodsPath = require.resolve('../cloudfunctions/goods');
  const oldSdk = require.cache[sdkPath];
  const oldGoods = require.cache[goodsPath];
  require.cache[sdkPath] = {loaded:true, exports:{
    DYNAMIC_CURRENT_ENV:'dynamic',
    init(options) { assert.equal(options.env,'dynamic'); },
    database:options => { assert.equal(options.throwOnNotFound,false); return db; },
    getWXContext:() => ({OPENID:'seller',ENV:env}),
    async getTempFileURL() { return {fileList:[]}; }
  }};
  delete require.cache[goodsPath];
  t.after(() => {
    if (oldSdk) require.cache[sdkPath] = oldSdk;
    else delete require.cache[sdkPath];
    if (oldGoods) require.cache[goodsPath] = oldGoods;
    else delete require.cache[goodsPath];
  });
  const {main} = require(goodsPath);
  const payload = {...listing(), ...request('entry'), action:'publish', sellerId:'other', _openid:'other'};
  const warn = await main(payload);
  assert.equal(warn.code,-1);
  assert.equal(warn.errCode,'DUPLICATE_PUBLISH');
  assert.deepEqual(warn.data.matches.map(item => item._id),['legacy']);
  const result = await main({...payload,duplicateConfirmation:warn.data.confirmation});
  assert.equal(result.code,0);
  assert.equal(db.goods.get(result.data._id).sellerId,'seller');
  assert.equal(db.goods.get(result.data._id)._openid,'seller');
});

function warning(title) {
  return Object.assign(new Error('可能重复'),{rawResult:{
    errCode:'DUPLICATE_PUBLISH', data:{confirmation:'confirmation', matches:[{_id:'existing',title}]}
  }});
}

function mount(t, fileName, app, wx) {
  const previous = {wx:global.wx, getApp:global.getApp, Page:global.Page};
  let definition;
  global.wx = wx;
  global.getApp = () => app;
  global.Page = value => { definition = value; };
  const location = require.resolve(fileName);
  delete require.cache[location];
  require(location);
  t.after(() => {
    for (const [key,value] of Object.entries(previous)) global[key] = value;
    delete require.cache[location];
  });
  return {
    ...definition,
    data:structuredClone(definition.data),
    setData(value) {
      for (const [key, update] of Object.entries(value)) {
        const fields = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        const target = fields.slice(0,-1).reduce((row, field) => row[field], this.data);
        target[fields.at(-1)] = update;
      }
    }
  };
}

function runtime() {
  const storage = new Map();
  const uploads = [];
  const modals = [];
  const ui = {
    getStorageSync:key => structuredClone(storage.get(key)),
    setStorageSync:(key,value) => storage.set(key,structuredClone(value)),
    removeStorageSync:key => storage.delete(key),
    showLoading() {}, hideLoading() {}, showToast() {}, switchTab() {}, redirectTo() {},
    showModal(config) { modals.push(config); config.success({confirm:ui.confirmDuplicates}); },
    cloud:{async uploadFile(value) { uploads.push(value); return {fileID:'cloud://' + env + '.bucket/' + value.cloudPath}; }}
  };
  const app = {globalData:{userInfo:merchant}, async ensureProfile() { return merchant; }};
  return {app, ui, storage, uploads, modals};
}

test('普通发布弹窗取消保留草稿，继续使用同一请求和已上传照片', async t => {
  const {app,ui,storage,uploads,modals} = runtime();
  const sent = [];
  app.call = async (name,payload) => {
    assert.equal(name,'goods');
    sent.push(payload);
    if (!payload.duplicateConfirmation) throw warning('耳机');
    return {_id:'published'};
  };
  const page = mount(t,'../miniprogram/pages/publish/publish.js',app,ui);
  page.onLoad();
  page.setData({cat:'digital',title:'无线耳机',price:'60',images:['wxfile://temp.jpg']});
  await Promise.all([page.onPublish(),page.onPublish()]);
  assert.equal(uploads.length,1);
  assert.equal(sent.length,1);
  assert.equal(modals[0].confirmText,'继续发布');
  assert.ok(storage.has('goodsDraft'));
  ui.confirmDuplicates = true;
  await page.onPublish();
  assert.equal(uploads.length,1);
  assert.equal(sent.length,3);
  assert.equal(sent[0].requestId,sent[2].requestId);
  assert.deepEqual(sent[0].images,sent[2].images);
  assert.equal(storage.has('goodsDraft'),false);
});

test('OCR 批量部分成功时留存跳过和失败条目，重进页面只重试剩余条目', async t => {
  const {app,ui,uploads,modals} = runtime();
  const books = ['成功', '相似', '失败'].map((title,index) => ({
    id:'book-' + index, title, price:'30', edition:'第1版', noteLevel:'无笔记',
    cover, images:index === 1 ? ['wxfile://book.jpg'] : []
  }));
  ui.setStorageSync('ocrCandidates',{list:books,source:'scan'});
  const sent = new Map();
  let fail = true;
  app.call = async (name,payload) => {
    const list = sent.get(payload.title) || [];
    sent.set(payload.title,list.concat(payload));
    if (payload.title === '相似' && !payload.duplicateConfirmation) throw warning('同版本旧书');
    if (payload.title === '失败' && fail) throw new Error('网络中断');
    return {_id:payload.title};
  };
  const page = mount(t,'../miniprogram/pages/ocr-review/ocr-review.js',app,ui);
  page.onLoad();
  await page.onPublish();
  assert.deepEqual(ui.getStorageSync('ocrCandidates').list.map(book => book.title),['相似','失败']);
  assert.match(modals.at(-1).content,/成功 1 本，跳过 1 本，失败 1 本/);
  assert.equal(uploads.length,1);

  fail = false;
  ui.confirmDuplicates = true;
  page.onLoad();
  await page.onPublish();
  assert.deepEqual(page.data.list,[]);
  assert.equal(ui.getStorageSync('ocrCandidates'),undefined);
  assert.equal(sent.get('成功').length,1);
  assert.equal(uploads.length,1);
  for (const title of ['相似','失败']) {
    assert.equal(new Set(sent.get(title).map(payload => payload.requestId)).size,1);
  }
  const template = fs.readFileSync(require.resolve('../miniprogram/pages/ocr-review/ocr-review.wxml'),'utf8');
  for (const handler of ['onChoosePhotos','onRemovePhoto']) {
    assert.match(template,new RegExp('bindtap="' + handler + '"'));
    assert.equal(typeof page[handler],'function');
  }
});
