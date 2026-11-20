'use strict';
const { assert, id, hash } = require('./core');
const trade = require('./trade-state');
async function mediaTicket(s, openid) {
  await s.user(openid, 'upload', s.store, false);
  await s.rate(openid,'upload',60,3600000);
  const key = id(); const path = 'quarantine/' + hash(openid).slice(0,24) + '/' + key + '.jpg';
  const upload = await s.provider.uploadTicket(path);
  await s.store.transaction(async tx => {
    await s.user(openid,'upload',tx,false);
    await tx.put('mediaFiles',key,{ownerId:openid,path,sourceFileID:upload.fileID,state:'ticket',
      createdAt:s.now(),expiresAt:s.now()+15*60000});
  });
  return {id:key,cloudPath:path,...upload};
}
async function registerMedia(s, openid, p) {
  await s.user(openid, 'upload', s.store, false);
  const m = await s.store.get('mediaFiles',p.id);
  assert(m?.ownerId === openid && m.expiresAt > s.now(),'FORBIDDEN','上传凭证无效',403);
  assert(p.fileID === m.sourceFileID && typeof p.fileID === 'string', 'INVALID_FILE','文件与上传凭证不匹配');
  if (m.state === 'uploaded') return {fileID:m.fileID};
  const info = await s.provider.inspect(m.sourceFileID);
  assert(info.bytes > 0 && info.bytes <= 10*1024*1024 && info.image,'INVALID_FILE','仅接受不超过10MB的 JPEG/PNG 图片');
  const fileID = await s.provider.freeze('registered/' + p.id + '/' + info.hash + info.extension,info.content);
  return s.store.transaction(async tx => {
    await s.user(openid,'upload',tx,false);
    const current = await tx.get('mediaFiles',p.id);
    assert(current?.ownerId === openid && current.expiresAt > s.now(),'FORBIDDEN','上传凭证无效',403);
    if (current.state === 'uploaded') return {fileID:current.fileID};
    await tx.put('mediaFiles',p.id,{...current,fileID,state:'uploaded',contentHash:info.hash});
    return {fileID};
  });
}

