'use strict';
const { assert, id, hash, text, money } = require('./core');
const moderation = require('./moderation');
const metrics = require('./statistics');

async function login(s,p,openid) {
  assert(openid,'UNAUTHENTICATED','请先登录',401);
  let u = (await s.store.find('users',{_openid:openid},{limit:1}))[0];
  if (!u) {
    const key = hash('user:'+openid);
    u = await s.store.transaction(async tx => {
      const existing = await tx.get('users',key); if (existing) return existing;
      const next = {_id:key,_openid:openid,nickName:'',avatarUrl:'',campus:'',contact:'',college:'',major:'',profileComplete:false,accountStatus:'normal',createdAt:s.now(),contentVersion:0};
      await tx.put('users',key,next); return next;
    });
  }
  if (p.action !== 'updateProfile') return u;
  await s.user(openid,'profile',s.store,false);
  const config = (await s.setting('public')).content;
  const next = {};
  for (const field of ['nickName','campus','contact','college','major','avatarUrl']) next[field] = text(p[field] ?? u[field],field === 'avatarUrl' ? 500 : 100,['nickName','campus','contact'].includes(field));
  assert(config.campuses.some(x=>x.active && x.code === next.campus),'INVALID_INPUT','校区已停用或不存在');
  if (next.college) assert(config.colleges.some(x=>x.active && x.code === next.college),'INVALID_INPUT','学院已停用或不存在');
  if (next.avatarUrl) await moderation.validateFiles(s,openid,[next.avatarUrl]);
  const version = id();
  await s.store.transaction(async tx => {
    const current = await s.user(openid,'profile',tx,false);
    await tx.put('users',current._id,{...current,pendingProfile:next,contentVersion:version,moderationStatus:'review'});
  });
  const result = await moderation.submit(s,'users',u._id,openid,version,next.nickName,next.avatarUrl?[next.avatarUrl]:[]);
  if (result.status !== 'review') await moderation.applyResult(s,result.taskId,result.status,null,'自动检测结果');
  return s.store.get('users',u._id);
}

