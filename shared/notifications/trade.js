'use strict';

const {
  hour,requireThat,key,nonce,get,put,update,ok,isParticipant,text,requestKey,recordNotice,queueTask,
  invalidListing,cycle,due,validPending,quoteExpiryHours,lookupConversation,newConversation,addMessage
} = require('./core');

function assertRelated(offer, openid) {
  requireThat(isParticipant(offer,openid),'FORBIDDEN','无权操作该购买申请');
}

function assertAvailable(goods) {
  requireThat(!invalidListing(goods) && goods.status === 'on','INVALID_STATE','商品当前不可交易');
}

function priceOf(value,max = 9999) {
  const price = Number(value);
  requireThat(price > 0 && price <= max && Number.isSafeInteger(Math.round(price * 100)) &&
    Math.abs(price * 100 - Math.round(price * 100)) < 1e-7,'INVALID_PRICE',
    Number.isFinite(max) ? '请输入 0.01 至 9999 元的有效金额' : '请输入有效报价金额');
  return price;
}

function offerNotice(tx,o,type,ownerId,source,now,convId = o.conversationId) {
  return recordNotice(tx,{type,ownerId,source,conversationId:convId,offerId:o._id,goodsId:o.goodsId,createdAt:now});
}

async function chatOpen(db, params, openid, now) {
  const g = await get(db,'goods',params.goodsId);
  requireThat(g,'NOT_FOUND','商品不存在');
  const buyerId = g.sellerId === openid ? g.buyerId : openid;
  requireThat(buyerId && buyerId !== g.sellerId,'INVALID_STATE','尚未锁定买家');
  const id = await lookupConversation(db,g,buyerId);

  return db.runTransaction(async tx => {
    const current = await get(tx,'goods',g._id);
    requireThat(!invalidListing(current) && current.sellerId === g.sellerId,'INVALID_STATE','商品不可用');
    const existing = await get(tx,'conversations',id);
    if (existing) {
      requireThat(isParticipant(existing,openid),'FORBIDDEN','无权查看会话');
      return ok(existing);
    }
    const on = current.status === 'on' && g.sellerId !== openid;
    const locked = current.status === 'locked' && current.buyerId === buyerId;
    requireThat(on || locked,'INVALID_STATE','商品当前不可发起会话');
    const conv = newConversation(current,buyerId,now);
    const fromBuyer = openid === buyerId;
    if (fromBuyer && on) {
      await addMessage(tx,key('consult-message',id),id,conv,{actorId:openid,ownerId:g.sellerId,
        content:'买家发起了商品咨询',kind:'consult',now});
      await recordNotice(tx,{type:'chat.consult',ownerId:g.sellerId,source:id,conversationId:id,goodsId:g._id,createdAt:now});
    } else {
      await put(tx,'conversations',id,conv);
    }
    return ok({_id:id,...conv});
  });
}

async function chatSend(db, params, openid, now) {
  const content = text(params.content,1000,true);
  const id = key('chat-send',openid,params.conversationId,requestKey(params));
  return db.runTransaction(async tx => {
    const conv = await get(tx,'conversations',params.conversationId);
    requireThat(isParticipant(conv,openid),'FORBIDDEN','无权操作会话');
    const prior = await get(tx,'messages',id);
    if (prior) {
      requireThat(prior.content === content,'INVALID_REQUEST','请重新发送已修改的内容');
      return ok({_id:conv._id,messageId:id});
    }
    const goods = await get(tx,'goods',conv.goodsId);
    requireThat(!invalidListing(goods) && (goods.status === 'on' ||
      goods.status === 'locked' && goods.buyerId === conv.buyerId),'INVALID_STATE','当前会话只读');
    const recipient = openid === conv.sellerId ? conv.buyerId : conv.sellerId;
    await addMessage(tx,id,conv._id,conv,{actorId:openid,ownerId:recipient,content,kind:'text',now});
    await recordNotice(tx,{type:'chat.message',ownerId:recipient,source:id,conversationId:conv._id,goodsId:conv.goodsId,createdAt:now});
    return ok({_id:conv._id,messageId:id});
  });
}

