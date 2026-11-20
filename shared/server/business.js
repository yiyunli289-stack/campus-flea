'use strict';
const { assert, id, hash, text, money } = require('./core');
const moderation = require('./moderation');
const metrics = require('./statistics');
const trade = require('./trade-state');

async function login(s,p,openid) {
  assert(openid,'UNAUTHENTICATED','请先登录',401);
  const action = p.action || 'login';
  assert(['login', 'state', 'updateProfile'].includes(action), 'NOT_FOUND', '未知账号操作', 404);
  let u = await s.findUser(openid);
  if (action === 'state') return u ? accountView(s,u) : null;
  if (!u) {
    const key = hash('user:'+openid);
    u = await s.store.transaction(async tx => {
      const existing = await tx.get('users',key); if (existing) return existing;
      const next = {_id:key,_openid:openid,nickName:'',avatarUrl:'',campus:'',contact:'',college:'',major:'',profileComplete:false,accountStatus:'normal',createdAt:s.now(),contentVersion:0};
      await tx.put('users',key,next); return next;
    });
  }
  if (action === 'login') return accountView(s,u);
  await s.user(openid,'profile',s.store,false);
  const config = (await s.setting('public')).content;
  const next = {};
  for (const field of ['nickName','campus','contact','college','major','avatarUrl']) next[field] = text(p[field] ?? u[field],field === 'avatarUrl' ? 500 : 100,['nickName','campus','contact'].includes(field));
  assert(config.campuses.some(x=>x.active && x.code === next.campus),'INVALID_INPUT','校区已停用或不存在');
  if (next.college) assert(config.colleges.some(x=>x.active && x.code === next.college),'INVALID_INPUT','学院已停用或不存在');
  const avatarFiles = next.avatarUrl && next.avatarUrl !== u.avatarUrl ? [next.avatarUrl] : [];
  if (avatarFiles.length) await moderation.validateFiles(s,openid,avatarFiles);
  const version = id();
  await s.store.transaction(async tx => {
    const current = await s.user(openid,'profile',tx,false);
    await tx.put('users',current._id,{...current,pendingProfile:next,pendingProfileEpoch:trade.epoch(current),contentVersion:version,moderationStatus:'review'});
  });
  const result = await moderation.submit(s,'users',u._id,openid,version,next.nickName,avatarFiles);
  if (result.status !== 'review') await moderation.applyResult(s,result.taskId,result.status,null,'自动检测结果');
  return accountView(s,await s.store.get('users',u._id));
}

async function accountView(s,u) {
  const state = trade.accountState(u,s.now());
  if (state.accountStatus === 'deleted') return state;
  const fields = ['_id', '_openid', 'nickName', 'avatarUrl', 'campus', 'contact', 'college', 'major', 'profileComplete', 'moderationStatus'];
  const own = Object.fromEntries(fields.map(k => [k, u[k] ?? '']));
  const [avatarPreview] = u.avatarUrl ? await s.provider.urls([u.avatarUrl]) : [''];
  return {...own,avatarPreview,...state};
}

function validateListing(config,p) {
  const cat = config.categories.find(x=>x.code === p.cat && x.active);
  assert(cat,'INVALID_INPUT','类目已停用或不存在');
  assert(config.campuses.some(x=>x.code === p.campus && x.active),'INVALID_INPUT','校区已停用或不存在');
  assert(config.conditions.some(x=>x.code === p.condition && x.active),'INVALID_INPUT','请选择有效成色');
  assert(['定价','竞价'].includes(p.tradeType),'INVALID_INPUT','请选择交易方式');
  const price = p.tradeType === '竞价' && !p.price ? 0 : money(p.price);
  assert(p.tradeType !== '定价' || price <= 9999,'INVALID_PRICE','定价不可超过9999元');
  const offerDurationHours = Number(p.offerDurationHours ?? 48);
  assert(Number.isInteger(offerDurationHours) && offerDurationHours >= 24 && offerDurationHours <= 72,
    'INVALID_INPUT', '报价有效期须为24至72小时');
  const out = {offerDurationHours,cat:p.cat,title:text(p.title,100,true),desc:text(p.desc,3000),campus:p.campus,condition:p.condition,tradeType:p.tradeType,price,allowBargain:!!p.allowBargain,
    meetingPlace:text(p.meetingPlace,150),images:p.images || [],innerPhotos:[],attributes:{}};
  assert(Array.isArray(out.images) && out.images.length >= 1 && out.images.length <= 9,'INVALID_FILE','请上传1至9张实物图');
  for (const f of cat.fields) {
    let value = p.attributes?.[f.code];
    if (f.required) assert(value !== undefined && value !== '', 'INVALID_INPUT', '请填写'+f.name);
    if (value === undefined || value === '') continue;
    if (f.type === 'number') { value=Number(value); assert(Number.isFinite(value),'INVALID_INPUT',f.name+'须为数字'); }
    else { value=text(value,200); if (f.type==='enum') assert(f.options.includes(value),'INVALID_INPUT',f.name+'选项无效'); }
    out.attributes[f.code]=value;
  }
  if (p.cat === 'book') {
    assert(config.noteLevels.some(x=>x.code===p.noteLevel && x.active),'INVALID_INPUT','请确认笔记等级');
    for (const field of ['isbn','author','publisher','edition','college','major','course','noteLevel','noteDesc','defects']) out[field]=text(p[field],field==='noteDesc'||field==='defects'?1000:100);
    out.innerPhotos=p.innerPhotos || [];
    assert(Array.isArray(out.innerPhotos) && out.innerPhotos.length<=6,'INVALID_FILE','内页照片最多6张');
    assert(p.noteLevel==='无笔记'||out.innerPhotos.length>=1,'NOTE_PHOTO_REQUIRED','有笔记的图书须提供至少1张代表性内页图');
  }
  return out;
}
const listingFields = [
  'cat', 'title', 'desc', 'campus', 'condition', 'tradeType', 'price', 'allowBargain',
  'meetingPlace', 'images', 'innerPhotos', 'attributes', 'isbn', 'author', 'publisher',
  'edition', 'college', 'major', 'course', 'noteLevel', 'noteDesc', 'defects', 'offerDurationHours'
];