function validateListing(config,p) {
  const cat = config.categories.find(x=>x.code === p.cat && x.active);
  assert(cat,'INVALID_INPUT','类目已停用或不存在');
  assert(config.campuses.some(x=>x.code === p.campus && x.active),'INVALID_INPUT','校区已停用或不存在');
  assert(config.conditions.some(x=>x.code === p.condition && x.active),'INVALID_INPUT','请选择有效成色');
  assert(['定价','竞价'].includes(p.tradeType),'INVALID_INPUT','请选择交易方式');
  const price = p.tradeType === '竞价' && !p.price ? 0 : money(p.price);
  assert(p.tradeType !== '定价' || price <= 9999,'INVALID_PRICE','定价不可超过9999元');
  const out = {cat:p.cat,title:text(p.title,100,true),desc:text(p.desc,3000),campus:p.campus,condition:p.condition,tradeType:p.tradeType,price,allowBargain:!!p.allowBargain,
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
async function goods(s,p,openid) {
  if (p.action==='search') {
    const filter={status:'on',moderationStatus:'approved',enforcement:'normal'};
    for (const f of ['cat','campus','tradeType','condition','college']) if(p[f]) filter[f]=text(p[f],100);
    if(p.keyword) filter.title={$contains:text(p.keyword,100)};
    if(p.isbn) filter.isbn=text(p.isbn,20);
    if(p.edition) filter.edition=text(p.edition,100);
    if(Number(p.priceMin)>0||Number(p.priceMax)>0) {filter.price={}; if(Number(p.priceMin)>0) filter.price.$gte=Number(p.priceMin); if(Number(p.priceMax)>0) filter.price.$lte=Number(p.priceMax);}
    const list=await s.store.find('goods',filter,{sort:'createdAt',skip:Math.max(0,Number(p.skip)||0),limit:50}); const out=[];
    for(const g of list) if(await s.visible(g)) out.push(await s.signedDocument(g));
    if (p.cat==='book' || p.college || p.isbn) {
      await metrics.search(s,p,out.length>0).catch(error=>console.error('book search measurement failed',error.code || 'UNKNOWN'));
    }
    return out;
  }
  if(p.action==='detail') {
    const g=await s.store.get('goods',p.id); assert(g,'NOT_FOUND','商品不存在',404);
    if(g.sellerId!==openid) assert(await s.visible(g),'CONTENT_UNAVAILABLE','商品待审核或已违规下架',403);
    const document=await s.signedDocument(g);
    if (g.status==='on' && g.sellerId!==openid) {
      await s.store.transaction(tx=>metrics.trade(s,tx,'view',g.tradeType))
        .catch(error=>console.error('listing view measurement failed',error.code || 'UNKNOWN'));
    }
    return document;
  }
  const u=await s.user(openid,p.action==='myGoods'?null:'publish');
  if(p.action==='myGoods') {
    const list=await s.store.find('goods',{sellerId:openid},{sort:'createdAt',limit:100});
    return Promise.all(list.map(g=>s.signedDocument(g)));
  }
  if(p.action==='publish') {
    const c=await s.setting('public');
    if(p.configVersion) assert(p.configVersion===c.version,'STALE_CONFIG','配置已更新，请重新加载表单',409);
    const data=validateListing(c.content,p); await moderation.validateFiles(s,openid,[...data.images,...data.innerPhotos]);
    await s.rate(openid,'publish',20,3600000);
    const key=id(); const version=id();
    await s.store.transaction(async tx=>{
      await s.user(openid,'publish',tx);
      await tx.put('goods',key,{...data,_openid:openid,sellerId:openid,sellerName:u.nickName,sellerAvatar:u.avatarUrl,sellerCollege:u.college,status:'on',buyerId:'',dealPrice:null,viewCount:0,moderationStatus:'review',enforcement:'normal',contentVersion:version,createdAt:s.now(),updatedAt:s.now()});
    });
    const result=await moderation.submit(s,'goods',key,openid,version,JSON.stringify({...data,images:[],innerPhotos:[]}),[...data.images,...data.innerPhotos]);
    if(result.status!=='review') await moderation.applyResult(s,result.taskId,result.status,null,'自动检测结果');
    return {_id:key,moderationStatus:result.status};
  }
  assert(['offShelf','relist','complete'].includes(p.action),'NOT_FOUND','未知商品操作',404);
  return s.store.transaction(async tx=>{
    await s.user(openid,'publish',tx);
    const g=await tx.get('goods',p.id); assert(g?.sellerId===openid,'FORBIDDEN','无权操作',403);
    let next;
    if(p.action==='offShelf') { assert(g.status==='on','INVALID_STATE','当前状态不能下架'); next='off'; }
    if(p.action==='relist') { assert(g.status==='off' && g.enforcement!=='removed' && g.moderationStatus==='approved','INVALID_STATE','违规或未通过审核的商品不能自行上架'); next='on'; }
    if(p.action==='complete') { assert(g.status==='locked' && g.enforcement!=='removed','INVALID_STATE','当前状态不能确认售出'); next='sold'; }
    await tx.put('goods',g._id,{...g,status:next,updatedAt:s.now()});
    await s.enqueue(tx,'goods-state',id(),{goodsId:g._id,state:next});
    await s.audit(tx,{_id:openid,role:'user'},'goods.'+next,g._id,{status:g.status},{status:next});
    if(next==='sold') await metrics.trade(s,tx,'sold',g.tradeType);
    return {status:next};
  });
}

async function offer(s,p,openid) {
  const u=await s.user(openid,['received','sent'].includes(p.action)?null:'offer');
  if(['received','sent'].includes(p.action)) {
    const filter={[p.action==='received'?'sellerId':'buyerId']:openid}; if(p.goodsId) filter.goodsId=p.goodsId;
    const list=await s.store.find('offers',filter,{sort:'createdAt',limit:100}); const out=[];
    for(const o of list) {
      if(o.moderationStatus!=='approved' && o.buyerId!==openid) continue;
      const buyer=await s.user(o.buyerId,null,s.store,false); const seller=await s.user(o.sellerId,null,s.store,false);
      const g=await s.store.get('goods',o.goodsId); const selected=o.status==='accepted' && g?.buyerId===o.buyerId && g.enforcement!=='removed';
      out.push({...o,buyerName:buyer.nickName,buyerCollege:buyer.college,buyerCampus:buyer.campus,sellerName:seller.nickName,buyerContact:selected?buyer.contact:'',sellerContact:selected?seller.contact:'',goodsCover:o.goodsCover?(await s.provider.urls([o.goodsCover]))[0]:''});
    }
    return out;
  }
  if(p.action==='cancel') return s.store.transaction(async tx=>{
    const o=await tx.get('offers',p.offerId); assert(o?.buyerId===openid && o.status==='pending','INVALID_STATE','只能撤回本人待处理申请');
    await tx.put('offers',o._id,{...o,status:'cancelled',updatedAt:s.now()}); return {status:'cancelled'};
  });
  if(p.action==='cancelLock' || p.action==='decline') return s.store.transaction(async tx=>{
    await s.user(openid,'offer',tx);
    const o=await tx.get('offers',p.offerId);
    const g=o && await tx.get('goods',o.goodsId);
    const reason=text(p.reason,200,true);
    assert(g && o,'NOT_FOUND','申请不存在',404);
    if (p.action==='decline') {
      assert(o.sellerId===openid && o.status==='pending','INVALID_STATE','只能拒绝本人商品的待处理申请');
      await tx.put('offers',o._id,{...o,status:'rejected',closedReason:'seller_declined',updatedAt:s.now()});
      await metrics.trade(s,tx,'response',g.tradeType);
      await s.notify(tx,o.buyerId,'offer.declined',o._id,'卖家已拒绝该购买申请');
      return {status:'rejected'};
    }
    assert([o.sellerId,o.buyerId].includes(openid) && o.status==='accepted' &&
      g.status==='locked' && g.buyerId===o.buyerId && g.enforcement!=='removed','INVALID_STATE','该锁定无法取消');
    await tx.put('offers',o._id,{...o,status:'closed',closedReason:'lock_cancelled',updatedAt:s.now()});
    await tx.put('goods',g._id,{...g,status:'on',buyerId:'',dealPrice:null,updatedAt:s.now()});
    const conversationId=hash(g._id+':'+g.sellerId+':'+o.buyerId);
    const conversation=await tx.get('conversations',conversationId);
    if (conversation?.offerId===o._id) await tx.put('conversations',conversationId,{...conversation,state:'open',offerId:'',updatedAt:s.now()});
    await s.notify(tx,openid===o.sellerId?o.buyerId:o.sellerId,'offer.lock_cancelled',o._id,'面交锁定已取消');
    await s.audit(tx,{_id:openid,role:'user'},'offer.cancelLock',o._id,{status:'locked'},{status:'on'},reason);
    await metrics.trade(s,tx,'lockCancel',g.tradeType);
    return {status:'closed'};
  });
  if(p.action==='accept') {
    const initialOffer=await s.store.get('offers',p.offerId);
    const previousConversation=initialOffer?(await s.store.find('conversations',{goodsId:initialOffer.goodsId,sellerId:openid,buyerId:initialOffer.buyerId},{limit:1}))[0]:null;
    return s.store.transaction(async tx=>{
    await s.user(openid,'offer',tx);
    const o=await tx.get('offers',p.offerId); assert(o?.sellerId===openid,'FORBIDDEN','无权接受申请',403);
    const g=await tx.get('goods',o.goodsId);
    assert(o.status==='pending' && o.moderationStatus==='approved' && g?.status==='on' && await s.visible(g,tx),'INVALID_STATE','申请或商品状态已变化');
    await s.user(o.buyerId,'offer',tx); await s.guardPair(openid,o.buyerId,tx);
    await tx.put('offers',o._id,{...o,status:'accepted',acceptedAt:s.now()});
    await tx.put('goods',g._id,{...g,status:'locked',buyerId:o.buyerId,dealPrice:o.price,updatedAt:s.now()});
    const cid=previousConversation?._id || hash(g._id+':'+g.sellerId+':'+o.buyerId); let c=await tx.get('conversations',cid);
    if(!c) c=conversation(g,o.buyerId,s.now(),cid);
    await tx.put('conversations',cid,{...c,state:'locked',offerId:o._id});
    await s.notify(tx,o.buyerId,'offer.accepted',o._id,'购买申请已被接受，请联系卖家安排公共场所面交');
    await s.enqueue(tx,'close-other-offers',o._id,{goodsId:g._id,selectedId:o._id});
    await s.audit(tx,{_id:openid,role:'user'},'offer.accept',o._id,{status:g.status},{status:'locked',offerId:o._id});
    await metrics.trade(s,tx,'response',g.tradeType);
    await metrics.trade(s,tx,'accept',g.tradeType);
    return {status:'accepted',conversationId:cid};
    });
  }
  assert(['create','update'].includes(p.action),'NOT_FOUND','未知报价操作',404);
  let existing=p.action==='update'?await s.store.get('offers',p.offerId):null;
  if(existing) assert(existing.buyerId===openid,'FORBIDDEN','无权修改报价',403);
  const g=await s.store.get('goods',existing?.goodsId || p.goodsId);
  assert(g && await s.visible(g) && g.status==='on' && g.sellerId!==openid,'INVALID_STATE','商品当前不可申请');
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
    await s.user(openid,'offer',tx); await s.guardPair(openid,g.sellerId,tx);
    const currentGoods=await tx.get('goods',g._id); assert(currentGoods.status==='on' && await s.visible(currentGoods,tx),'INVALID_STATE','商品状态已变化');
    const lock=await tx.get('offerKeys',pair); const previous=lock?await tx.get('offers',lock.offerId):null;
    if(p.action==='create') assert(!previous || previous.status!=='pending','DUPLICATE_OFFER','已有有效申请，请修改原竞价');
    if(existing) { const cur=await tx.get('offers',key); assert(cur.status==='pending' && cur.contentVersion===existing.contentVersion,'CONFLICT','报价已变化',409); }
    await tx.put('offerKeys',pair,{offerId:key});
    await tx.put('offers',key,{_openid:openid,goodsId:g._id,goodsTitle:g.title,goodsCover:g.images[0] || '',sellerId:g.sellerId,buyerId:openid,tradeType:g.tradeType,price:g.tradeType==='定价'?currentGoods.price:price,priceSnapshot:g.tradeType==='定价'?currentGoods.price:null,message,meetingTime,meetingPlace,status:'pending',moderationStatus:'review',riskPending:low,contentVersion:version,createdAt:existing?.createdAt || s.now(),updatedAt:s.now()});
    if (!existing) await metrics.trade(s,tx,'request',g.tradeType);
  });
  const result=await moderation.submit(s,'offers',key,openid,version,message);
  if(result.status!=='review' && !low) await moderation.applyResult(s,result.taskId,result.status,null,'自动检测结果');
  if(low && result.status==='approved') await s.store.transaction(tx=>tx.put('moderationCases',result.taskId,{taskId:result.taskId,targetType:'offers',targetId:key,ownerId:openid,version,state:'pending',createdAt:s.now()}));
  return {_id:key,moderationStatus:low?'review':result.status};
}