async function validateFiles(s, openid, files) {
  assert(Array.isArray(files) && files.length <= 16 && files.every(x => typeof x === 'string' && x.length <= 500), 'INVALID_FILE', '图片格式无效');
  for (const f of files) {
    const m = (await s.store.find('mediaFiles',{fileID:f},{limit:1}))[0];
    assert(m?.ownerId === openid && m.state === 'uploaded', 'INVALID_FILE', '请使用本人经登记的图片');
  }
}
function goodsText(g) {
  const fields = ['title', 'desc', 'meetingPlace', 'attributes', 'noteDesc', 'defects', 'author', 'publisher', 'edition'];
  return JSON.stringify(Object.fromEntries(fields.map(field => [field, g[field]])));
}
async function queueGoods(s, tx, g) {
  const key = g.moderationTaskId;
  const previous = (await tx.get('goods', g._id))?.moderationTaskId;
  if (previous && previous !== key) {
    const c = await tx.get('moderationCases', previous);
    if (c?.state === 'pending') await tx.put('moderationCases', previous, { ...c, state:'superseded' });
  }
  const task = { targetType:'goods', targetId:g._id, ownerId:g.sellerId, version:g.contentVersion,
    status:'review', textStatus:'review', media:[], reason:'等待后验审核', createdAt:s.now() };
  await tx.put('goods', g._id, g);
  await tx.put('moderationTasks', key, task);
  await tx.put('moderationCases', key, { taskId:key, ...task, state:'pending' });
  await s.enqueue(tx, 'review-goods', key, { goodsId:g._id, taskId:key });
}
async function reviewGoods(s, { goodsId, taskId }) {
  const g = await s.store.get('goods', goodsId);
  const task = await s.store.get('moderationTasks', taskId);
  if (!g || g.status === 'deleted' || g.moderationTaskId !== taskId || !task || task.decidedAt) return;
  if (task.detectedAt && !['approved', 'rejected'].includes(task.status)) return;
  let result;
  try {
    result = task.detectedAt ? task : await submit(
      s, 'goods', goodsId, g.sellerId, g.contentVersion, goodsText(g),
      [...(g.images || []), ...(g.innerPhotos || [])], taskId
    );
    if (result && result.status !== 'review') await applyResult(s, taskId, result.status, null, result.reason || '自动检测结果');
  } catch (error) {
    if (error.code !== 'STALE_CONTENT') throw error;
  }
}
async function submit(s, type, targetId, ownerId, version, content, files = [], queuedId) {
  if (!queuedId) await validateFiles(s, ownerId, files);
  const rules = await s.setting('rules'); const key = queuedId || id();
  let result;
  if (rules.content.prohibitedTerms.some(t => content.includes(t))) result = { status:'rejected', reason:'命中禁止内容规则' };
  else {
    try { result = await s.provider.text({ content, openid:ownerId, scene:type === 'users' ? 1 : type === 'messages' ? 2 : 3 }); }
    catch (error) { if (queuedId) throw error; result = { status:'review', reason:'检测服务不可用，等待人工复核' }; }
  }
  const media = [];
  if (result.status !== 'rejected') {
    for (const fileID of files) {
      try { const r = await s.provider.image({ fileID, openid:ownerId }); media.push({fileID,traceId:r.traceId,status:r.status || 'pending'}); }
      catch (error) { if (queuedId) throw error; media.push({fileID,traceId:'',status:'review'}); }
    }
  }
  const status = result.status === 'approved' && media.every(m => m.status === 'approved') ? 'approved' : result.status === 'rejected' ? 'rejected' : 'review';
  await s.store.transaction(async tx => {
    const target=await tx.get(type,targetId);
    assert(target?.contentVersion===version && (!queuedId || target.moderationTaskId === key && target.status !== 'deleted'),
      'STALE_CONTENT','内容已更新，请重新提交检测',409);
    const previous = queuedId && await tx.get('moderationTasks', key);
    assert(!previous?.decidedAt, 'STALE_CONTENT', '审核决定已提交', 409);
    await tx.put(type,targetId,{...target,moderationTaskId:key});
    await tx.put('moderationTasks',key,{targetType:type,targetId,ownerId,version,contentHash:hash(content),textStatus:result.status,
      media,status,reason:result.reason || '',ruleVersion:rules.version, createdAt:previous?.createdAt || s.now(), detectedAt:s.now()});
    for (const m of media) if (m.traceId) await tx.put('settings','trace:'+hash(m.traceId),{taskId:key});
    if (status !== 'approved') await tx.put('moderationCases',key,{taskId:key,targetType:type,targetId,ownerId,version,state:'pending',createdAt:s.now()});
  });
  return { status, taskId:key };
}
async function applyResult(s, taskId, status, actor, reason) {
  await s.store.transaction(async tx => {
    const task = await tx.get('moderationTasks',taskId); assert(task,'NOT_FOUND','审核任务不存在',404);
    const target = await tx.get(task.targetType,task.targetId);
    assert(target && target.contentVersion === task.version && target.moderationTaskId===taskId, 'STALE_CONTENT','内容或检测任务已更新，请重新审核',409);
    const c = await tx.get('moderationCases',taskId);
    // A late automatic callback must not override an explicit or already committed decision.
    if(!actor && task.decidedAt) return;
    if (actor) assert(c?.state === 'pending','CONFLICT','审核已处理',409);
    const before = { moderationStatus:target.moderationStatus };
    let next = { ...target, moderationStatus:status };
    if (task.targetType === 'goods') {
      assert(target.status !== 'deleted', 'STALE_CONTENT', '商品已删除', 409);
      if (status === 'rejected') {
        const statusBeforeRemoval = target.statusBeforeRemoval || target.status;
        const disposition = { moderationStatus:status, enforcement:'removed', statusBeforeRemoval, governanceReason:reason,
          governanceActionId:target.enforcement === 'removed' ? target.governanceActionId || taskId : taskId };
        next = await trade.closeTrade(s, tx, target, ['on','locked'].includes(target.status) ? 'off' : target.status, 'removed', disposition);
      }
    }
    if (task.targetType === 'users' && status === 'approved' && target.pendingProfile) {
      assert(target.accountStatus !== 'deleted' && (!target.pendingProfileEpoch || target.pendingProfileEpoch === trade.epoch(target)),
        'STALE_CONTENT', '账号状态已变化', 409);
      if (!trade.accountState(target, s.now()).allowedCapabilities.includes('profile')) next.moderationStatus = 'review';
      else {
        Object.assign(next, target.pendingProfile);
        delete next.pendingProfile;
        next.profileComplete = !!(next.nickName && next.campus && next.contact);
      }
    }
    await tx.put(task.targetType,task.targetId,next);
    await tx.put('moderationTasks',taskId,{...task,status,decisionBy:actor?._id || 'callback',decisionReason:reason,decidedAt:s.now()});
    if (c) await tx.put('moderationCases',taskId,{...c,state:'resolved',decision:status,reason,decidedBy:actor?._id || 'callback',decidedAt:s.now()});
    await s.notify(tx,task.ownerId,'moderation:'+status,taskId,status === 'approved' ? '内容审核已通过' : '内容未通过审核：'+reason);
    if (task.targetType === 'messages' && status === 'approved') await s.enqueue(tx,'message-visible',taskId,{messageId:target._id});
    if (task.targetType === 'offers' && status === 'approved') {
      const g = await tx.get('goods', target.goodsId);
      const { seller, buyer } = await trade.parties(s, g, target.buyerId, tx);
      if (trade.offerState(target, g, seller, buyer, s.now()) === 'pending' &&
          !await s.blocked(target.buyerId, target.sellerId, tx)) {
        await s.notify(tx,target.sellerId,'offer.new',taskId,'收到一份购买申请或更新的竞价');
      }
    }
    await s.audit(tx,actor,'moderation.'+status,task.targetId,before,{moderationStatus:status},reason);
  });
}
async function imageCallback(s, traceId, approved) {
  const inboxKey='callback:'+hash(traceId);
  await s.store.transaction(async tx=>{if(!await tx.get('settings',inboxKey))await tx.put('settings',inboxKey,{kind:'mediaCallback',traceId,approved,processed:false,createdAt:s.now()});});
  // Persist early callbacks before the detection transaction registers its trace index.
  const index = await s.store.get('settings','trace:'+hash(traceId));
  if (!index) {
    const inbox = await s.store.get('settings',inboxKey);
    if (inbox?.receivedAt && inbox.receivedAt + 3600000 <= s.now()) {
      await s.store.transaction(tx=>tx.put('settings',inboxKey,{...inbox,processed:true,orphaned:true}));
      return {ignored:true};
    }
    return {deferred:true,inboxKey};
  }
  const actual = await s.store.get('moderationTasks',index.taskId);
  const inbox=await s.store.get('settings',inboxKey);approved=inbox.approved;
  if (!actual || actual.status !== 'review') {await s.store.transaction(tx=>tx.put('settings',inboxKey,{...inbox,processed:true}));return { ignored:true };}
  await s.store.transaction(async tx => {
    const t = await tx.get('moderationTasks',actual._id);
    if (t.status !== 'review') return;
    const media = t.media.map(m => m.traceId === traceId ? {...m,status:approved?'approved':'rejected'} : m);
    await tx.put('moderationTasks',t._id,{...t,media});
  });
  const updated = await s.store.get('moderationTasks',actual._id);
  const status = updated.media.some(m => m.status === 'rejected') ? 'rejected' : updated.textStatus === 'approved' && updated.media.every(m => m.status === 'approved') ? 'approved' : null;
  if (status) {
    try { await applyResult(s,updated._id,status,null,'图片检测回调'); }
    catch (e) { if (!['STALE_CONTENT','NOT_FOUND'].includes(e.code)) throw e; }
  }
  await s.store.transaction(tx=>tx.put('settings',inboxKey,{...inbox,processed:true}));
  return { processed:true };
}
module.exports = { mediaTicket, registerMedia, validateFiles, submit, applyResult, imageCallback, queueGoods, reviewGoods };
