'use strict';
const { id, assert } = require('./core');
async function processTask(s,t) {
  const d=t.data;
  if(t.kind==='message-visible') {
    return s.store.transaction(async tx=>{
      const m=await tx.get('messages',d.messageId);if(!m || m.moderationStatus!=='approved' || m.deliveredAt) return false;
      const c=await tx.get('conversations',m.conversationId);const g=c?await tx.get('goods',c.goodsId):null;
      let allowed=!!g && await s.visible(g,tx) && ['on','locked'].includes(g.status) && !await s.blocked(m.fromId,m.toId,tx);
      try {await s.user(m.fromId,'message',tx);} catch(e) {if(['ACCOUNT_BANNED','ACCOUNT_RESTRICTED','PROFILE_REQUIRED'].includes(e.code)) allowed=false;else throw e;}
      if(!allowed) {await tx.put('messages',m._id,{...m,deliveryState:'blocked'});return false;}
      await tx.put('messages',m._id,{...m,deliveredAt:s.now(),deliveryState:'delivered'});
      const unread=m.toId===c.buyerId?'unreadBuyer':'unreadSeller';
      await tx.put('conversations',c._id,{...c,lastMsg:m.content,lastTime:m.createdAt,updatedAt:s.now(),[unread]:(c[unread]||0)+1});
      await s.notify(tx,m.toId,'message.reply',m._id,'收到一条新回复');return false;
    });
  }
  if(t.kind==='close-other-offers' || t.kind==='goods-state') {
    const goodsId=d.goodsId;const g=await s.store.get('goods',goodsId);
    if (d.state==='removed' && g?.enforcement!=='removed') return false;
    const filter={goodsId,status:{$in:t.kind==='close-other-offers'?['pending']:['pending','accepted']},createdAt:{$lte:d.createdAt ?? t.createdAt ?? s.now()}};
    const rows=await s.store.find('offers',filter,{limit:100});
    for(const o of rows) {
      if(o._id===d.selectedId) continue;
      await s.store.transaction(async tx=>{
        const current=await tx.get('offers',o._id);
        const listing=await tx.get('goods',goodsId);
        if(d.state==='removed' && listing?.enforcement!=='removed') return;
        if(!current || !['pending','accepted'].includes(current.status)) return;
        const status=t.kind==='close-other-offers'?'rejected':d.state==='sold'?'completed':'closed';
        await tx.put('offers',o._id,{...current,status,closedReason:t.kind==='close-other-offers'?'not_selected':d.state,updatedAt:s.now()});
        await s.notify(tx,o.buyerId,t.kind==='close-other-offers'?'offer.not_selected':'offer.closed',o._id,t.kind==='close-other-offers'?'卖家已选择其他申请，你的申请已关闭':'商品状态已变化，购买申请已结束');
      });
    }
    if(t.kind==='goods-state') {
      const state=g?.enforcement==='removed'?'removed':g?.status || 'off';
      const conversations=await s.store.find('conversations',{goodsId,state:{$ne:state}},{limit:100});
      for(const c of conversations) await s.store.transaction(async tx=>{const current=await tx.get('conversations',c._id);await tx.put('conversations',c._id,{...current,state});});
      if(conversations.length===100) return true;
    }
    return rows.length===100;
  }
  if(t.kind==='user-ban') {
    const u=await s.user(d.openid,null,s.store,false);if(u.accountStatus!=='banned') return false;
    const rows=await s.store.find('goods',{sellerId:d.openid,enforcement:{$ne:'removed'},status:{$in:['on','locked']}},{limit:100});
    for(const g of rows) await s.store.transaction(async tx=>{
      const current=await tx.get('goods',g._id);const owner=await s.user(d.openid,null,tx,false);if(owner.accountStatus!=='banned') return;
      if (!current || current.enforcement==='removed' || !['on','locked'].includes(current.status)) return;
      await tx.put('goods',g._id,{...current,enforcement:'removed',statusBeforeRemoval:current.status,status:'off',updatedAt:s.now()});
      await s.enqueue(tx,'goods-state',t._id+':'+g._id,{goodsId:g._id,state:'removed'});
    });
    const offers=await s.store.find('offers',{$or:[{buyerId:d.openid},{sellerId:d.openid}],status:{$in:['pending','accepted']}},{limit:100});
    for(const o of offers)await s.store.transaction(async tx=>{
      const cur=await tx.get('offers',o._id);if(!['pending','accepted'].includes(cur.status))return;
      await tx.put('offers',o._id,{...cur,status:'closed',closedReason:'account_banned',updatedAt:s.now()});
      const g=await tx.get('goods',o.goodsId);
      if(g?.status==='locked'&&g.buyerId===d.openid){await tx.put('goods',g._id,{...g,status:'off',buyerId:'',updatedAt:s.now()});await s.enqueue(tx,'goods-state',t._id+':buyer:'+g._id,{goodsId:g._id,state:'off'});}
      await s.notify(tx,o.buyerId,'offer.closed',o._id,'关联账号状态已变化，购买申请已关闭');
      await s.notify(tx,o.sellerId,'offer.closed.seller',o._id,'关联账号状态已变化，购买申请已关闭');
    });
    return rows.length===100||offers.length===100;
  }
  assert(false,'UNKNOWN_TASK','未知后台任务');
}
async function runWorker(s,maximum=10) {
  const callbacks=await s.store.find('settings',{kind:'mediaCallback',processed:false},{limit:20});
  for(const c of callbacks)await require('./moderation').imageCallback(s,c.traceId,c.approved);
  const now=s.now();
  const rows=await s.store.find('outboxTasks',{$or:[{state:'pending',nextAt:{$lte:now}},{state:'running',leaseUntil:{$lte:now}}]},{sort:'createdAt',asc:true,limit:maximum});
  let completed=0;
  for(const candidate of rows) {
    const lease=id();
    const claimed=await s.store.transaction(async tx=>{
      const t=await tx.get('outboxTasks',candidate._id);
      if(!t || t.state==='done'||t.state==='failed'||(t.state==='running' && t.leaseUntil>s.now())) return false;
      await tx.put('outboxTasks',t._id,{...t,state:'running',lease,leaseUntil:s.now()+120000});return true;
    });
    if(!claimed) continue;
    let more=false;let error=null;
    try {more=await processTask(s,candidate);completed++;} catch(e) {error=e;}
    await s.store.transaction(async tx=>{
      const t=await tx.get('outboxTasks',candidate._id);if(t.lease!==lease)return;
      const attempts=error?t.attempts+1:t.attempts;
      await tx.put('outboxTasks',t._id,{...t,state:error?(attempts>=5?'failed':'pending'):more?'pending':'done',attempts,
        nextAt:s.now()+(error?Math.min(3600000,1000*2**attempts):0),lastError:error?String(error.code||'INTERNAL_ERROR'):'',completedAt:!error&&!more?s.now():0,leaseUntil:0});
    });
  }
  // Pending media without callbacks remain reviewable; mark stale tasks for operator attention.
  const stale=await s.store.find('moderationTasks',{status:'review',timeoutNoted:{$ne:true},createdAt:{$lte:s.now()-30*60000}},{limit:50});
  for(const t of stale) if(!t.timeoutNoted) await s.store.transaction(async tx=>{const current=await tx.get('moderationTasks',t._id);await tx.put('moderationTasks',t._id,{...current,timeoutNoted:true,reason:'检测超时或需人工复核'});});
  return {completed};
}
module.exports={runWorker,processTask};