function listingInput(p) {
  return Object.fromEntries(listingFields.filter(key => Object.hasOwn(p, key)).map(key => [key, p[key]]));
}

async function listingView(s, g, openid, viewer, knownState) {
  const state = knownState || await s.listingState(g);
  const own = !!openid && g.sellerId === openid;
  if (state === 'removed' || state === 'deleted' || !own && state !== 'on') {
    const canChat = state === 'locked' && g.buyerId === openid &&
      !!viewer && trade.accountState(viewer,s.now()).allowedCapabilities.includes('message');
    return { ...trade.listingSummary(g,state,own), isOwner:own,canOffer:false,canChat };
  }
  const data = await s.signedDocument(g);
  const buyerId = g.buyerId;
  delete data.buyerId;
  delete data.buyerEpoch;
  delete data.acceptedOfferId;
  delete data.dealPrice;
  delete data.governanceReason;
  delete data.saleOfferId;
  delete data.moderationTaskId;
  delete data.statusBeforeRemoval;
  delete data.governanceActionId;
  const account = viewer && trade.accountState(viewer, s.now());
  const permitted = capability => !account || account.allowedCapabilities.includes(capability);
  return { ...data, status:state, isOwner:own,
    canOffer:!own && state === 'on' && permitted('offer'),
    canChat:permitted('message') && ((!own && state === 'on') ||
      !!openid && state === 'locked' && (own || buyerId === openid)) };
}

