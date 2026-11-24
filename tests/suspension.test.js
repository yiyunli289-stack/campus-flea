'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('./helpers');
const {adminAction} = require('../shared/server/governance');
const {runWorker} = require('../shared/server/worker');
const {migrate} = require('../scripts/migrate');
const {hour} = require('../shared/server/trade-state');

function govern(f,targetType,targetId,action,extra = {}) {
  return adminAction(f.s,f.reviewer,{op:'govern',targetType,targetId,action,confirm:true,reason:'核查处置',...extra});
}
function call(f,name,action,user,data = {}) {
  return f.s.mini(name,{action,...data},user);
}
function code(expected) { return error => error.code === expected; }

test('后验审核拦截违规商品，关联交易即时结束，异步任务通知双方',async () => {
  const f = await fixture();
  const goodsId = await f.listing({title:'待后验检测'});
  assert.equal((await call(f,'goods','search',null))[0]._id,goodsId);
  const offer = await call(f,'offer','create','buyer',{goodsId,price:80});
  const {conversationId} = await call(f,'offer','accept','seller',{offerId:offer._id});
  assert.equal((await call(f,'chat','messages','buyer',{conversationId})).other.contact,'contact-seller');
  f.provider.image = async () => ({status:'pending',traceId:'late-reject'});
  await runWorker(f.s);
  await require('../shared/server/moderation').imageCallback(f.s,'late-reject',false);
  const detail = await call(f,'goods','detail','buyer',{id:goodsId});
  assert.equal(detail.status,'removed');
  assert.equal(detail.desc,undefined);
  assert.deepEqual(detail.images,[]);
  assert.equal((await call(f,'offer','sent','buyer'))[0].goodsCover,'');
  const chat = await call(f,'chat','messages','buyer',{conversationId});
  assert.equal(chat.canSend,false);
  assert.equal(chat.other.contact,'');
  await assert.rejects(call(f,'goods','relist','seller',{id:goodsId}),code('INVALID_STATE'));
  await runWorker(f.s);
  await runWorker(f.s);
  assert.equal((await f.store.get('offers',offer._id)).status,'closed');
  assert.equal((await f.store.find('notifications',{targetId:offer._id,type:'offer.removed'})).length,2);
});

test('买家被封禁后迅速解封，旧面交仍结束，卖家可以手动重新上架',async () => {
  const f = await fixture();
  const goodsId = await f.listing();
  const offer = await call(f,'offer','create','buyer',{goodsId,price:90});
  const {conversationId} = await call(f,'offer','accept','seller',{offerId:offer._id});
  await govern(f,'users','buyer','ban');
  assert.equal((await call(f,'login','state','buyer')).accountStatus,'banned');
  assert.equal((await call(f,'goods','detail','seller',{id:goodsId})).status,'off');
  assert.equal((await call(f,'chat','messages','seller',{conversationId})).canSend,false);
  await assert.rejects(call(f,'governance','uploadTicket','buyer'),code('ACCOUNT_BANNED'));
  await call(f,'report','appeal','buyer',{targetType:'users',targetId:'buyer',reason:'请复核'});
  await govern(f,'users','buyer','unrestrict');
  await call(f,'goods','relist','seller',{id:goodsId});
  const again = await call(f,'offer','create','buyer',{goodsId,price:90});
  await runWorker(f.s,50);
  assert.equal((await f.store.get('offers',offer._id)).status,'closed');
  assert.equal((await f.store.get('offers',again._id)).status,'pending');
  assert.equal((await call(f,'chat','messages','buyer',{conversationId})).canSend,false);
});

test('限制范围和到期用于已登录账号，拉黑及注销撤销联系方式',async () => {
  const f = await fixture();
  const goodsId = await f.listing();
  const c = await call(f,'chat','open','buyer',{goodsId});
  const conversationId = c._id;
  await call(f,'chat','shareContact','buyer',{conversationId,confirm:true});
  assert.equal((await call(f,'chat','messages','buyer',{conversationId})).other.contact,'');
  await call(f,'chat','shareContact','seller',{conversationId,confirm:true});
  assert.equal((await call(f,'chat','messages','buyer',{conversationId})).other.contact,'contact-seller');
  await govern(f,'users','buyer','restrict',{restrictions:['message'],hours:1});
  await assert.rejects(call(f,'chat','send','buyer',{conversationId,content:'测试'}),code('ACCOUNT_RESTRICTED'));
  await call(f,'offer','create','buyer',{goodsId,price:90});
  assert.equal((await call(f,'chat','messages','buyer',{conversationId})).other.contact,'');
  f.tick(hour);
  assert.equal((await call(f,'login','state','buyer')).accountStatus,'normal');
  assert.equal((await call(f,'chat','messages','buyer',{conversationId})).canSend,true);
  await call(f,'governance','block','buyer',{targetId:'seller'});
  assert.equal((await call(f,'chat','messages','seller',{conversationId})).other.contact,'');
  await assert.rejects(call(f,'governance','closeAccount','buyer',{confirm:true}),code('CONFIRM_REQUIRED'));
  await call(f,'governance','closeAccount','buyer',{confirm:true,confirmation:'注销账号'});
  assert.equal((await call(f,'login','login','buyer')).accountStatus,'deleted');
  assert.equal((await f.store.get('users','buyer')).contact,'');
  assert.equal((await f.store.get('users','buyer')).campus,undefined);
  await assert.rejects(call(f,'chat','messages','buyer',{conversationId}),code('ACCOUNT_DELETED'));
  assert.equal((await call(f,'chat','messages','seller',{conversationId})).canSend,false);
});

