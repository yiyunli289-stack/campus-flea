'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {hour,recordNotice,get,update,validPending} = require('../shared/notifications/core');
const trade = require('../shared/notifications/trade');
const delivery = require('../shared/notifications/delivery');

const start = 1_800_000_000_000;
const ref = n => 'notice-request-' + n;
const templateId = 'template-id-12345';
const templates = delivery.loadTemplates(JSON.stringify({
  'chat.message':{id:templateId,fields:{thing1:'summary',time2:'time'}},
  'offer.created':{id:'template-offer-1234',fields:{thing1:'event',date2:'time'}},
  'unknown':{id:'anything-123456',fields:{thing1:'event'}}
}));

function memory(listing = {}) {
  let state = {
    goods:{g:{_id:'g',sellerId:'seller',title:'二手教材',cat:'book',price:45,images:[],
      tradeType:'定价',noteLevel:'无笔记',status:'on',offerDurationHours:48,...listing}}
  };
  let queue = Promise.resolve();
  const command = {
    lte:value=>({test:v=>v <= value}),
    gt:value=>({test:v=>v > value,and:other=>({test:v=>v > value && other.test(v)})}),
    exists:flag=>({test:v=>(v !== undefined) === flag}),
    or:clauses=>({testRow:row=>clauses.some(filter=>matches(row,filter))})
  };
  function matches(row,filter) {
    if (filter.testRow) return filter.testRow(row);
    return Object.entries(filter).every(([k,v]) => v?.test ? v.test(row[k]) : row[k] === v);
  }
  function accessor(resolve, name) {
    const current = () => (resolve()[name] ||= {});
    return {
      doc(id) {
        return {
          async get() {return {data:structuredClone(current()[id] || null)};},
          async set({data}) {current()[id] = {_id:id,...structuredClone(data)};},
          async update({data}) {current()[id] = {...current()[id],...structuredClone(data)};},
          async remove() {delete current()[id];}
        };
      },
      where(filter) {
        let rows = Object.values(current()).filter(row => matches(row,filter));
        return {
          orderBy(field,dir) {
            rows.sort((a,b)=> (a[field] > b[field] ? 1 : a[field] === b[field] ? 0 : -1) * (dir === 'desc'?-1:1));
            return this;
          },
          limit(n) {rows=rows.slice(0,n);return this;},
          skip(n) {rows=rows.slice(n);return this;},
          async count() {return {total:rows.length};},
          async get() {return {data:structuredClone(rows)};}
        };
      }
    };
  }
  return {
    command, collection:name=>accessor(()=>state,name),
    runTransaction(fn) {
      const next = queue.then(async () => {
        const copy = structuredClone(state);
        const result = await fn({collection:name=>accessor(()=>copy,name)});
        state = copy;
        return result;
      });
      queue = next.catch(()=>{});
      return next;
    },
    rows(name) {return Object.values(state[name] || {});}
  };
}

function notices(db,type) { return db.rows('notifications').filter(row=>!type || row.type === type); }
function exception(code) {return error=>error.code === code;}
function open(db,buyer = 'buyer') {return trade.chatOpen(db,{goodsId:'g'},buyer,start);}
function offer(db,buyer = 'buyer',params = {},now = start) {
  return trade.submitOffer(db,{action:'create',goodsId:'g',requestId:ref(buyer),price:41,...params},buyer,now);
}
async function addNotice(db,type,ownerId,source,createdAt) {
  return db.runTransaction(tx=>recordNotice(tx,{type,ownerId,source,createdAt,conversationId:'example-chat'}));
}
async function subscribe(db,owner,at,accepted = [templateId]) {
  const {data:{ticketId}} = await delivery.prepareSubscription(db,templates,owner,'chat',at);
  await delivery.registerSubscription(db,templates,owner,{ticketId,accepted},at);
  return ticketId;
}

test('首次普通咨询提醒卖家，重复和并发打开只创建一条会话与通知', async () => {
  const db = memory();
  const [a,b] = await Promise.all([open(db),open(db)]);
  assert.equal(a.data._id,b.data._id);
  assert.equal(db.rows('messages').length,1);
  assert.equal(db.rows('conversations')[0].unreadSeller,1);
  assert.deepEqual(notices(db,'chat.consult').map(n=>n.ownerId),['seller']);
  assert.equal(db.rows('notificationDeliveries').length,1);
});