async function goods(s, p, openid) {
  if (p.action === 'search') {
    const filter = { status:'on' };
    for (const f of ['cat','campus','tradeType','condition','college']) if (p[f]) filter[f] = text(p[f],100);
    if (p.keyword) filter.title = { $contains:text(p.keyword,100) };
    if (p.isbn) filter.isbn = text(p.isbn,20);
    if (p.edition) filter.edition = text(p.edition,100);
    if (Number(p.priceMin)>0 || Number(p.priceMax)>0) {
      filter.price = {};
      if (Number(p.priceMin)>0) filter.price.$gte = Number(p.priceMin);
      if (Number(p.priceMax)>0) filter.price.$lte = Number(p.priceMax);
    }
    const out = [];
    let skip = Math.max(0, Math.trunc(Number(p.skip) || 0));
    for (let batch = 0; batch < 5 && out.length < 50; batch++) {
      const rows = await s.store.find('goods', filter, { sort:'createdAt', skip, limit:50 });
      for (const g of rows) {
        if (await s.listingState(g) === 'on') out.push(await listingView(s,g,'',null,'on'));
        if (out.length === 50) break;
      }
      if (rows.length < 50) break;
      skip += rows.length;
    }
    if (p.cat === 'book' || p.college || p.isbn) {
      await metrics.search(s,p,out.length>0).catch(error=>console.error('book search measurement failed',error.code || 'UNKNOWN'));
    }
    return out;
  }
  if (p.action === 'detail') {
    const g = await s.store.get('goods', p.id);
    assert(g && g.status !== 'deleted' && (g.status !== 'draft' || g.sellerId === openid), 'NOT_FOUND','商品不存在',404);
    const document = await listingView(s, g, openid, await s.findUser(openid));
    if (document.status === 'on' && !document.isOwner) {
      await s.store.transaction(tx=>metrics.trade(s,tx,'view',g.tradeType))
        .catch(error=>console.error('listing view measurement failed',error.code || 'UNKNOWN'));
    }
    return document;
  }
  if (p.action === 'myGoods') {
    const user = await s.user(openid, null, s.store, false);
    assert(user.accountStatus !== 'deleted', 'ACCOUNT_DELETED', '账号已注销', 403);
    const list = await s.store.find('goods', { sellerId:openid, status:{ $ne:'deleted' } }, { sort:'createdAt', limit:100 });
    return Promise.all(list.map(async g => {
      const view = await listingView(s, g, openid, user);
      const canManage = trade.accountState(user,s.now()).allowedCapabilities.includes('publish');
      return {...view,canManage,canUndoSold:canManage && view.status === 'sold' && !!g.soldAt && s.now() <= g.soldAt + 24 * trade.hour};
    }));
  }
  await s.user(openid, 'publish');
  if (p.action === 'editDetail') {
    const g = await s.store.get('goods', p.id);
    assert(g?.sellerId === openid && ['draft','on'].includes(await s.listingState(g)), 'INVALID_STATE','当前商品不可编辑',409);
    const files = [...(g.images || []),...(g.innerPhotos || [])];
    const urls = await s.provider.urls(files);
    return {...listingInput(g),_id:g._id,status:g.status,previews:Object.fromEntries(files.map((file,i)=>[file,urls[i]]))};
  }
  if (['publish', 'edit', 'saveDraft'].includes(p.action)) {
    const previous = p.id ? await s.store.get('goods', p.id) : null;
    if (p.id) assert(previous?.sellerId === openid, 'FORBIDDEN','无权操作',403);
    if (p.action === 'edit') assert(previous, 'NOT_FOUND','商品不存在',404);
    const isDraft = p.action === 'saveDraft' || p.action === 'edit' && previous?.status === 'draft';
    const c = await s.setting('public');
    if (p.configVersion) assert(p.configVersion === c.version,'STALE_CONFIG','配置已更新，请重新加载表单',409);
    const input = { ...listingInput(previous || {}), ...listingInput(p) };
    const data = isDraft ? {
      ...input, title:text(input.title,100), desc:text(input.desc,3000),
      images:input.images || [], innerPhotos:input.innerPhotos || []
    } : validateListing(c.content, input);
    assert(Array.isArray(data.images) && data.images.length <= 9 &&
      Array.isArray(data.innerPhotos) && data.innerPhotos.length <= 6, 'INVALID_FILE', '图片格式无效');
    if (isDraft) {
      for (const key of listingFields.filter(k => !['images','innerPhotos','attributes','allowBargain','price','offerDurationHours'].includes(k))) {
        if (data[key] !== undefined) data[key] = text(data[key],key === 'desc' ? 3000 : 1000);
      }
      const fields = c.content.categories.find(x => x.code === data.cat)?.fields || [];
      const attributes = data.attributes || {};
      data.attributes = Object.fromEntries(fields.filter(f => Object.hasOwn(attributes,f.code)).map(f => {
        const value = attributes[f.code];
        return [f.code,typeof value === 'number' && Number.isFinite(value) ? value : text(value,200)];
      }));
      data.price = Number.isFinite(Number(data.price)) ? Number(data.price) : 0;
      data.offerDurationHours = Number.isInteger(Number(data.offerDurationHours)) &&
        Number(data.offerDurationHours) >= 24 && Number(data.offerDurationHours) <= 72 ? Number(data.offerDurationHours) : 48;
      data.allowBargain = !!data.allowBargain;
    }
    const existingFiles = [...(previous?.images || []), ...(previous?.innerPhotos || [])];
    const newFiles = [...data.images, ...data.innerPhotos].filter(file => !existingFiles.includes(file));
    if (newFiles.length) await moderation.validateFiles(s, openid, newFiles);
    if (!previous) await s.rate(openid, 'publish', 20, 3600000);
    const key = previous?._id || id();
    const version = id();
    return s.store.transaction(async tx => {
      const owner = await s.user(openid, 'publish', tx);
      const current = previous ? await tx.get('goods', key) : null;
      if (previous) {
        assert(current?.sellerId === openid && current.contentVersion === previous.contentVersion,
          'CONFLICT','商品已变化，请重新载入',409);
        const states = p.action === 'edit' ? ['draft','on'] : ['draft'];
        assert(states.includes(await s.listingState(current,tx)), 'INVALID_STATE','当前商品不可编辑或发布',409);
      }
      const next = {
        ...current, ...data, _id:key, _openid:openid, sellerId:openid, sellerName:owner.nickName,
        sellerAvatar:owner.avatarUrl, sellerCollege:owner.college, sellerEpoch:trade.epoch(owner),
        status:isDraft ? 'draft' : 'on', buyerId:'', enforcement:'normal', contentVersion:version,
        createdAt:current?.createdAt || s.now(), updatedAt:s.now()
      };
      if (isDraft) {
        await tx.put('goods',key,next);
      } else {
        if (current?.status === 'on') {
          await s.enqueue(tx,'listing-edited',version,{ goodsId:key, tradeVersion:trade.generation(current), beforeTime:s.now() });
        }
        next.moderationStatus = 'review';
        next.moderationTaskId = id();
        await moderation.queueGoods(s,tx,next);
      }
      return { _id:key, status:next.status, moderationStatus:next.moderationStatus || '' };
    });
  }
  assert(['offShelf','relist','complete','remove','undoSold'].includes(p.action),'NOT_FOUND','未知商品操作',404);
  return s.store.transaction(async tx => {
    const owner = await s.user(openid,'publish',tx);
    const g = await tx.get('goods',p.id);
    assert(g?.sellerId === openid,'FORBIDDEN','无权操作',403);
    const state = await s.listingState(g, tx);
    let next;
    if (p.action === 'offShelf') {
      assert(state === 'on', 'INVALID_STATE','当前状态不能下架');
      next = await trade.closeTrade(s,tx,g,'off','off');
    } else if (p.action === 'relist') {
      assert(state === 'off', 'INVALID_STATE','当前状态不能重新上架');
      next = await trade.closeTrade(s,tx,g,'on','off',{ sellerEpoch:trade.epoch(owner) });
    } else if (p.action === 'remove') {
      assert(['off','draft'].includes(state), 'INVALID_STATE','只能删除草稿或普通下架商品');
      next = await trade.closeTrade(s,tx,g,'deleted','deleted');
    } else if (p.action === 'complete') {
      assert(['on','locked'].includes(state),'INVALID_STATE','当前状态不能确认售出');
      let selected = null;
      if (state === 'locked') {
        await s.guardPair(openid,g.buyerId,tx);
        await s.user(g.buyerId,'offer',tx);
        const key = g.acceptedOfferId || (await s.store.find('offers',{goodsId:g._id,buyerId:g.buyerId,status:'accepted'},{limit:1}))[0]?._id;
        selected = key && await tx.get('offers',key);
        assert(selected?.status === 'accepted','INVALID_STATE','锁定申请已结束');
        await tx.put('offers',key,{...selected,status:'completed',updatedAt:s.now()});
        await s.notify(tx,selected.buyerId,'offer.completed',key,'卖家已确认售出');
      }
      next = await trade.closeTrade(s,tx,g,'sold','sold',{
        soldAt:s.now(), saleOfferId:selected?._id || '', sellerEpoch:trade.epoch(owner)
      });
      await metrics.trade(s,tx,'sold',g.tradeType);
    } else {
      assert(state === 'sold' && g.soldAt && s.now() <= g.soldAt + 24 * trade.hour,
        'INVALID_STATE','只能在售出后24小时内撤回');
      const selected = g.saleOfferId && await tx.get('offers',g.saleOfferId);
      const buyer = selected && await s.findUser(selected.buyerId,tx);
      const relock = selected?.status === 'completed' && !trade.blockedAccount(buyer) &&
        (selected.buyerEpoch || '') === trade.epoch(buyer) &&
        trade.accountState(buyer,s.now()).allowedCapabilities.includes('offer') &&
        !await s.blocked(openid,buyer._openid,tx);
      next = { ...g, status:relock ? 'locked' : 'on', soldAt:0, saleOfferId:'',
        sellerEpoch:trade.epoch(owner), tradeVersion:id(), updatedAt:s.now() };
      if (relock) {
        Object.assign(next,{buyerId:selected.buyerId,buyerEpoch:trade.epoch(buyer),dealPrice:selected.price,
          acceptedOfferId:selected._id,lockedAt:s.now()});
        await tx.put('offers',selected._id,{...selected,status:'accepted',tradeVersion:next.tradeVersion,updatedAt:s.now()});
        await s.enqueue(tx,'meetup-reminder',next.tradeVersion,{goodsId:g._id,offerId:selected._id},s.now()+24*trade.hour);
        await s.notify(tx,selected.buyerId,'offer.sale-withdrawn',next.tradeVersion,'卖家撤回了售出确认');
      }
      await tx.put('goods',g._id,next);
    }
    await s.audit(tx,{_id:openid,role:'user'},'goods.'+p.action,g._id,{status:g.status},{status:next.status});
    return {status:next.status};
  });
}