async function submitOffer(db, params, openid, now) {
  const before = params.action === 'update' ? await get(db,'offers',params.offerId) : null;
  if (params.action === 'update') {
    requireThat(before?.buyerId === openid,'FORBIDDEN','无权修改报价');
  }
  const g = await get(db,'goods',before?.goodsId || params.goodsId);
  requireThat(g && g.sellerId !== openid,'INVALID_STATE','不能申请自己的商品');
  const eventId = key('submit-offer',openid,g._id,requestKey(params));
  const payload = {action:params.action,offerId:before?._id || '',price:params.price,
    message:params.message,meetingPlace:params.meetingPlace,meetingTime:params.meetingTime};
  const fingerprint = key('offer-fields',payload);
  const convId = await lookupConversation(db,g,openid);
  const legacy = (await db.collection('offers').where({goodsId:g._id,buyerId:openid,status:'pending'})
    .orderBy('createdAt','desc').limit(1).get()).data[0];

  return db.runTransaction(async tx => {
    const receipt = await get(tx,'notificationRequests',eventId);
    if (receipt) {
      requireThat(receipt.fingerprint === fingerprint,'INVALID_REQUEST','申请内容已变化，请重新提交');
      return ok(receipt.result);
    }
    const goods = await get(tx,'goods',g._id);
    assertAvailable(goods);
    const existingConv = await get(tx,'conversations',convId);
    const existing = await get(tx,'offers',before?._id || existingConv?.activeOfferId || legacy?._id);
    const modifying = validPending(existing,goods,now);
    if (params.action === 'update') requireThat(modifying,'INVALID_STATE','仅可修改有效竞价');
    if (modifying) {
      requireThat(goods.tradeType === '竞价','DUPLICATE_OFFER','已有有效购买申请');
      requireThat(existing.buyerId === openid && now >= Number(existing.updatedAt || existing.createdAt) + 300000,
        'TOO_SOON','更新报价至少间隔 5 分钟');
    }
    const conv = existingConv || newConversation(goods,openid,now);
    requireThat(conv.buyerId === openid && conv.sellerId === goods.sellerId,'FORBIDDEN','会话身份无效');
    const id = modifying ? existing._id : key('purchase-offer',eventId);
    const o = {
      _openid:openid,goodsId:goods._id,goodsTitle:goods.title,goodsCover:goods.images?.[0] || '',
      sellerId:goods.sellerId,buyerId:openid,tradeType:goods.tradeType,
      price:goods.tradeType === '竞价' ? priceOf(params.price,Infinity) : priceOf(goods.price),
      message:text(params.message ?? (modifying ? existing.message : ''),200),
      meetingPlace:text(params.meetingPlace ?? (modifying ? existing.meetingPlace : ''),150),
      meetingTime:text(params.meetingTime ?? (modifying ? existing.meetingTime : ''),100),
      status:'pending',createdAt:modifying ? existing.createdAt : now,updatedAt:now,
      expiresAt:modifying ? due(existing) : now + quoteExpiryHours(goods.offerDurationHours || 48) * hour,
      conversationId:convId,listingCycle:cycle(goods)
    };
    const type = modifying ? 'offer.updated' : goods.tradeType === '竞价' ? 'offer.bid' : 'offer.created';
    const note = modifying ? '买家已更新报价' : goods.tradeType === '竞价' ? '买家提交了竞价' : '买家提交了购买申请';
    await put(tx,'offers',id,o);
    await addMessage(tx,key('offer-card',eventId),convId,{...conv,activeOfferId:id},{
      actorId:openid,ownerId:goods.sellerId,content:note,kind:'offer',offerId:id,now
    });
    await offerNotice(tx,{...o,_id:id},type,goods.sellerId,eventId,now);
    const result = {_id:id,conversationId:convId,status:'pending'};
    await put(tx,'notificationRequests',eventId,{fingerprint,result,createdAt:now});
    return ok(result);
  });
}