test('报价到期、面交提醒、恢复在售和撤回售出按时间执行',async () => {
  const f = await fixture();
  const goodsId = await f.listing({offerDurationHours:24});
  const expired = await call(f,'offer','create','buyer',{goodsId,price:90});
  f.tick(24*hour);
  await assert.rejects(call(f,'offer','accept','seller',{offerId:expired._id}),code('INVALID_STATE'));
  await runWorker(f.s);
  assert.equal((await f.store.get('offers',expired._id)).status,'expired');
  let selected = await call(f,'offer','create','buyer',{goodsId,price:90});
  await call(f,'offer','accept','seller',{offerId:selected._id});
  f.tick(24*hour);
  await runWorker(f.s);
  assert.equal((await f.store.find('notifications',{type:'offer.meetup-reminder'})).length,2);
  await assert.rejects(call(f,'offer','restoreListing','seller',{offerId:selected._id}),code('INVALID_STATE'));
  f.tick(24*hour);
  await call(f,'offer','restoreListing','seller',{offerId:selected._id});
  assert.equal((await call(f,'goods','detail','buyer',{id:goodsId})).status,'on');
  selected = await call(f,'offer','create','buyer',{goodsId,price:90});
  await call(f,'offer','accept','seller',{offerId:selected._id});
  await call(f,'goods','complete','seller',{id:goodsId});
  await call(f,'goods','undoSold','seller',{id:goodsId});
  await runWorker(f.s,50);
  assert.equal((await f.store.get('goods',goodsId)).status,'locked');
  assert.equal((await f.store.get('offers',selected._id)).status,'accepted');
});

test('草稿和软删除保持私有，普通下架重上无须等待审核',async () => {
  const f = await fixture();
  const draft = await call(f,'goods','saveDraft','seller',{title:'还没完成'});
  await assert.rejects(call(f,'goods','detail','buyer',{id:draft._id}),code('NOT_FOUND'));
  await call(f,'goods','remove','seller',{id:draft._id});
  assert.equal((await f.store.get('goods',draft._id)).status,'deleted');
  const goodsId = await f.listing();
  await call(f,'goods','offShelf','seller',{id:goodsId});
  await call(f,'goods','relist','seller',{id:goodsId});
  assert.equal((await call(f,'goods','search',null))[0].moderationStatus,'review');
});

test('迁移预览只读，旧在售商品留在搜索且重复执行不覆盖审核或处罚',async () => {
  const f = await fixture();
  await f.store.put('goods','legacy',{sellerId:'seller',status:'on',title:'旧在售商品',createdAt:new Date(f.s.now())});
  await f.store.put('goods','removed',{sellerId:'seller',status:'on',title:'旧违规商品',moderationStatus:'rejected'});
  await f.store.put('goods','approved',{sellerId:'seller',status:'on',title:'已审核商品',moderationStatus:'approved'});
  const preview = await migrate(f.s);
  assert.equal(preview.goodsQueued,1);
  assert.equal((await f.store.get('goods','legacy')).moderationTaskId,undefined);
  await migrate(f.s,{apply:true});
  assert.equal((await f.store.get('goods','approved')).moderationStatus,'approved');
  assert.equal((await f.store.get('goods','removed')).enforcement,'removed');
  assert.deepEqual((await call(f,'goods','search',null)).map(g=>g._id).sort(),['approved','legacy']);
  assert.equal((await migrate(f.s,{apply:true})).goodsQueued,0);
});


test('封号后不能登记已签发的上传凭证，登记结果使用服务端私有副本',async () => {
  const f = await fixture();
  const good = await call(f,'governance','uploadTicket','buyer');
  const registered = await call(f,'governance','registerMedia','buyer',{id:good.id,fileID:good.fileID});
  assert.match(registered.fileID,/registered/);
  assert.equal((await call(f,'governance','registerMedia','buyer',{id:good.id,fileID:good.fileID})).fileID,registered.fileID);
  const outstanding = await call(f,'governance','uploadTicket','buyer');
  await govern(f,'users','buyer','ban');
  await assert.rejects(call(f,'governance','registerMedia','buyer',{id:outstanding.id,fileID:outstanding.fileID}),code('ACCOUNT_BANNED'));
  assert.equal((await f.store.get('mediaFiles',outstanding.id)).state,'ticket');
});