async function offer(s,p,openid) {
  const isRead = ['received','sent'].includes(p.action);
  const u = await s.user(openid, isRead ? null : 'offer', s.store, !isRead);
  assert(u.accountStatus !== 'deleted','ACCOUNT_DELETED','账号已注销',403);
  if (isRead) {
    const filter = { [p.action === 'received' ? 'sellerId' : 'buyerId']:openid };
    if (p.goodsId) filter.goodsId = p.goodsId;
    const list = await s.store.find('offers',filter,{sort:'createdAt',limit:100});
    const out = [];
    for (const o of list) {
      if (!(o.moderationStatus === 'approved' || o.historyVisible && o.moderationStatus !== 'rejected' ||
        !o.moderationStatus) && o.buyerId !== openid) continue;
      const g = await s.store.get('goods',o.goodsId);
      const { seller, buyer } = await trade.parties(s,g,o.buyerId);
      const state = trade.offerState(o,g,seller,buyer,s.now());
      const goodsState = await s.listingState(g);
      const canManage = trade.accountState(u,s.now()).allowedCapabilities.includes('offer');
      const context = { ...o, contactConsent:null };
      const selected = state === 'accepted' && await s.contactAvailable(context,g,seller,buyer);
      const canChat = await s.chatAvailable(context,g);
      const removed = ['removed','deleted'].includes(goodsState);
      out.push({
        ...o, status:state, goodsState, canManage, canChat,
        canAccept:canManage && state === 'pending' && o.moderationStatus === 'approved' &&
          !!buyer && trade.accountState(buyer,s.now()).allowedCapabilities.includes('offer') &&
          !await s.blocked(o.buyerId,o.sellerId),
        canRestore:canManage && state === 'accepted' && o.sellerId === openid &&
          !g.meetupConfirmedAt && trade.time(g.lockedAt || o.acceptedAt) + 48 * trade.hour <= s.now(),
        buyerName:approvedName(buyer), buyerCollege:buyer?.college || '', buyerCampus:buyer?.campus || '',
        sellerName:approvedName(seller), buyerContact:selected && o.sellerId === openid ? buyer.contact : '',
        sellerContact:selected && o.buyerId === openid ? seller.contact : '',
        goodsTitle:removed ? '商品已下架' : o.goodsTitle,
        goodsCover:!removed && o.goodsCover ? (await s.provider.urls([o.goodsCover]))[0] : ''
      });
    }
    return out;
  }
  if (['cancel','decline','cancelLock','restoreListing','confirmMeetup','accept'].includes(p.action)) {
    const initial = await s.store.get('offers',p.offerId);
    assert(initial && [initial.buyerId,initial.sellerId].includes(openid),'FORBIDDEN','无权操作该申请',403);
    const previous = p.action === 'accept' ? await existingConversation(s,initial) : null;
    return s.store.transaction(async tx => {
      await s.user(openid,'offer',tx);
      const o = await tx.get('offers',p.offerId);
      const g = o && await tx.get('goods',o.goodsId);
      assert(o && g && [o.sellerId,o.buyerId].includes(openid),'FORBIDDEN','无权操作该申请',403);
      const { seller,buyer } = await trade.parties(s,g,o.buyerId,tx);
      const state = trade.offerState(o,g,seller,buyer,s.now());
      const sellerActs = o.sellerId === openid;
      if (p.action === 'cancel' || p.action === 'decline') {
        assert(state === 'pending' && sellerActs === (p.action === 'decline'),'INVALID_STATE','当前申请不能撤回或拒绝');
        const status = sellerActs ? 'rejected' : 'cancelled';
        const reason = sellerActs ? text(p.reason,200,true) : '';
        await tx.put('offers',o._id,{...o,status,closedReason:reason || status,updatedAt:s.now()});
        await s.notify(tx,sellerActs ? o.buyerId : o.sellerId,'offer.'+status,o._id,
          sellerActs ? '卖家已拒绝该购买申请' : '买家已撤回购买申请');
        if (sellerActs) await metrics.trade(s,tx,'response',g.tradeType);
        return {status};
      }
      if (p.action === 'accept') {
        assert(sellerActs && state === 'pending' && o.moderationStatus === 'approved','INVALID_STATE','申请或商品状态已变化');
        await s.user(o.buyerId,'offer',tx);
        await s.guardPair(openid,o.buyerId,tx);
        await tx.put('offers',o._id,{...o,status:'accepted',acceptedAt:s.now()});
        const locked = { ...g,status:'locked', buyerId:o.buyerId,buyerEpoch:trade.epoch(buyer),acceptedOfferId:o._id,
          dealPrice:o.price,lockedAt:s.now(),meetupConfirmedAt:0,updatedAt:s.now() };
        await tx.put('goods',g._id,locked);
        const c = await writeConversation(s,tx,locked,seller,buyer,previous,o._id);
        await s.notify(tx,o.buyerId,'offer.accepted',o._id,'购买申请已被接受，请联系卖家安排公共场所面交');
        await s.enqueue(tx,'meetup-reminder',o._id,{goodsId:g._id,offerId:o._id},s.now()+24*trade.hour);
        await s.enqueue(tx,'close-other-offers',o._id,{goodsId:g._id,tradeVersion:trade.generation(g),selectedId:o._id});
        await s.audit(tx,{_id:openid,role:'user'},'offer.accept',o._id,{status:g.status},{status:'locked',offerId:o._id});
        await metrics.trade(s,tx,'response',g.tradeType);
        await metrics.trade(s,tx,'accept',g.tradeType);
        return {status:'accepted',conversationId:c._id};
      }
      assert(state === 'accepted','INVALID_STATE','该锁定已不可操作');
      if (p.action === 'confirmMeetup') {
        await s.guardPair(o.sellerId,o.buyerId,tx);
        await tx.put('goods',g._id,{...g,meetupConfirmedAt:s.now(),updatedAt:s.now()});
        await s.notify(tx,sellerActs ? o.buyerId : o.sellerId,'offer.meetup-confirmed',o._id,'对方已确认面交安排');
        return {status:'accepted'};
      }
      const restore = p.action === 'restoreListing';
      if (restore) assert(sellerActs && !g.meetupConfirmedAt &&
        trade.time(g.lockedAt || o.acceptedAt) + 48 * trade.hour <= s.now(),
        'INVALID_STATE','锁定48小时且未确认面交后才可恢复在售');
      const reason = restore ? '面交无进展' : text(p.reason,200,true);
      const canList = trade.accountState(seller,s.now()).allowedCapabilities.includes('publish');
      if (restore) assert(canList,'ACCOUNT_RESTRICTED','账号当前不能恢复在售',403);
      await tx.put('offers',o._id,{...o,status:'closed',closedReason:'lock_cancelled',updatedAt:s.now()});
      const nextStatus = canList ? 'on' : 'off';
      await trade.closeTrade(s,tx,g,nextStatus,'lock_cancelled');
      await s.notify(tx,sellerActs ? o.buyerId : o.sellerId,'offer.lock_cancelled',o._id,'面交锁定已取消');
      await s.audit(tx,{_id:openid,role:'user'},'offer.'+p.action,o._id,{status:'locked'},{status:nextStatus},reason);
      await metrics.trade(s,tx,'lockCancel',g.tradeType);
      return {status:'closed'};
    });
  }
  assert(['create','update'].includes(p.action),'NOT_FOUND','未知报价操作',404);
  let existing=p.action==='update'?await s.store.get('offers',p.offerId):null;
  if(existing) assert(existing.buyerId===openid,'FORBIDDEN','无权修改报价',403);
  const g=await s.store.get('goods',existing?.goodsId || p.goodsId);
  assert(g && await s.listingState(g)==='on' && g.sellerId!==openid,'INVALID_STATE','商品当前不可申请');
  await s.user(g.sellerId,'offer');
  await s.guardPair(openid,g.sellerId);
  const rules=await s.setting('rules'); await s.rate(openid,'offer',rules.content.offerPerHour,3600000);
  if(p.action==='update') {
    assert(existing && existing.status==='pending' && g.tradeType==='竞价','INVALID_STATE','仅可修改待处理竞价');
    if(existing.updatedAt + rules.content.priceChangeSeconds*1000>s.now()) {
      await s.risk(openid,'frequent-price-change',existing._id,{minimumSeconds:rules.content.priceChangeSeconds},'block');
      assert(false,'PRICE_CHANGE_LIMIT','修改报价至少间隔5分钟',429);
    }
  }
  const price=g.tradeType==='定价'?g.price:money(p.price); const message=text(p.message ?? existing?.message,200); const meetingTime=text(p.meetingTime ?? existing?.meetingTime,100); const meetingPlace=text(p.meetingPlace ?? existing?.meetingPlace,150);
  const low=price<(rules.content.lowPriceByCategory[g.cat] || 0)||(g.tradeType==='竞价' && g.price>0 && price<g.price*rules.content.lowPriceRatio);
  if(low) { await s.risk(openid,'low-price',g._id,{price,reference:g.price,ruleVersion:rules.version},rules.content.action); assert(rules.content.action!=='block','RISK_BLOCKED','报价触发风控，请调整或联系平台',403); }
  const key=existing?existing._id:id(); const version=id(); const pair=hash(openid+':'+g._id);
  await s.store.transaction(async tx=>{
    const buyer = await s.user(openid,'offer',tx);
    const seller = await s.user(g.sellerId,'offer',tx);
    await s.guardPair(openid,g.sellerId,tx);
    const currentGoods = await tx.get('goods',g._id);
    assert(trade.listingState(currentGoods,seller,null) === 'on' &&
      currentGoods.contentVersion === g.contentVersion, 'INVALID_STATE','商品状态已变化');
    const lock=await tx.get('offerKeys',pair); const previous=lock?await tx.get('offers',lock.offerId):null;
    if (p.action === 'create') assert(!previous ||
      trade.offerState(previous,currentGoods,seller,buyer,s.now()) !== 'pending','DUPLICATE_OFFER','已有有效申请，请修改原竞价');
    if(existing) { const cur=await tx.get('offers',key); assert(cur && trade.offerState(cur,currentGoods,seller,buyer,s.now()) === 'pending' && cur.contentVersion===existing.contentVersion,'CONFLICT','报价已变化或到期',409); }
    await tx.put('offerKeys',pair,{offerId:key});
    await tx.put('offers',key,{_openid:openid,goodsId:g._id,goodsTitle:g.title,goodsCover:g.images?.[0] || '',sellerId:g.sellerId,buyerId:openid,tradeType:g.tradeType,price:g.tradeType==='定价'?currentGoods.price:price,priceSnapshot:g.tradeType==='定价'?currentGoods.price:null,message,meetingTime,meetingPlace,status:'pending',moderationStatus:'review',riskPending:low,contentVersion:version,tradeVersion:trade.generation(currentGoods),sellerEpoch:trade.epoch(seller),buyerEpoch:trade.epoch(buyer),
      expiresAt:existing ? trade.offerExpiry(existing,currentGoods) : s.now() + (currentGoods.offerDurationHours || 48) * trade.hour,
      createdAt:existing?.createdAt || s.now(),updatedAt:s.now()});
    if (!existing) await metrics.trade(s,tx,'request',g.tradeType);
  });
  const result=await moderation.submit(s,'offers',key,openid,version,message);
  if(result.status!=='review' && !low) await moderation.applyResult(s,result.taskId,result.status,null,'自动检测结果');
  if(low && result.status==='approved') await s.store.transaction(tx=>tx.put('moderationCases',result.taskId,{taskId:result.taskId,targetType:'offers',targetId:key,ownerId:openid,version,state:'pending',createdAt:s.now()}));
  return {_id:key,moderationStatus:low?'review':result.status};
}