async function changeOffer(db,params,openid,now) {
  const action = params.action;
  const selection = await get(db,'offers',params.offerId);
  assertRelated(selection,openid);
  const goods = await get(db,'goods',selection.goodsId);
  requireThat(goods,'NOT_FOUND','商品不存在');
  const convId = selection.conversationId || await lookupConversation(db,goods,selection.buyerId);

  return db.runTransaction(async tx => {
    const o = await get(tx,'offers',selection._id);
    const g = await get(tx,'goods',selection.goodsId);
    const c = await get(tx,'conversations',convId);
    assertRelated(o,openid);
    const sellerActs = o.sellerId === openid;
    const isBuyer = !sellerActs;
    const valid = validPending(o,g,now);
    const status = action === 'accept' ? 'accepted' : action === 'cancel' ? 'cancelled' : action === 'decline' ? 'rejected' : '';
    if (action === 'accept') {
      requireThat(sellerActs,'FORBIDDEN','只有卖家可以接受申请');
      if (o.status === 'accepted' && g?.acceptedOfferId === o._id) return ok({status,conversationId:convId});
      requireThat(valid,'INVALID_STATE','商品或申请状态已变化');
      await update(tx,'offers',o._id,{status,acceptedAt:now,conversationId:convId,updatedAt:now});
      await update(tx,'goods',g._id,{status:'locked',buyerId:o.buyerId,dealPrice:o.price,
        acceptedOfferId:o._id,lockedAt:now,meetupConfirmedAt:0,updatedAt:now});
      const conv = c || newConversation(g,o.buyerId,now);
      await addMessage(tx,key('offer-accepted-message',o._id),convId,conv,{
        actorId:openid,ownerId:o.buyerId,content:'交易已锁定，成交价 ¥'+o.price+'，请线下联系完成面交',kind:'offer',offerId:o._id,now
      });
      await offerNotice(tx,o,'offer.accepted',o.buyerId,o._id,now,convId);
      await queueTask(tx,'close-offers',o._id,{
        goodsId:g._id,listingCycle:cycle(g),cutoff:now,exclude:o._id,type:'offer.unselected',status:'rejected'
      },now);
      await queueTask(tx,'meetup',o._id,{goodsId:g._id,offerId:o._id,lockedAt:now},now,now + 24 * hour);
      return ok({status,conversationId:convId});
    }
    if (action === 'decline' || action === 'cancel') {
      requireThat((sellerActs && action === 'decline') || (isBuyer && action === 'cancel'),'FORBIDDEN','无权处理该申请');
      if (o.status === status && o.closedBy === openid && o.closedAction === action) return ok({status});
      requireThat(valid,'INVALID_STATE','该申请已结束');
      await update(tx,'offers',o._id,{status,updatedAt:now,closedBy:openid,closedAction:action});
      await offerNotice(tx,o,action === 'decline' ? 'offer.declined' : 'offer.withdrawn',
        sellerActs ? o.buyerId : o.sellerId,o._id,now,convId);
      return ok({status});
    }
    if (action === 'cancelLock' || action === 'restoreListing' || action === 'confirmMeetup') {
      if (o.status === 'closed' && o.closedBy === openid && o.closedAction === action) return ok({status:'closed'});
      requireThat(!invalidListing(g) && g.status === 'locked' && g.buyerId === o.buyerId &&
        (!g.acceptedOfferId || g.acceptedOfferId === o._id) && o.status === 'accepted',
        'INVALID_STATE','该锁定已结束');
      const lockedAt = Number(g.lockedAt || o.acceptedAt || g.updatedAt);
      if (action === 'confirmMeetup') {
        if (!g.meetupConfirmedAt) {
          await update(tx,'goods',g._id,{meetupConfirmedAt:now,updatedAt:now});
          await offerNotice(tx,o,'trade.meetup-confirmed',sellerActs?o.buyerId:o.sellerId,o._id,now,convId);
        }
        return ok({status:'accepted'});
      }
      if (action === 'restoreListing') {
        requireThat(sellerActs && !g.meetupConfirmedAt && now >= lockedAt + 48 * hour,
          'INVALID_STATE','满 48 小时未确认面交后可由卖家恢复在售');
      } else {
        text(params.reason,200,true);
      }
      await update(tx,'offers',o._id,{status:'closed',closedBy:openid,closedAction:action,updatedAt:now});
      await update(tx,'goods',g._id,{status:'on',buyerId:'',dealPrice:null,acceptedOfferId:'',
        lockedAt:0,meetupConfirmedAt:0,listingCycle:nonce(),updatedAt:now});
      await offerNotice(tx,o,'trade.cancelled',sellerActs?o.buyerId:o.sellerId,o._id,now,convId);
      return ok({status:'closed'});
    }
    requireThat(false,'NOT_FOUND','未知申请操作');
  });
}

