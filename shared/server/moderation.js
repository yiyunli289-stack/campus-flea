'use strict';
const { assert, id, hash, text } = require('./core');
async function mediaTicket(s, openid) {
  await s.user(openid, 'upload', s.store, false);
  await s.rate(openid,'upload',60,3600000);
  const key = id(); const path = 'quarantine/' + hash(openid).slice(0,24) + '/' + key + '.jpg';
  await s.store.transaction(tx => tx.put('mediaFiles', key, { ownerId: openid, path, state: 'ticket', createdAt: s.now(), expiresAt: s.now() + 3600000 }));
  return { id: key, cloudPath: path };
}
async function registerMedia(s, openid, p) {
  await s.user(openid, 'upload', s.store, false);
  const m = await s.store.get('mediaFiles',p.id);
  assert(m?.ownerId === openid && m.expiresAt > s.now(), 'FORBIDDEN', '上传凭证无效', 403);
  assert(typeof p.fileID === 'string' && p.fileID.startsWith('cloud://') && p.fileID.endsWith('/' + m.path), 'INVALID_FILE', '文件与上传凭证不匹配');
  const info = await s.provider.inspect(p.fileID);
  assert(info.bytes > 0 && info.bytes <= 10 * 1024 * 1024 && info.image, 'INVALID_FILE', '仅接受不超过10MB的 JPEG/PNG 图片');
  await s.store.transaction(async tx => {
    const current = await tx.get('mediaFiles',p.id);
    assert(current.state === 'ticket' || current.fileID === p.fileID, 'CONFLICT', '上传凭证已使用', 409);
    await tx.put('mediaFiles',p.id,{...current,fileID:p.fileID,state:'uploaded',contentHash:info.hash});
  });
  return { fileID: p.fileID };
}
async function validateFiles(s, openid, files) {
  assert(Array.isArray(files) && files.length <= 16 && files.every(x => typeof x === 'string' && x.length <= 500), 'INVALID_FILE', '图片格式无效');
  for (const f of files) {
    const m = (await s.store.find('mediaFiles',{fileID:f},{limit:1}))[0];
    assert(m?.ownerId === openid && m.state === 'uploaded', 'INVALID_FILE', '请使用本人经登记的图片');
  }
}
async function submit(s, type, targetId, ownerId, version, content, files = []) {
  await validateFiles(s, ownerId, files);
  const rules = await s.setting('rules'); const key = id();
  let result;
  if (rules.content.prohibitedTerms.some(t => content.includes(t))) result = { status:'rejected', reason:'命中禁止内容规则' };
  else {
    try { result = await s.provider.text({ content, openid:ownerId, scene:type === 'users' ? 1 : type === 'messages' ? 2 : 3 }); }
    catch (_) { result = { status:'review', reason:'检测服务不可用，等待人工复核' }; }
  }
  const media = [];
  if (result.status !== 'rejected') {
    for (const fileID of files) {
      try { const r = await s.provider.image({ fileID, openid:ownerId }); media.push({fileID,traceId:r.traceId,status:r.status || 'pending'}); }
      catch (_) { media.push({fileID,traceId:'',status:'review'}); }
    }
  }
  const status = result.status === 'approved' && media.every(m => m.status === 'approved') ? 'approved' : result.status === 'rejected' ? 'rejected' : 'review';
  await s.store.transaction(async tx => {
    const target=await tx.get(type,targetId);
    assert(target?.contentVersion===version,'STALE_CONTENT','内容已更新，请重新提交检测',409);
    await tx.put(type,targetId,{...target,moderationTaskId:key});
    await tx.put('moderationTasks',key,{targetType:type,targetId,ownerId,version,contentHash:hash(content),textStatus:result.status,media,status,reason:result.reason || '',ruleVersion:rules.version,createdAt:s.now()});
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
    const next = { ...target, moderationStatus:status };
    if(task.targetType==='goods' && status==='rejected') {
      if (target.enforcement!=='removed') next.statusBeforeRemoval=target.status;
      next.enforcement='removed';
      if (['on','locked'].includes(target.status)) next.status='off';
      await s.enqueue(tx,'goods-state',taskId,{goodsId:target._id,state:'removed'});
    }
    if (task.targetType === 'users' && status === 'approved' && target.pendingProfile) {
      Object.assign(next,target.pendingProfile); delete next.pendingProfile;
      next.profileComplete = !!(next.nickName && next.campus && next.contact);
    }
    await tx.put(task.targetType,task.targetId,next);
    await tx.put('moderationTasks',taskId,{...task,status,decisionBy:actor?._id || 'callback',decisionReason:reason,decidedAt:s.now()});
    if (c) await tx.put('moderationCases',taskId,{...c,state:'resolved',decision:status,reason,decidedBy:actor?._id || 'callback',decidedAt:s.now()});
    await s.notify(tx,task.ownerId,'moderation:'+status,taskId,status === 'approved' ? '内容审核已通过' : '内容未通过审核：'+reason);
    if (task.targetType === 'messages' && status === 'approved') await s.enqueue(tx,'message-visible',taskId,{messageId:target._id});
    if (task.targetType === 'offers' && status === 'approved') await s.notify(tx,target.sellerId,'offer.new',taskId,'收到一份购买申请或更新的竞价');
    await s.audit(tx,actor,'moderation.'+status,task.targetId,before,{moderationStatus:status},reason);
  });
}
async function imageCallback(s, traceId, approved) {
  const inboxKey='callback:'+hash(traceId);
  await s.store.transaction(async tx=>{if(!await tx.get('settings',inboxKey))await tx.put('settings',inboxKey,{kind:'mediaCallback',traceId,approved,processed:false,createdAt:s.now()});});
  // Persist early callbacks before the detection transaction registers its trace index.
  const index = await s.store.get('settings','trace:'+hash(traceId));
  if(!index)return {deferred:true};
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
module.exports = { mediaTicket, registerMedia, validateFiles, submit, applyResult, imageCallback };