function approvedName(u) {
  return !trade.blockedAccount(u) && (!u.moderationStatus || u.moderationStatus === 'approved') ? u.nickName : '校园用户';
}

async function existingConversation(s, o) {
  return (await s.store.find('conversations',{goodsId:o.goodsId,sellerId:o.sellerId,buyerId:o.buyerId},
    {sort:'updatedAt',limit:1}))[0];
}

async function writeConversation(s, tx, g, seller, buyer, previous, offerId = '') {
  const data = { goodsId:g._id,sellerId:g.sellerId,buyerId:buyer._openid,
    sellerEpoch:trade.epoch(seller),buyerEpoch:trade.epoch(buyer),tradeVersion:trade.generation(g) };
  const matches = previous && ['sellerEpoch','buyerEpoch','tradeVersion'].every(k => (previous[k] || '') === data[k]);
  const key = matches ? previous._id : hash([g._id,g.sellerId,buyer._openid,data.sellerEpoch,data.buyerEpoch,data.tradeVersion].join(':'));
  const current = await tx.get('conversations',key);
  const row = {
    goodsTitle:g.title,goodsCover:g.images?.[0] || '',lastMsg:'',lastTime:s.now(),
    unreadSeller:0,unreadBuyer:0,...current,...data,_id:key,updatedAt:s.now(),
    state:g.status === 'locked' ? 'locked' : 'open',offerId:offerId || current?.offerId || ''
  };
  await tx.put('conversations',key,row);
  return row;
}