function listingPatch(params, listing) {
  const cfg = {title:100,condition:50,noteLevel:30,noteDesc:1000,defects:1000};
  const changes = {};
  for (const [key,limit] of Object.entries(cfg)) {
    if (params[key] === undefined) continue;
    if (['noteLevel','noteDesc','defects'].includes(key)) requireThat(listing.cat === 'book','INVALID_INPUT','仅图书可修改书况');
    const value = text(params[key],limit,['title','condition','noteLevel'].includes(key));
    if (key === 'condition') requireThat(['全新','几乎全新','轻微使用','明显使用'].includes(value),'INVALID_INPUT','请选择有效成色');
    if (key === 'noteLevel') requireThat(['无笔记','少量','较多','大量'].includes(value),'INVALID_INPUT','请选择有效笔记等级');
    if (value !== (listing[key] || '')) changes[key] = value;
  }
  if (params.price !== undefined) {
    const price = priceOf(params.price);
    if (price !== listing.price) changes.price = price;
  }
  if (params.offerDurationHours !== undefined) {
    const hours = quoteExpiryHours(params.offerDurationHours);
    if (hours !== (listing.offerDurationHours || 48)) changes.offerDurationHours = hours;
  }
  return changes;
}

async function listingAction(db,params,openid,now) {
  const action = params.action;
  const old = await get(db,'goods',params.id);
  requireThat(old?.sellerId === openid,'FORBIDDEN','无权操作商品');
  const selected = action === 'complete' && old.status === 'locked' && !old.acceptedOfferId
    ? (await db.collection('offers').where({goodsId:old._id,buyerId:old.buyerId,status:'accepted'}).limit(1).get()).data[0]
    : null;
  return db.runTransaction(async tx => {
    const g = await get(tx,'goods',old._id);
    requireThat(g?.sellerId === openid,'FORBIDDEN','无权操作商品');
    if (action === 'edit') {
      assertAvailable(g);
      const changes = listingPatch(params,g);
      if (!Object.keys(changes).length) return ok({status:g.status,changed:false});
      const version = nonce();
      await update(tx,'goods',g._id,{...changes,updatedAt:now});
      if (Object.keys(changes).some(field=>field !== 'offerDurationHours')) {
        await queueTask(tx,'listing-changed',version,{goodsId:g._id,listingCycle:cycle(g),cutoff:now},now);
      }
      return ok({status:g.status,changed:true});
    }
    if (action === 'relist') {
      requireThat(g.status === 'off' && !invalidListing(g),'INVALID_STATE','当前商品不可上架');
      await update(tx,'goods',g._id,{status:'on',buyerId:'',acceptedOfferId:'',dealPrice:null,
        listingCycle:nonce(),updatedAt:now});
      return ok({status:'on'});
    }

    const closing = action === 'offShelf';
    const sold = action === 'complete';
    const removing = action === 'remove';
    requireThat((closing && g.status === 'on') || (sold && g.status === 'locked') ||
      (removing && g.status !== 'locked'),'INVALID_STATE','当前商品状态不允许该操作');
    const epoch = nonce();
    if (sold) {
      const o = await get(tx,'offers',g.acceptedOfferId || selected?._id);
      if (o?.status === 'accepted' && o.buyerId === g.buyerId) {
        await update(tx,'offers',o._id,{status:'completed',updatedAt:now});
        await offerNotice(tx,o,'goods.sold',o.buyerId,epoch,now);
      } else if (g.buyerId) {
        await recordNotice(tx,{type:'goods.sold',ownerId:g.buyerId,source:epoch,goodsId:g._id,createdAt:now});
      }
    }
    const status = sold ? 'sold' : 'off';
    if (removing) await tx.collection('goods').doc(g._id).remove();
    else await update(tx,'goods',g._id,{status,listingCycle:epoch,updatedAt:now});
    if (closing || sold || removing && g.status === 'on') {
      await queueTask(tx,'close-offers',epoch,{
        goodsId:g._id,listingCycle:cycle(g),cutoff:now,type:sold?'goods.sold':'goods.off',status:'closed'
      },now);
    }
    return ok(removing?{removed:true}:{status});
  });
}