test('新回复送给对方且重试不重复，本人的通知才可读取', async () => {
  const db = memory();
  const conv = (await open(db)).data._id;
  const input = {conversationId:conv,content:'聊天原文和联系方式',requestId:ref('send')};
  await Promise.all([trade.chatSend(db,input,'seller',start+10),trade.chatSend(db,input,'seller',start+10)]);
  await assert.rejects(trade.chatSend(db,input,'other',start+10),exception('FORBIDDEN'));
  assert.equal(db.rows('messages').length,2);
  const reply = notices(db,'chat.message')[0];
  assert.equal(reply.ownerId,'buyer');
  assert.equal(reply.content,'你有一条新回复');
  assert.equal((await delivery.notificationUnread(db,'buyer')).data.count,1);
  await assert.rejects(delivery.readNotification(db,'seller',reply._id),exception('FORBIDDEN'));
  assert.equal((await delivery.readNotification(db,'buyer',reply._id)).data.conversationId,conv);
  assert.equal((await delivery.notificationUnread(db,'buyer')).data.count,0);
  assert.equal((await delivery.listNotifications(db,'buyer',{})).data.length,1);
});

test('按标价购买以服务器价格创建申请和会话卡片，只发送一次新申请提醒', async () => {
  const db = memory();
  const [a,b] = await Promise.all([offer(db),offer(db)]);
  assert.deepEqual(a,b);
  assert.equal(db.rows('offers')[0].price,45);
  assert.equal(db.rows('messages')[0].kind,'offer');
  assert.equal(a.data.conversationId,(await open(db)).data._id);
  assert.equal(notices(db,'chat.consult').length,0);
  assert.deepEqual(notices(db,'offer.created').map(n=>n.ownerId),['seller']);
  await assert.rejects(offer(db,'buyer',{requestId:ref('another')}),exception('DUPLICATE_OFFER'));
});

test('竞价修改、撤回、拒绝和自动到期分别通知正确用户', async () => {
  const db = memory({tradeType:'竞价',offerDurationHours:24});
  const id = (await offer(db)).data._id;
  const params = {action:'update',offerId:id,price:43,requestId:ref('change')};
  await assert.rejects(trade.submitOffer(db,params,'buyer',start+299999),exception('TOO_SOON'));
  await trade.submitOffer(db,params,'buyer',start+300000);
  await trade.submitOffer(db,params,'buyer',start+300100);
  assert.equal((await get(db,'offers',id)).expiresAt,start+24*hour);
  assert.deepEqual(notices(db,'offer.updated').map(n=>n.ownerId),['seller']);
  await trade.changeOffer(db,{action:'cancel',offerId:id},'buyer',start+301000);
  assert.deepEqual(notices(db,'offer.withdrawn').map(n=>n.ownerId),['seller']);
  const rejected = (await offer(db,'buyer',{requestId:ref('decline')},start+400000)).data._id;
  await trade.changeOffer(db,{action:'decline',offerId:rejected},'seller',start+400010);
  assert.deepEqual(notices(db,'offer.declined').map(n=>n.ownerId),['buyer']);
  const expiring = (await offer(db,'buyer',{requestId:ref('expire')},start+500000)).data._id;
  await trade.expireOffers(db,start+500000+24*hour);
  await trade.expireOffers(db,start+500000+24*hour);
  assert.equal((await get(db,'offers',expiring)).status,'expired');
  assert.deepEqual(notices(db,'offer.expired').map(n=>n.ownerId),['buyer']);
});

test('并发接受只成功一次，未选中提醒不包含选中者和成交金额', async () => {
  const db = memory();
  const a = (await offer(db,'buyer')).data._id;
  const b = (await offer(db,'other')).data._id;
  const results = await Promise.allSettled([a,b].map(offerId=>trade.changeOffer(db,{action:'accept',offerId},'seller',start+1)));
  assert.equal(results.filter(row=>row.status === 'fulfilled').length,1);
  const task = db.rows('notificationTasks').find(row=>row.type === 'close-offers');
  await trade.processBusinessTask(db,task,start+2);
  await trade.processBusinessTask(db,task,start+2);
  const winner = notices(db,'offer.accepted')[0];
  const loser = notices(db,'offer.unselected')[0];
  assert.notEqual(winner.ownerId,loser.ownerId);
  assert.equal(loser.content,'该购买申请未被选中');
  assert.equal(notices(db,'offer.unselected').length,1);
});