async function chat(s,p,openid) {
  const read = ['conversations','messages'].includes(p.action);
  const u = await s.user(openid,read ? null : 'message',s.store,!read);
  assert(u.accountStatus !== 'deleted','ACCOUNT_DELETED','账号已注销',403);
  if (p.action === 'conversations') {
    const list = await s.store.find('conversations',{$or:[{buyerId:openid},{sellerId:openid}]},{sort:'updatedAt',limit:100});
    const seen = new Set();
    const out = [];
    for (const c of list) {
      const key = [c.goodsId,c.buyerId,trade.generation(c),c.buyerEpoch || '',c.sellerEpoch || ''].join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      const g = await s.store.get('goods',c.goodsId);
      const other = await s.findUser(c.buyerId === openid ? c.sellerId : c.buyerId);
      const state = await s.listingState(g);
      const hide = ['removed','deleted'].includes(state);
      const active = await s.chatAvailable(c,g);
      out.push({...c,state:active ? state : ['on','locked'].includes(state) ? 'readonly' : state,
        otherName:approvedName(other),otherAvatar:!trade.blockedAccount(other) && other.avatarUrl &&
          approvedName(other) !== '校园用户' ? (await s.provider.urls([other.avatarUrl]))[0] : '',
        goodsTitle:hide ? '商品已下架' : c.goodsTitle,
        goodsCover:!hide && c.goodsCover ? (await s.provider.urls([c.goodsCover]))[0] : ''});
    }
    return out;
  }
  if (p.action === 'open') {
    const g = await s.store.get('goods',p.goodsId);
    assert(g,'CONTENT_UNAVAILABLE','商品不可用',403);
    const buyerId = g.sellerId === openid ? g.buyerId : openid;
    assert(buyerId && buyerId !== g.sellerId,'INVALID_STATE','尚未锁定买家');
    const prior = await existingConversation(s,{goodsId:g._id,sellerId:g.sellerId,buyerId});
    return s.store.transaction(async tx => {
      const current = await tx.get('goods',g._id);
      const seller = await s.user(g.sellerId,'message',tx);
      const buyer = await s.user(buyerId,'message',tx);
      await s.guardPair(buyerId,g.sellerId,tx);
      assert(current?.sellerId === g.sellerId && (g.sellerId !== openid || current.buyerId === buyerId) &&
        (trade.listingState(current,seller,buyer) === 'on' ||
          trade.listingState(current,seller,buyer) === 'locked' && current.buyerId === buyerId),
        'INVALID_STATE','商品当前不可发起会话');
      return writeConversation(s,tx,current,seller,buyer,prior,current.acceptedOfferId);
    });
  }
  const c = await s.store.get('conversations',p.conversationId);
  assert(c && [c.buyerId,c.sellerId].includes(openid),'FORBIDDEN','无权访问会话',403);
  const otherId = c.buyerId === openid ? c.sellerId : c.buyerId;
  const g = await s.store.get('goods',c.goodsId);
  if (p.action === 'messages') {
    const all = await s.store.find('messages',{conversationId:c._id,deliveryState:'delivered',
      $or:[{moderationStatus:'approved'},{historyVisible:true,moderationStatus:{$ne:'rejected'}}]}, {sort:'createdAt',limit:100});
    const { seller,buyer } = await trade.parties(s,g,c.buyerId);
    const other = c.sellerId === openid ? buyer : seller;
    if (!trade.blockedAccount(u)) await s.store.transaction(async tx => {
      const current = await tx.get('conversations',c._id);
      if (current) await tx.put('conversations',c._id,{...current,[c.sellerId===openid?'unreadSeller':'unreadBuyer']:0});
    });
    const contact = await s.contactAvailable(c,g,seller,buyer) ? other.contact : '';
    const canSend = await s.chatAvailable(c,g);
    const state = await s.listingState(g);
    const side = openid === c.sellerId ? 'seller' : 'buyer';
    return {
      messages:all.reverse(), other:{nickName:approvedName(other),avatarUrl:approvedName(other) === '校园用户' ? '' : other.avatarUrl || '',contact},
      state:canSend ? state : ['on','locked'].includes(state) ? 'readonly' : state,canSend,
      canShareContact:canSend && state === 'on' && [seller,buyer].every(x => trade.accountState(x,s.now()).accountStatus === 'normal'),
      contactConfirmed:!!c.contactConsent?.[side]
    };
  }
  if (p.action === 'shareContact') {
    assert(typeof p.confirm === 'boolean','INVALID_INPUT','请确认联系方式授权');
    return s.store.transaction(async tx => {
      await s.user(openid,'message',tx);
      const current = await tx.get('conversations',c._id);
      const goods = await tx.get('goods',c.goodsId);
      assert(await s.chatAvailable(current,goods,tx) && goods.status === 'on','INVALID_STATE','当前会话无法交换联系方式');
      const {seller,buyer} = await trade.parties(s,goods,current.buyerId,tx);
      assert([seller,buyer].every(x => trade.accountState(x,s.now()).accountStatus === 'normal'),
        'ACCOUNT_RESTRICTED','当前会话无法交换联系方式');
      const side = openid === current.sellerId ? 'seller' : 'buyer';
      const consent = {...current.contactConsent,[side]:p.confirm};
      await tx.put('conversations',current._id,{...current,contactConsent:consent});
      return {shared:!!consent.seller && !!consent.buyer};
    });
  }
  assert(p.action === 'send','NOT_FOUND','未知聊天操作',404);
  const rules = await s.setting('rules');
  await s.rate(openid,'message',rules.content.messagePerMinute,60000);
  const content = text(p.content,1000,true);
  const key = id(); const version = id();
  await s.store.transaction(async tx => {
    await s.user(openid,'message',tx);
    await s.guardPair(openid,otherId,tx);
    const current = await tx.get('conversations',c._id);
    const currentGoods = await tx.get('goods',c.goodsId);
    assert(await s.chatAvailable(current,currentGoods,tx),'INVALID_STATE','当前会话只读');
    await tx.put('messages',key,{_openid:openid,conversationId:c._id,fromId:openid,toId:otherId,
      content,moderationStatus:'review',contentVersion:version,createdAt:s.now()});
  });
  const result = await moderation.submit(s,'messages',key,openid,version,content);
  if (result.status !== 'review') await moderation.applyResult(s,result.taskId,result.status,null,'自动检测结果');
  return {_id:key,moderationStatus:result.status};
}
module.exports = { login, goods, offer, chat, validateListing };