async function expireOffers(db,now,deadline = Infinity) {
  const _ = db.command;
  const common = {status:'pending'};
  const rows = await Promise.all([
    db.collection('offers').where({...common,expiresAt:_.lte(now)}).limit(25).get(),
    db.collection('offers').where({...common,expiresAt:_.exists(false),createdAt:_.lte(now-48*hour)}).limit(25).get()
  ]);
  for (const o of rows.flatMap(res=>res.data)) {
    if (Date.now() >= deadline) break;
    await db.runTransaction(async tx => {
      const current = await get(tx,'offers',o._id);
      if (current?.status !== 'pending' || due(current) > now) return;
      const goods = await get(tx,'goods',current.goodsId);
      const sameListing = !invalidListing(goods) && cycle(goods) === (current.listingCycle || '');
      const unselected = sameListing && goods.status === 'locked' && due(current) > (goods.lockedAt || goods.updatedAt);
      const status = unselected ? 'rejected' : sameListing && goods.status === 'on' ? 'expired' : 'closed';
      const type = unselected ? 'offer.unselected' : status === 'expired' ? 'offer.expired' : 'goods.off';
      await update(tx,'offers',current._id,{status,updatedAt:now});
      await offerNotice(tx,current,type,current.buyerId,current._id,now);
    });
  }
}

async function processBusinessTask(db,task,now,deadline = Infinity) {
  const d = task.payload;
  if (task.type === 'meetup') {
    await db.runTransaction(async tx => {
      const g = await get(tx,'goods',d.goodsId);
      const o = await get(tx,'offers',d.offerId);
      if (invalidListing(g) || g.lockedAt !== d.lockedAt || g.status !== 'locked' || g.meetupConfirmedAt ||
          o?.status !== 'accepted' || g.acceptedOfferId !== o._id) return;
      for (const who of [o.buyerId,o.sellerId]) await offerNotice(tx,o,'trade.meetup',who,d.offerId,now);
    });
    return '';
  }
  requireThat(['close-offers','listing-changed'].includes(task.type),'INVALID_TASK','未知通知任务');
  const _ = db.command;
  const query = {goodsId:d.goodsId,status:'pending',createdAt:_.lte(d.cutoff)};
  if (d.cursor) query._id = _.gt(d.cursor);
  const size = 20;
  const batch = (await db.collection('offers').where(query).orderBy('_id','asc').limit(size).get()).data;
  for (const row of batch) {
    await db.runTransaction(async tx => {
      const o = await get(tx,'offers',row._id);
      if (o?.status !== 'pending' || (o.listingCycle || '') !== d.listingCycle ||
          o.createdAt > d.cutoff || o._id === d.exclude) return;
      if (task.type === 'listing-changed') {
        const goods = await get(tx,'goods',d.goodsId);
        if (validPending(o,goods,now)) await offerNotice(tx,o,'goods.changed',o.buyerId,task._id,now);
      } else {
        const wasExpired = due(o) <= d.cutoff;
        await update(tx,'offers',o._id,{status:wasExpired?'expired':d.status,updatedAt:now});
        await offerNotice(tx,o,wasExpired?'offer.expired':d.type,o.buyerId,o._id,now);
      }
    });
    if (Date.now() >= deadline) return row._id;
  }
  return batch.length === size ? batch[size-1]._id : '';
}

module.exports = {chatOpen,chatSend,submitOffer,changeOffer,listingAction,expireOffers,processBusinessTask};
