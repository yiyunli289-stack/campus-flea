'use strict';

const {events,requireThat,get,put,update,ok,key,nonce} = require('./core');

const sceneLabels = {chat:'聊天提醒',trade:'交易提醒',system:'审核与治理提醒'};
const leaseMs = 120000;
const terminalErrors = new Set([40003,40037,41030,47003,604101,-604101]);

function loadTemplates(raw) {
  let configuration;
  try { configuration = JSON.parse(raw || '{}'); } catch { return {}; }
  if (!configuration || typeof configuration !== 'object') return {};
  const templates = {};
  for (const [event, item] of Object.entries(configuration)) {
    if (!Object.hasOwn(events,event) || typeof item?.id !== 'string' || !/^[A-Za-z0-9_-]{10,100}$/.test(item.id) ||
        !item.fields || typeof item.fields !== 'object') continue;
    const fields = Object.entries(item.fields);
    const valueSource = {
      event:/^(thing|phrase)\d+$/,
      summary:/^thing\d+$/,
      time:/^(date|time)\d+$/,
      app:/^thing\d+$/
    };
    if (fields.length && fields.every(([keyword,source]) => Object.hasOwn(valueSource,source) && valueSource[source].test(keyword))) {
      templates[event] = {id:item.id,fields:Object.fromEntries(fields)};
    }
  }
  return templates;
}

function templateChoices(templates, scene) {
  const choices = new Map();
  for (const [type,tpl] of Object.entries(templates)) {
    const [category,label] = events[type];
    if (scene && scene !== category) continue;
    const choice = choices.get(tpl.id) || {templateId:tpl.id,scene:category,label:sceneLabels[category],events:[]};
    choice.events.push(label);
    choices.set(tpl.id,choice);
  }
  return [...choices.values()];
}

async function prepareSubscription(db,templates,openid,scene,now) {
  const choices = templateChoices(templates,scene);
  if (!choices.length) return ok({choices});
  const id = nonce();
  await put(db,'notificationTickets',id,{ownerId:openid,templateIds:choices.map(x=>x.templateId),
    createdAt:now,expiresAt:now+15*60000,used:false});
  return ok({ticketId:id,choices});
}

async function registerSubscription(db,templates,openid,params,now) {
  requireThat(typeof params.ticketId === 'string' && /^[a-f0-9]{32}$/.test(params.ticketId),
    'INVALID_TICKET','订阅请求已失效，请刷新后再试');
  const allowed = new Set(Object.values(templates).map(x=>x.id));
  return db.runTransaction(async tx => {
    const ticket = await get(tx,'notificationTickets',params.ticketId);
    requireThat(ticket?.ownerId === openid,'FORBIDDEN','订阅请求无效');
    if (ticket.used) return ok({accepted:ticket.accepted});
    requireThat(ticket.expiresAt > now,'INVALID_TICKET','订阅请求已失效，请刷新后再试');
    requireThat(Array.isArray(params.accepted) && params.accepted.length <= 3,'INVALID_SUBSCRIPTION','订阅结果无效');
    const accepted = [...new Set(params.accepted)];
    requireThat(accepted.every(id=>ticket.templateIds.includes(id) && allowed.has(id)),
      'INVALID_SUBSCRIPTION','订阅模板无效');
    for (const templateId of accepted) {
      const id = key('wechat-grant',params.ticketId,templateId);
      await put(tx,'notificationSubscriptions',id,{
        ownerId:openid,templateId,state:'available',createdAt:now
      });
    }
    await update(tx,'notificationTickets',params.ticketId,{used:true,accepted});
    return ok({accepted});
  });
}

function notificationView(n) {
  const registered = Object.hasOwn(events,n.type);
  return {_id:n._id,title:n.title || '平台通知',content:n.content || '',type:n.type || '',
    read:!!n.read,createdAt:n.createdAt,conversationId:registered?n.conversationId || '':'',
    offerId:registered?n.offerId || '':'',goodsId:registered?n.goodsId || '':''};
}

async function listNotifications(db,openid,params) {
  const skip = Math.min(10000,Math.max(0,Math.trunc(Number(params.skip) || 0)));
  const {data} = await db.collection('notifications').where({ownerId:openid})
    .orderBy('createdAt','desc').skip(skip).limit(30).get();
  return ok(data.map(notificationView));
}

async function notificationUnread(db,openid) {
  const {total} = await db.collection('notifications').where({ownerId:openid,read:false}).count();
  return ok({count:total});
}

async function readNotification(db,openid,id) {
  return db.runTransaction(async tx => {
    const n = await get(tx,'notifications',id);
    requireThat(n?.ownerId === openid,'FORBIDDEN','无权访问该通知');
    if (!n.read) await update(tx,'notifications',id,{read:true,readAt:Date.now()});
    return ok(notificationView({...n,read:true}));
  });
}

const shanghai = new Intl.DateTimeFormat('sv-SE',{
  timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false
});

function wxPayload(n, template, state) {
  const event = events[n.type];
  const values = {event:event[1],summary:event[2],time:shanghai.format(new Date(n.createdAt)),app:'校园二手'};
  return {
    touser:n.ownerId,templateId:template.id,miniprogramState:state,
    page:'pages/notification/notification?id='+encodeURIComponent(n._id),lang:'zh_CN',
    data:Object.fromEntries(Object.entries(template.fields).map(([keyword,source])=>[
      keyword,{value:keyword.startsWith('date') ? values[source].slice(0,10) :
        keyword.startsWith('phrase') ? values[source].slice(0,5) : values[source].slice(0,20)}
    ]))
  };
}