function conversation(g,buyerId,now,key) { return {_id:key,goodsId:g._id,goodsTitle:g.title,goodsCover:g.images[0]||'',sellerId:g.sellerId,buyerId,lastMsg:'',lastTime:now,updatedAt:now,unreadSeller:0,unreadBuyer:0,state:'open'}; }
async function chat(s,p,openid) {
  await s.user(openid,p.action==='send'||p.action==='open'?'message':null);
  if(p.action==='conversations') {
    const list=await s.store.find('conversations',{$or:[{buyerId:openid},{sellerId:openid}]},{sort:'updatedAt',limit:100});
    return Promise.all(list.map(async c=>{
      const other=await s.user(c.buyerId===openid?c.sellerId:c.buyerId,null,s.store,false);
      return {...c,otherName:other.nickName,otherAvatar:other.avatarUrl?(await s.provider.urls([other.avatarUrl]))[0]:'',goodsCover:c.goodsCover?(await s.provider.urls([c.goodsCover]))[0]:''};
    }));
  }
  if(p.action==='open') {
    const g=await s.store.get('goods',p.goodsId); assert(g && await s.visible(g),'CONTENT_UNAVAILABLE','商品不可用',403);
    const buyer=g.sellerId===openid?g.buyerId:openid; assert(buyer && buyer!==g.sellerId,'INVALID_STATE','尚未锁定买家'); await s.guardPair(buyer,g.sellerId);
    const previous=(await s.store.find('conversations',{goodsId:g._id,sellerId:g.sellerId,buyerId:buyer},{limit:1}))[0];
    const key=previous?._id || hash(g._id+':'+g.sellerId+':'+buyer);
    return s.store.transaction(async tx=>{
      await s.guardPair(buyer,g.sellerId,tx);
      let c=await tx.get('conversations',key); if(!c) {c=conversation(g,buyer,s.now(),key);await tx.put('conversations',key,c);} return c;
    });
  }
  const c=await s.store.get('conversations',p.conversationId); assert(c && [c.buyerId,c.sellerId].includes(openid),'FORBIDDEN','无权访问会话',403);
  const otherId=c.buyerId===openid?c.sellerId:c.buyerId;
  const g=await s.store.get('goods',c.goodsId); const blocked=await s.blocked(openid,otherId);
  if(p.action==='messages') {
    const all=await s.store.find('messages',{conversationId:c._id,moderationStatus:'approved',deliveryState:'delivered'},{sort:'createdAt',limit:100}); all.reverse();
    const other=await s.user(otherId,null,s.store,false);
    await s.store.transaction(async tx=>{const current=await tx.get('conversations',c._id);await tx.put('conversations',c._id,{...current,[c.sellerId===openid?'unreadSeller':'unreadBuyer']:0});});
    const contact=g && ['locked','sold'].includes(g.status) && g.buyerId===c.buyerId && g.enforcement!=='removed' && !blocked ? other.contact : '';
    let permitted=true;try{await s.user(openid,'message');}catch(e){if(['ACCOUNT_BANNED','ACCOUNT_RESTRICTED','PROFILE_REQUIRED'].includes(e.code))permitted=false;else throw e;}
    return {messages:all,other:{nickName:other.moderationStatus==='approved'?other.nickName:'校园用户',avatarUrl:other.moderationStatus==='approved'?other.avatarUrl:'',contact},state:g?.enforcement==='removed'?'removed':g?.moderationStatus!=='approved'?'review':g?.status || 'off',canSend:permitted && !!g && await s.visible(g) && !blocked && !['sold','off'].includes(g.status)};
  }
  assert(p.action==='send','NOT_FOUND','未知聊天操作',404); await s.guardPair(openid,otherId);
  assert(g && await s.visible(g) && ['on','locked'].includes(g.status),'INVALID_STATE','商品当前不可发送消息');
  const rules=await s.setting('rules'); await s.rate(openid,'message',rules.content.messagePerMinute,60000);
  const content=text(p.content,1000,true); const key=id();const version=id();
  await s.store.transaction(async tx=>{
    await s.user(openid,'message',tx);await s.guardPair(openid,otherId,tx);
    const currentGoods=await tx.get('goods',g._id); assert(await s.visible(currentGoods,tx) && ['on','locked'].includes(currentGoods.status),'INVALID_STATE','商品当前不可发送消息');
    await tx.put('messages',key,{_openid:openid,conversationId:c._id,fromId:openid,toId:otherId,content,moderationStatus:'review',contentVersion:version,createdAt:s.now()});
  });
  const result=await moderation.submit(s,'messages',key,openid,version,content);
  if(result.status!=='review') await moderation.applyResult(s,result.taskId,result.status,null,'自动检测结果');
  return {_id:key,moderationStatus:result.status};
}
module.exports = { login, goods, offer, chat, validateListing };