test('面交提醒通知双方，取消或恢复后旧任务不能结束新的报价', async () => {
  const db = memory();
  const id = (await offer(db)).data._id;
  await trade.changeOffer(db,{action:'accept',offerId:id},'seller',start+1);
  const scheduled = db.rows('notificationTasks').find(row=>row.type === 'meetup');
  assert.equal(scheduled.nextAt,start+1+24*hour);
  await trade.processBusinessTask(db,scheduled,scheduled.nextAt);
  await trade.processBusinessTask(db,scheduled,scheduled.nextAt);
  assert.deepEqual(notices(db,'trade.meetup').map(n=>n.ownerId).sort(),['buyer','seller']);
  await trade.changeOffer(db,{action:'restoreListing',offerId:id},'seller',start+1+48*hour);
  const newOffer = (await offer(db,'buyer',{requestId:ref('new')},start+2+48*hour)).data._id;
  for (const task of db.rows('notificationTasks')) await trade.processBusinessTask(db,task,start+3+48*hour);
  assert.equal((await get(db,'offers',newOffer)).status,'pending');
  assert.deepEqual(notices(db,'trade.cancelled').map(n=>n.ownerId),['buyer']);
});

test('书况变更通知有效报价买家，普通下架及时撤销交易资格并关闭旧报价', async () => {
  const db = memory();
  const ids = [];
  for (const who of ['buyer','other']) ids.push((await offer(db,who)).data._id);
  await trade.listingAction(db,{action:'edit',id:'g',noteLevel:'少量'},'seller',start+1);
  await trade.processBusinessTask(db,db.rows('notificationTasks')[0],start+2);
  assert.deepEqual(notices(db,'goods.changed').map(n=>n.ownerId).sort(),['buyer','other']);
  await trade.listingAction(db,{action:'offShelf',id:'g'},'seller',start+3);
  const pending = await get(db,'offers',ids[0]);
  assert.equal(validPending(pending,await get(db,'goods','g'),start+4),false);
  await trade.listingAction(db,{action:'relist',id:'g'},'seller',start+4);
  const newer = (await offer(db,'buyer',{requestId:ref('newer')},start+5)).data._id;
  await trade.processBusinessTask(db,db.rows('notificationTasks').find(row=>row.type === 'close-offers'),start+6);
  assert.equal((await get(db,'offers',newer)).status,'pending');
  assert.deepEqual(notices(db,'goods.off').map(n=>n.ownerId).sort(),['buyer','other']);
});

test('售出与治理内部接口提供站内结果，历史记录可读', async () => {
  const db = memory();
  const id = (await offer(db)).data._id;
  await trade.changeOffer(db,{action:'accept',offerId:id},'seller',start+1);
  await trade.listingAction(db,{action:'complete',id:'g'},'seller',start+2);
  assert.equal((await get(db,'offers',id)).status,'completed');
  assert.deepEqual(notices(db,'goods.sold').map(n=>n.ownerId),['buyer']);
  for (const type of ['moderation.result','report.result','appeal.result']) {
    await addNotice(db,type,'buyer','decided',start+3);
    await addNotice(db,type,'buyer','decided',start+3);
    assert.equal(notices(db,type).length,1);
  }
  assert.equal((await delivery.listNotifications(db,'buyer',{})).data.length,5);
});

test('拒绝授权与未配置模板的消息保留站内通知，授权编号只能本人使用一次', async () => {
  const db = memory();
  const input = await subscribe(db,'buyer',start,[]);
  await assert.rejects(delivery.registerSubscription(db,templates,'other',{ticketId:input,accepted:[templateId]},start),exception('FORBIDDEN'));
  const replay = await delivery.registerSubscription(db,templates,'buyer',{ticketId:input,accepted:[templateId]},start);
  assert.deepEqual(replay.data.accepted,[]);
  const notice = await addNotice(db,'chat.message','buyer','rejected',start+1);
  const missing = await addNotice(db,'trade.cancelled','buyer','no-template',start+2);
  await delivery.sweepDeliveries(db,templates,()=>assert.fail('unauthorized send'),'trial',start+3);
  assert.equal((await get(db,'notificationDeliveries',notice)).state,'no_subscription');
  assert.equal((await get(db,'notificationDeliveries',missing)).state,'template_missing');
  assert.equal((await delivery.notificationUnread(db,'buyer')).data.count,2);
  assert.deepEqual(await delivery.prepareSubscription(db,{},'buyer','chat',start),{code:0,data:{choices:[]}});
});

