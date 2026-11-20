'use strict';
const { id, assert } = require('./core');
const trade = require('./trade-state');
const moderation = require('./moderation');

const batchSize = 50;
const activeOffers = ['pending', 'accepted'];

function sameField(field, value) {
  return value ? { [field]:value } : { $or:[{ [field]:'' }, { [field]:{ $exists:false } }] };
}

async function closeOffer(s, tx, o, status, reason, message) {
  await tx.put('offers',o._id,{...o,status,closedReason:reason,updatedAt:s.now()});
  await s.notify(tx,o.buyerId,'offer.'+reason,o._id,message);
  await s.notify(tx,o.sellerId,'offer.'+reason,o._id,message);
}

async function deliverMessage(s, messageId) {
  return s.store.transaction(async tx => {
    const m = await tx.get('messages',messageId);
    if (!m || m.moderationStatus !== 'approved' || m.deliveryState) return false;
    const c = await tx.get('conversations',m.conversationId);
    const g = c && await tx.get('goods',c.goodsId);
    const validParticipants = c && m.fromId !== m.toId && [m.fromId,m.toId].every(x => [c.buyerId,c.sellerId].includes(x));
    if (!validParticipants || !await s.chatAvailable(c,g,tx)) {
      await tx.put('messages',m._id,{...m,deliveryState:'blocked'});
      return false;
    }
    await tx.put('messages',m._id,{...m,deliveredAt:s.now(),deliveryState:'delivered'});
    const unread = m.toId === c.buyerId ? 'unreadBuyer' : 'unreadSeller';
    await tx.put('conversations',c._id,{...c,lastMsg:m.content,lastTime:m.createdAt,updatedAt:s.now(),[unread]:(c[unread] || 0)+1});
    await s.notify(tx,m.toId,'message.reply',m._id,'收到一条新回复');
    return false;
  });
}

async function handleGoodsState(s, task) {
  const d = task.data;
  const gen = d.tradeVersion || '';
  const selected = d.selectedId || '';
  const closeOthers = task.kind === 'close-other-offers';
  const status = closeOthers ? ['pending'] : activeOffers;
  const filter = { goodsId:d.goodsId, status:{ $in:status }, ...sameField('tradeVersion',gen) };
  if (closeOthers && selected) filter._id = { $ne:selected };
  if (d.tradeVersion === undefined) filter.createdAt = { $lte:d.createdAt || task.createdAt || s.now() };
  const rows = await s.store.find('offers',filter,{limit:batchSize});
  for (const row of rows) await s.store.transaction(async tx => {
    const o = await tx.get('offers',row._id);
    if (!o || !status.includes(o.status) || trade.generation(o) !== gen || closeOthers && o._id === selected) return;
    if (closeOthers) {
      await tx.put('offers',o._id,{...o,status:'rejected',closedReason:'not_selected',updatedAt:s.now()});
      await s.notify(tx,o.buyerId,'offer.not_selected',o._id,'卖家已选择其他申请，你的申请已关闭');
    } else {
      await closeOffer(s,tx,o,'closed',d.state,'商品状态已变化，购买申请已结束');
    }
  });
  if (closeOthers) return rows.length === batchSize;
  const conversations = await s.store.find('conversations',{
    goodsId:d.goodsId,state:{ $ne:'readonly' },...sameField('tradeVersion',gen)
  },{limit:batchSize});
  for (const row of conversations) await s.store.transaction(async tx => {
    const c = await tx.get('conversations',row._id);
    if (!c || trade.generation(c) !== gen || c.state === 'readonly') return;
    const current = await tx.get('goods',d.goodsId);
    if (d.tradeVersion === undefined && trade.generation(current) === gen &&
        ['on','locked'].includes(await s.listingState(current,tx))) return;
    await tx.put('conversations',c._id,{...c,state:'readonly',contactConsent:null});
  });
  return rows.length === batchSize || conversations.length === batchSize && d.tradeVersion !== undefined;
}