async function finishWithoutSend(db,id,state,now) {
  return db.runTransaction(async tx => {
    const task = await get(tx,'notificationDeliveries',id);
    if (task?.state === 'pending' && task.nextAt <= now) {
      await update(tx,'notificationDeliveries',id,{state,updatedAt:now});
    }
  });
}

async function deliver(db,templates,send,state,task,now) {
  const id = task._id;
  const n = await get(db,'notifications',task.notificationId);
  const template = n && templates[n.type];
  if (!template) return finishWithoutSend(db,id,'template_missing',now);
  const revocationId = key('wechat-revoked',n.ownerId,template.id);

  const _ = db.command;
  for (let attempt = 0; attempt < 3; attempt++) {
    const revoke = await get(db,'notificationSubscriptions',revocationId);
    const filter = {ownerId:n.ownerId,templateId:template.id,state:'available',createdAt:_.lte(n.createdAt)};
    if (revoke) filter.createdAt = _.gt(revoke.revokedAt).and(_.lte(n.createdAt));
    const {data} = await db.collection('notificationSubscriptions').where(filter)
      .orderBy('createdAt','asc').limit(1).get();
    const grantId = data[0]?._id;
    if (!grantId) return finishWithoutSend(db,id,'no_subscription',now);

    const claim = nonce();
    const claimed = await db.runTransaction(async tx => {
      const current = await get(tx,'notificationDeliveries',id);
      if (current?.state !== 'pending' || current.nextAt > now) return 'handled';
      const grant = await get(tx,'notificationSubscriptions',grantId);
      const revoked = await get(tx,'notificationSubscriptions',revocationId);
      if (grant?.state !== 'available' || grant.createdAt <= (revoked?.revokedAt || 0)) return 'raced';
      await update(tx,'notificationSubscriptions',grantId,{state:'reserved',deliveryId:id,claim});
      await update(tx,'notificationDeliveries',id,{state:'sending',grantId,claim,leaseUntil:now+leaseMs,
        attempts:current.attempts+1,updatedAt:now});
      return 'claimed';
    });
    if (claimed === 'raced') continue;
    if (claimed !== 'claimed') return;
    let result;
    try {
      const response = await send(wxPayload(n,template,state));
      const code = response?.errCode ?? response?.errcode;
      result = sendResult(code,true);
    } catch (error) {
      result = sendResult(error?.errCode ?? error?.errcode,false);
    }
    await db.runTransaction(async tx => {
      const current = await get(tx,'notificationDeliveries',id);
      if (current?.state !== 'sending' || current.claim !== claim) return;
      const retry = result.state === 'retry' && current.attempts < 4;
      const deliveryState = retry ? 'pending' : result.state === 'retry' ? 'failed' : result.state;
      const unused = ['retry','rejected'].includes(result.state);
      const grantState = unused ? 'available' : result.state === 'sent' ? 'used' : result.state;
      await update(tx,'notificationSubscriptions',grantId,{state:grantState,deliveryId:unused?'':id,claim:'',updatedAt:now});
      if (result.state === 'denied') {
        await put(tx,'notificationSubscriptions',revocationId,{kind:'revoked',ownerId:n.ownerId,templateId:template.id,revokedAt:now});
      }
      await update(tx,'notificationDeliveries',id,{
        state:deliveryState,lastCode:result.code,leaseUntil:0,updatedAt:now,
        nextAt:retry ? now+60000*2**(current.attempts-1) : 0
      });
    });
    return;
  }
}

function sendResult(value,resolved) {
  const code = value === undefined || value === null ? null : Number(value);
  if (resolved && code === 0) return {state:'sent',code};
  if (code === 43101) return {state:'denied',code};
  if (terminalErrors.has(code)) return {state:'rejected',code};
  if (code === 45009 || code === 45011 || resolved && code === -1) return {state:'retry',code};
  return {state:'uncertain',code:Number.isFinite(code)?code:null};
}

async function sweepDeliveries(db,templates,send,state,now,deadline = Infinity) {
  const _ = db.command;
  const stale = await db.collection('notificationDeliveries').where({state:'sending',leaseUntil:_.lte(now)}).limit(15).get();
  for (const row of stale.data) await db.runTransaction(async tx => {
    const item = await get(tx,'notificationDeliveries',row._id);
    if (item?.state !== 'sending' || item.leaseUntil > now) return;
    const grant = await get(tx,'notificationSubscriptions',item.grantId);
    if (grant?.state === 'reserved' && grant.claim === item.claim) {
      await update(tx,'notificationSubscriptions',grant._id,{state:'uncertain',updatedAt:now,claim:''});
    }
    await update(tx,'notificationDeliveries',item._id,{state:'uncertain',leaseUntil:0,updatedAt:now});
  });
  const pending = await db.collection('notificationDeliveries').where({state:'pending',nextAt:_.lte(now)})
    .orderBy('nextAt','asc').limit(10).get();
  for (const row of pending.data) {
    if (Date.now() >= deadline) break;
    await deliver(db,templates,send,state,row,now);
  }
}

module.exports = {
  loadTemplates,prepareSubscription,registerSubscription,listNotifications,notificationUnread,readNotification,
  wxPayload,deliver,sweepDeliveries
};