test('一份授权只发送一条微信摘要，额度耗尽或晚授权的旧消息不发送', async () => {
  const db = memory();
  const old = await addNotice(db,'chat.message','buyer','old',start-1);
  const ticketId = await subscribe(db,'buyer',start);
  await delivery.registerSubscription(db,templates,'buyer',{ticketId,accepted:[templateId]},start);
  const sent = [];
  const send = async payload => {sent.push(payload);return {errCode:0};};
  const first = await addNotice(db,'chat.message','buyer','first',start+1);
  const second = await addNotice(db,'chat.message','buyer','second',start+2);
  await Promise.all([0,1].map(()=>delivery.sweepDeliveries(db,templates,send,'trial',start+3)));
  assert.equal(sent.length,1);
  assert.equal(sent[0].touser,'buyer');
  assert.equal(sent[0].miniprogramState,'trial');
  assert.equal(sent[0].page,'pages/notification/notification?id='+first);
  assert.deepEqual(sent[0].data.thing1,{value:'你有一条新回复'});
  assert.equal((await get(db,'notificationDeliveries',old)).state,'no_subscription');
  assert.equal((await get(db,'notificationDeliveries',second)).state,'no_subscription');
  assert.equal((await get(db,'notificationDeliveries',first)).state,'sent');
});

test('明确失败重试，拒收后失效，结果不确定时保留记录且不重复发送', async () => {
  const db = memory();
  await subscribe(db,'buyer',start);
  await subscribe(db,'buyer',start+1);
  const id = await addNotice(db,'chat.message','buyer','retry',start+2);
  let sends = 0;
  await delivery.sweepDeliveries(db,templates,async()=>{sends++;return {errCode:45009};},'developer',start+3);
  assert.equal((await get(db,'notificationDeliveries',id)).state,'pending');
  await delivery.sweepDeliveries(db,templates,async()=>{sends++;return {errCode:43101};},'developer',start+60004);
  assert.equal((await get(db,'notificationDeliveries',id)).state,'denied');
  const blocked = await addNotice(db,'chat.message','buyer','blocked',start+60005);
  await delivery.sweepDeliveries(db,templates,()=>assert.fail('revoked send'),'developer',start+60006);
  assert.equal((await get(db,'notificationDeliveries',blocked)).state,'no_subscription');

  await subscribe(db,'buyer',start+60007);
  const uncertain = await addNotice(db,'chat.message','buyer','timeout',start+60008);
  await delivery.sweepDeliveries(db,templates,async()=>{sends++;throw new Error('connection lost');},'developer',start+60009);
  await delivery.sweepDeliveries(db,templates,()=>assert.fail('ambiguous resend'),'developer',start+60010);
  assert.equal((await get(db,'notificationDeliveries',uncertain)).state,'uncertain');
  assert.equal((await delivery.notificationUnread(db,'buyer')).data.count,3);
  assert.equal(sends,3);
});

test('过期的发送租约归档为结果不确定，微信提醒从用户点击同步发起', async t => {
  const db = memory();
  const id = await addNotice(db,'chat.message','buyer','crash',start);
  await update(db,'notificationDeliveries',id,{state:'sending',leaseUntil:start+1,grantId:'missing',claim:'old'});
  await delivery.sweepDeliveries(db,templates,()=>assert.fail('stale resend'),'developer',start+2);
  assert.equal((await get(db,'notificationDeliveries',id)).state,'uncertain');

  const previous = global.wx;
  let invoked = false;
  global.wx = {requestSubscribeMessage(options) {invoked = true;assert.deepEqual(options.tmplIds,[templateId]);}};
  t.after(()=>global.wx=previous);
  const {subscribeTap} = require('../miniprogram/utils/notifications');
  subscribeTap({_subscriptionTicket:'preloaded'},{currentTarget:{dataset:{template:templateId}}});
  assert.equal(invoked,true);
});

test('通知跳转路由和新增模板绑定在小程序入口可用', t => {
  const root=path.resolve(__dirname,'../miniprogram');
  const config=JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'));
  assert.ok(config.pages.includes('pages/notification/notification'));
  const app=global.getApp;
  const page=global.Page;
  t.after(()=>{global.getApp=app;global.Page=page;});
  global.getApp=()=>({});
  for (const route of ['notification','chat','message','offers','my-goods','publish','detail']) {
    let handlers;
    global.Page=definition=>handlers=definition;
    const base=path.join(root,'pages',route,route);
    require(base+'.js');
    const markup=fs.readFileSync(base+'.wxml','utf8');
    for (const event of markup.matchAll(/\b(?:bind|catch):?[a-z]+="([A-Za-z_]\w*)"/g)) {
      assert.equal(typeof handlers[event[1]],'function',route+' '+event[1]);
    }
  }
});