async function handleAccountClosure(s, task) {
  const {openid,previousEpoch,deleted} = task.data;
  const oldEpoch = previousEpoch || '';
  const owner = await s.findUser(openid);
  if (!owner || previousEpoch === undefined && !trade.blockedAccount(owner)) return false;
  const goods = await s.store.find('goods',{
    sellerId:openid, status:{ $in:['on','locked'] }, ...sameField('sellerEpoch',oldEpoch)
  },{limit:batchSize});
  for (const row of goods) await s.store.transaction(async tx => {
    const g = await tx.get('goods',row._id);
    if (!g || !['on','locked'].includes(g.status) || (g.sellerEpoch || '') !== oldEpoch) return;
    await trade.closeTrade(s,tx,g,'off',deleted?'account_deleted':'account_banned');
  });
  let more = goods.length === batchSize;
  for (const side of ['buyer','seller']) {
    const rows = await s.store.find('offers',{
      [side+'Id']:openid,status:{ $in:activeOffers },...sameField(side+'Epoch',oldEpoch)
    },{limit:batchSize});
    for (const row of rows) await s.store.transaction(async tx => {
      const o = await tx.get('offers',row._id);
      if (!o || !activeOffers.includes(o.status) || (o[side+'Epoch'] || '') !== oldEpoch) return;
      const g = await tx.get('goods',o.goodsId);
      if (o.status === 'accepted' && g?.status === 'locked' && g.buyerId === openid &&
          (g.buyerEpoch || '') === oldEpoch && trade.generation(o) === trade.generation(g)) {
        await trade.closeTrade(s,tx,g,'off',deleted?'account_deleted':'account_banned');
      }
      await closeOffer(s,tx,o,'closed',deleted?'account_deleted':'account_banned','关联账号状态已变化，购买申请已关闭');
    });
    const conversations = await s.store.find('conversations',{
      [side+'Id']:openid,state:{ $ne:'readonly' },...sameField(side+'Epoch',oldEpoch)
    },{limit:batchSize});
    for (const row of conversations) await s.store.transaction(async tx => {
      const c = await tx.get('conversations',row._id);
      if (c && (c[side+'Epoch'] || '') === oldEpoch && c.state !== 'readonly') {
        await tx.put('conversations',c._id,{...c,state:'readonly',contactConsent:null});
      }
    });
    more ||= rows.length === batchSize || conversations.length === batchSize;
  }
  return more;
}

async function notifyListingEdit(s, task) {
  const d = task.data;
  const filter = { goodsId:d.goodsId,status:'pending',createdAt:{ $lte:d.beforeTime },...sameField('tradeVersion',d.tradeVersion) };
  if (d.cursor) filter._id = { $gt:d.cursor };
  const rows = await s.store.find('offers',filter,{sort:'_id',asc:true,limit:batchSize});
  for (const row of rows) await s.store.transaction(async tx => {
    const o = await tx.get('offers',row._id);
    const g = await tx.get('goods',row.goodsId);
    const { seller,buyer } = await trade.parties(s,g,row.buyerId,tx);
    if (o && trade.offerState(o,g,seller,buyer,s.now()) === 'pending') {
      await s.notify(tx,o.buyerId,'listing.edited',task.targetId+':'+o._id,'商品信息已修改，请核对详情，必要时可撤回申请');
    }
  });
  return rows.length === batchSize ? rows.at(-1)._id : false;
}

async function remindMeetup(s, { goodsId,offerId }) {
  return s.store.transaction(async tx => {
    const g = await tx.get('goods',goodsId);
    const o = await tx.get('offers',offerId);
    if (!o || g?.meetupConfirmedAt) return false;
    const {seller,buyer} = await trade.parties(s,g,o.buyerId,tx);
    if (trade.offerState(o,g,seller,buyer,s.now()) === 'accepted') {
      await s.notify(tx,o.sellerId,'offer.meetup-reminder',offerId,'请确认面交安排，锁定满48小时仍无进展可恢复在售');
      await s.notify(tx,o.buyerId,'offer.meetup-reminder',offerId,'请与卖家确认面交安排');
    }
    return false;
  });
}

