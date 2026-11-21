'use strict';

const cloud = require('wx-server-sdk');
const {get,update,nonce} = require('./lib/core');
const {loadTemplates,sweepDeliveries} = require('./lib/delivery');
const {expireOffers,processBusinessTask} = require('./lib/trade');

cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db = cloud.database({throwOnNotFound:false});

async function runTasks(now,deadline) {
  const _ = db.command;
  const {data} = await db.collection('notificationTasks')
    .where(_.or([{state:'pending',nextAt:_.lte(now)},{state:'running',leaseUntil:_.lte(now)}]))
    .orderBy('nextAt','asc').limit(5).get();
  for (const candidate of data) {
    if (Date.now() >= deadline) break;
    const claim = nonce();
    const task = await db.runTransaction(async tx => {
      const item = await get(tx,'notificationTasks',candidate._id);
      const runnable = item?.state === 'pending' && item.nextAt <= now ||
        item?.state === 'running' && item.leaseUntil <= now;
      if (!runnable) return null;
      await update(tx,'notificationTasks',item._id,{state:'running',claim,leaseUntil:now+120000});
      return item;
    });
    if (!task) continue;
    let cursor = '';
    let problem;
    try { cursor = await processBusinessTask(db,task,now,deadline); }
    catch (error) { problem = String(error.code || error.errCode || 'UNKNOWN'); }
    await db.runTransaction(async tx => {
      const current = await get(tx,'notificationTasks',task._id);
      if (current?.claim !== claim) return;
      const attempts = current.attempts+(problem?1:0);
      const state = problem ? attempts < 5?'pending':'failed' : cursor?'pending':'done';
      await update(tx,'notificationTasks',task._id,{
        state,attempts,leaseUntil:0,lastCode:problem || '',
        payload:cursor?{...current.payload,cursor}:current.payload,
        nextAt:problem?now+60000*2**(attempts-1):now
      });
    });
  }
}

exports.main = async (event = {}) => {
  const timer = process.env.TRIGGER_SRC === 'timer' || process.env.TCB_SOURCE === 'timer';
  if (cloud.getWXContext().OPENID || !timer || event.Type !== 'Timer' || event.TriggerName !== 'notification-minute') {
    return {code:-1,msg:'只允许平台定时任务调用'};
  }
  const state = ['developer','trial','formal'].includes(process.env.WECHAT_NOTIFICATION_STATE)
    ? process.env.WECHAT_NOTIFICATION_STATE : 'developer';
  const templates = loadTemplates(process.env.WECHAT_NOTIFICATION_TEMPLATES);
  const start = Date.now();
  for (const [deadline,action] of [
    [start+28_000, end => sweepDeliveries(db,templates,payload=>cloud.openapi.subscribeMessage.send(payload),state,Date.now(),end)],
    [start+42_000, end => runTasks(Date.now(),end)],
    [start+48_000, end => expireOffers(db,Date.now(),end)]
  ]) {
    if (Date.now() >= deadline) continue;
    try { await action(deadline); } catch(error) { console.error('notification worker',error?.code || error?.errCode || 'UNKNOWN'); }
  }
  return {code:0};
};