async function expireOffers(s) {
  const expired = await s.store.find('offers',{status:'pending',expiresAt:{ $lte:s.now() }},{limit:batchSize});
  for (const row of expired) await s.store.transaction(async tx => {
    const o = await tx.get('offers',row._id);
    if (o?.status === 'pending' && o.expiresAt <= s.now()) {
      await closeOffer(s,tx,o,'expired','expired','购买申请已到期');
    }
  });
}

async function processTask(s, task) {
  switch (task.kind) {
    case 'review-goods': await moderation.reviewGoods(s,task.data); return false;
    case 'message-visible': return deliverMessage(s,task.data.messageId);
    case 'close-other-offers':
    case 'goods-state': return handleGoodsState(s,task);
    case 'user-ban': return handleAccountClosure(s,task);
    case 'listing-edited': return notifyListingEdit(s,task);
    case 'meetup-reminder': return remindMeetup(s,task.data);
    default: assert(false,'UNKNOWN_TASK','未知后台任务');
  }
}
async function runWorker(s,maximum=10) {
  await expireOffers(s);
  async function drainCallbacks() {
    const callbacks = await s.store.find('settings',{kind:'mediaCallback',processed:false,
      $or:[{retryAt:{$exists:false}},{retryAt:{$lte:s.now()}}]},{limit:20});
    for (const c of callbacks) {
      const result = await moderation.imageCallback(s,c.traceId,c.approved);
      if (result.deferred) await s.store.transaction(async tx => {
        const current = await tx.get('settings',result.inboxKey);
        if (current && !current.processed) await tx.put('settings',current._id,{
          ...current,receivedAt:current.receivedAt || s.now(),retryAt:s.now()+120000
        });
      });
    }
  }
  const now=s.now();
  const rows=await s.store.find('outboxTasks',{$or:[{state:'pending',nextAt:{$lte:now}},{state:'running',leaseUntil:{$lte:now}}]},{sort:'createdAt',asc:true,limit:maximum});
  let completed=0;
  for(const candidate of rows) {
    const lease=id();
    const claimed=await s.store.transaction(async tx=>{
      const t=await tx.get('outboxTasks',candidate._id);
      if(!t || t.state==='done'||t.state==='failed'||t.nextAt>s.now()||(t.state==='running' && t.leaseUntil>s.now())) return false;
      await tx.put('outboxTasks',t._id,{...t,state:'running',lease,leaseUntil:s.now()+120000});return true;
    });
    if(!claimed) continue;
    let more=false;let error=null;
    try {more=await processTask(s,candidate);completed++;} catch(e) {error=e;}
    await s.store.transaction(async tx=>{
      const t=await tx.get('outboxTasks',candidate._id);if(t.lease!==lease)return;
      const attempts=error?t.attempts+1:t.attempts;
      await tx.put('outboxTasks',t._id,{...t,data:typeof more==='string'?{...t.data,cursor:more}:t.data,state:error?(attempts>=5?'failed':'pending'):more?'pending':'done',attempts,
        nextAt:s.now()+(error?Math.min(3600000,1000*2**attempts):0),lastError:error?String(error.code||'INTERNAL_ERROR'):'',completedAt:!error&&!more?s.now():0,leaseUntil:0});
    });
  }
  await drainCallbacks();
  // Pending media without callbacks remain reviewable; mark stale tasks for operator attention.
  const stale=await s.store.find('moderationTasks',{status:'review',timeoutNoted:{$ne:true},createdAt:{$lte:s.now()-30*60000}},{limit:50});
  for(const t of stale) if(!t.timeoutNoted) await s.store.transaction(async tx=>{const current=await tx.get('moderationTasks',t._id);await tx.put('moderationTasks',t._id,{...current,timeoutNoted:true,reason:'检测超时或需人工复核'});});
  return {completed};
}
module.exports={runWorker,processTask};
