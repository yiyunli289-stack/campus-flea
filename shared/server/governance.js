'use strict';
const { assert, id, hash, text, confirm, permit, publicAdmin } = require('./core');
const { mediaTicket, registerMedia, applyResult } = require('./moderation');
const { saveVersion, publishVersion } = require('./config');

async function targetForReport(s,type,key,openid) {
  assert(['goods','users','offers','messages'].includes(type),'INVALID_INPUT','举报对象无效');
  let target=await s.store.get(type,key);
  if(type==='users' && !target) target=await s.user(key,null,s.store,false);
  assert(target,'NOT_FOUND','举报对象不存在',404);
  if(type==='goods') assert(target.sellerId===openid || await s.visible(target),'FORBIDDEN','无法访问举报对象',403);
  if(type==='offers') assert([target.buyerId,target.sellerId].includes(openid),'FORBIDDEN','无权访问该报价',403);
  if(type==='messages') {
    const c=await s.store.get('conversations',target.conversationId);
    assert(c && [c.buyerId,c.sellerId].includes(openid),'FORBIDDEN','无权访问消息',403);
  }
  const ownerId=type==='goods'?target.sellerId:type==='users'?target._openid:type==='offers'?target.buyerId:target.fromId;
  const fields=type==='goods'?['title','desc','images','innerPhotos','cat','status','contentVersion']:
    type==='users'?['nickName','avatarUrl','accountStatus']:type==='offers'?['goodsId','price','message','meetingTime','meetingPlace','contentVersion']:['conversationId','content','fromId','createdAt','contentVersion'];
  return {target,ownerId,snapshot:Object.fromEntries(fields.map(k=>[k,target[k] ?? null]))};
}
async function miniGovernance(s,name,p,openid) {
  const u=await s.user(openid,null,s.store,false);
  if(p.action==='uploadTicket') return mediaTicket(s,openid);
  if(p.action==='registerMedia') return registerMedia(s,openid,p);
  if(p.action==='notifications') return s.store.find('notifications',{ownerId:openid},{sort:'createdAt',limit:100});
  if(p.action==='readNotification') return s.store.transaction(async tx=>{
    const n=await tx.get('notifications',p.id);assert(n?.ownerId===openid,'FORBIDDEN','无权操作',403);await tx.put('notifications',n._id,{...n,read:true});return {read:true};
  });
  if(p.action==='blocks') return s.store.find('userBlocks',{ownerId:openid,active:true},{sort:'createdAt',limit:100});
  if(p.action==='block' || p.action==='unblock') {
    assert(typeof p.targetId==='string' && p.targetId!==openid,'INVALID_INPUT','不能拉黑本人');
    const other=await s.user(p.targetId,null,s.store,false);
    await s.store.transaction(async tx=>{
      await tx.put('userBlocks',hash(openid+':'+p.targetId),{ownerId:openid,targetId:p.targetId,targetName:other.nickName,active:p.action==='block',createdAt:s.now()});
    }); return {active:p.action==='block'};
  }
  if(p.action==='myReports') {
    const list=await s.store.find('reports',{reporterId:openid},{sort:'createdAt',limit:100});
    return list.map(normalizeReport).map(r=>({_id:r._id,targetType:r.targetType,targetId:r.targetId,
      reason:r.reason,state:r.state,result:r.publicResult || '',createdAt:r.createdAt}));
  }
  assert(p.action==='create' || p.action==='appeal','NOT_FOUND','未知治理操作',404);
  const rules=(await s.setting('rules')).content; await s.rate(openid,'report',rules.reportPerHour,3600000);
  const type=p.targetType || 'goods'; const key=p.targetId || p.goodsId;
  const target=await targetForReport(s,type,key,openid);
  if(p.action==='appeal') assert(type==='goods' && target.ownerId===openid && target.target.enforcement==='removed','FORBIDDEN','只能申诉本人的违规下架商品',403);
  const reason=text(p.reason,200,true);const detail=text(p.detail,2000);const reportId=id();
  await s.store.transaction(tx=>tx.put('reports',reportId,{targetType:type,targetId:target.target._id,ownerId:target.ownerId,reporterId:openid,kind:p.action==='appeal'?'appeal':'report',reason,detail,snapshot:target.snapshot,state:'pending',status:'pending',version:1,createdAt:s.now()}));
  return {_id:reportId};
}

function normalizeReport(report) {
  return {
    ...report,
    targetType: report.targetType || 'goods',
    targetId: report.targetId || report.goodsId,
    kind: report.kind || 'report',
    state: report.state || report.status || 'pending'
  };
}

const entities = {
  goods:['goods','read','title'], users:['users','read','nickName'], reports:['reports','read','targetId'],
  moderation:['moderationCases','read','targetId'], risks:['riskEvents','read','type'],
  configs:['configVersions','configure','kind'], rules:['configVersions','configure','kind'],
  admins:['adminUsers','accounts','username'], audit:['auditLogs','audit','action'],
  tasks:['outboxTasks','read','kind'], actions:['governanceActions','read','targetId']
};
function summary(s,entity,doc) {
  if(entity==='admins') return publicAdmin(doc);
  if(entity==='users') return {_id:doc._id,nickName:doc.nickName,campus:doc.campus,college:doc.college,accountStatus:doc.accountStatus || 'normal',
    moderationStatus:doc.moderationStatus,restrictedUntil:doc.restrictedUntil,createdAt:doc.createdAt};
  if(entity==='reports') { const {snapshot,detail,reporterId,ownerId,_openid,...rest}=normalizeReport(doc);return rest; }
  if(entity==='moderation') {const {ownerId,...rest}=doc;return rest;}
  if(entity==='goods') return Object.fromEntries(['_id','title','cat','price','campus','condition','status','moderationStatus','enforcement','createdAt'].map(k=>[k,doc[k]]));
  if(entity==='risks') { const {facts,ownerId,...rest}=doc;return rest; }
  if(entity==='tasks') return Object.fromEntries(['_id','kind','state','attempts','lastError','createdAt'].map(k=>[k,doc[k]]));
  return doc;
}
async function adminList(s,actor,p) {
  const def=entities[p.entity];assert(def,'NOT_FOUND','未知列表',404);permit(actor,def[1]);
  const filter={}; const allowed={goods:['status','moderationStatus','enforcement'],users:['accountStatus'],reports:['state','targetType','kind'],moderation:['state','targetType'],risks:['state','type'],tasks:['state'],audit:['actorId','action'],actions:['targetId'],configs:['kind'],rules:['kind'],admins:['role']};
  for(const f of allowed[p.entity]) if(p[f]) filter[f]=text(p[f],100);
  if(p.entity==='configs') filter.kind='public'; if(p.entity==='rules') filter.kind='rules';
  if(p.entity==='audit' && actor.role!=='super') filter.actorId=actor._id;
  if(p.keyword) filter[def[2]]={$contains:text(p.keyword,100)};
  if(p.entity==='reports') {
    const alternatives = [];
    for (const [field, legacy] of [['state','status'],['targetId','goodsId']]) {
      if (!Object.hasOwn(filter, field)) continue;
      const value = filter[field];
      delete filter[field];
      alternatives.push([{ [field]: value }, { [field]: { $exists: false }, [legacy]: value }]);
    }
    if (alternatives.length) filter.$or = alternatives.reduce(
      (branches, choices) => branches.flatMap(branch => choices.map(choice => ({ ...branch, ...choice }))), [{}]
    );
    if (filter.targetType === 'goods' || filter.kind === 'report') {
      const branches = filter.$or || [{}];
      const fields = ['targetType','kind'].filter(field => filter[field] === ({ targetType:'goods', kind:'report' })[field]);
      filter.$or = fields.reduce((rows, field) => {
        const value = filter[field];
        delete filter[field];
        return rows.flatMap(row => [{ ...row, [field]: value }, { ...row, [field]: { $exists: false } }]);
      }, branches);
    }
  }
  if(p.from || p.to) {filter.createdAt={}; if(p.from) filter.createdAt.$gte=Number(p.from); if(p.to) filter.createdAt.$lte=Number(p.to);}
  const page=Math.max(1,Math.min(100000,Number(p.page)||1));const size=Math.max(1,Math.min(100,Number(p.size)||20));
  const list=await s.store.find(def[0],filter,{sort:'createdAt',skip:(page-1)*size,limit:size});const total=await s.store.count(def[0],filter);
  await s.store.transaction(tx=>s.audit(tx,actor,'query.'+p.entity,p.entity,null,{page,size,filter}));
  return {list:list.map(d=>summary(s,p.entity,d)),total,page,size};
}
async function evidence(s,actor,p) {
  permit(actor,'evidence');const reason=text(p.reason,200,true);
  assert(['reports','moderation','risks','goods','users'].includes(p.entity),'INVALID_INPUT','不支持此证据类型');
  const table=entities[p.entity][0];const stored=await s.store.get(table,p.id);assert(stored,'NOT_FOUND','记录不存在',404);
  const record=p.entity==='reports'?normalizeReport(stored):stored;
  let type=p.entity;let target=record;
  if(p.entity==='moderation') {type=record.targetType;target=await s.store.get(type,record.targetId);}
  if(p.entity==='reports') {
    type=record.targetType;
    target=record.snapshot || await s.store.get(type,record.targetId) || {title:record.goodsTitle || ''};
    if (!record.ownerId && type==='goods') record.ownerId=target.sellerId;
  }
  if(p.entity==='risks') target={facts:record.facts,ownerId:record.ownerId,type:record.type};
  if(type==='users' && target) {
    const pending=p.entity==='moderation'?target.pendingProfile:null;
    target=s.safeUser(target);
    if(pending) target={...target,previousNickName:target.nickName,nickName:pending.nickName,avatarUrl:pending.avatarUrl,campus:pending.campus,college:pending.college,major:pending.major};
  }
  const result={record:summary(s,p.entity,record),target:target?await s.signedEvidence(target):null};
  if (p.entity==='reports') result.reportDetail=record.detail || '';
  if(record.ownerId) result.ownerUserId=(await s.store.find('users',{_openid:record.ownerId},{limit:1}))[0]?._id;
  if(record.taskId) {
    const task=await s.store.get('moderationTasks',record.taskId);
    if(task) result.detection={status:task.status,textStatus:task.textStatus,media:task.media.map(m=>({status:m.status})),reason:task.reason,version:task.version};
  }
  await s.store.transaction(tx=>s.audit(tx,actor,'evidence.view',p.id,null,{entity:p.entity},reason));
  return result;
}
async function govern(s,actor,p) {
  permit(actor,'moderate'); const reason=confirm(p);
  assert(['goods','users'].includes(p.targetType),'INVALID_INPUT','处置对象无效');
  const allowed=p.targetType==='goods'?['remove','restore']:['warn','restrict','ban','unrestrict'];assert(allowed.includes(p.action),'INVALID_INPUT','处置动作无效');
  const actionId=id();
  return s.store.transaction(async tx=>{
    const obj=await tx.get(p.targetType,p.targetId);assert(obj,'NOT_FOUND','对象不存在',404);
    let next={...obj};
    if(p.targetType==='goods') {
      if(p.action==='remove') {
        assert(obj.enforcement!=='removed','INVALID_STATE','商品已违规下架',409);
        next.enforcement='removed';
        next.statusBeforeRemoval=obj.status;
        if (['on','locked'].includes(obj.status)) next.status='off';
      }
      if(p.action==='restore') {
        assert(obj.enforcement==='removed' && obj.moderationStatus==='approved','INVALID_STATE','先完成内容复核，才可恢复');
        const owner=await s.user(obj.sellerId,null,tx,false);
        assert(!['banned','deleted'].includes(owner.accountStatus),'INVALID_STATE','卖家状态不允许恢复');
        next.enforcement='normal';
        if(next.status==='locked' || obj.statusBeforeRemoval==='locked') {next.status='off';next.buyerId='';}
        else if (next.status==='off' && obj.statusBeforeRemoval==='on') next.status='on';
        delete next.statusBeforeRemoval;
      }
    } else {
      assert(obj.accountStatus!=='deleted','INVALID_STATE','已注销账号不能执行该处置',409);
      if(p.action==='ban') next.accountStatus='banned';
      if(p.action==='restrict') {
        assert(Array.isArray(p.restrictions) && p.restrictions.length>0 && p.restrictions.every(x=>['publish','offer','message','upload','profile'].includes(x)),'INVALID_INPUT','请选择限制能力');
        const hours=Number(p.hours);assert(Number.isFinite(hours)&&hours>=1&&hours<=8760,'INVALID_INPUT','限制期限为1至8760小时');
        Object.assign(next,{accountStatus:'restricted',restrictions:p.restrictions,restrictedUntil:s.now()+hours*3600000});
      }
      if(p.action==='unrestrict') Object.assign(next,{accountStatus:'normal',restrictions:[],restrictedUntil:0});
    }
    next.updatedAt=s.now();await tx.put(p.targetType,p.targetId,next);
    const ownerId=p.targetType==='users'?obj._openid:obj.sellerId;
    await tx.put('governanceActions',actionId,{targetType:p.targetType,targetId:p.targetId,ownerId,action:p.action,reason,adminId:actor._id,createdAt:s.now()});
    const actionName={remove:'违规下架',restore:'恢复商品展示',warn:'警告',restrict:'限制账号能力',ban:'封禁账号',unrestrict:'解除账号限制'}[p.action];
    await s.notify(tx,ownerId,'governance',actionId,'平台处置：'+actionName+'；原因：'+reason);
    if(p.action==='remove') await s.enqueue(tx,'goods-state',actionId,{goodsId:obj._id,state:'removed'});
    if(p.action==='ban') await s.enqueue(tx,'user-ban',actionId,{openid:obj._openid});
    if(p.caseId) {
      const original=await tx.get('reports',p.caseId);
      assert(original,'NOT_FOUND','举报不存在',404);
      const report=normalizeReport(original);
      assert(report.state!=='resolved','CONFLICT','举报已处理',409);
      const reportedOwner=report.ownerId || (report.targetType==='goods' && (await tx.get('goods',report.targetId))?.sellerId);
      assert((report.targetType===p.targetType && report.targetId===p.targetId) || (p.targetType==='users' && reportedOwner===ownerId),'INVALID_INPUT','处置对象与举报不一致');
      await tx.put('reports',report._id,{...report,state:'resolved',status:'resolved',version:(report.version||0)+1,actionId,publicResult:'已核查并采取平台处置措施',decidedBy:actor._id,decidedAt:s.now()});
      await s.notify(tx,report.reporterId,'report.result',report._id,'举报已核查并处理，感谢反馈');
    }
    await s.audit(tx,actor,'governance.'+p.action,p.targetId,{accountStatus:obj.accountStatus || null,enforcement:obj.enforcement || null},{accountStatus:next.accountStatus || null,enforcement:next.enforcement || null,actionId},reason);
    return {actionId};
  });
}
async function adminAction(s,actor,p) {
  if (typeof p.op==='string' && p.op.startsWith('booklist.')) return require('./booklists').adminAction(s,actor,p);
  if(p.op==='config.save') {permit(actor,'configure');return saveVersion(s,actor,p);}
  if(p.op==='config.publish') {permit(actor,'configure');return publishVersion(s,actor,p);}
  if(p.op==='admin.create') {permit(actor,'accounts');confirm(p);return s.auth.createAccount(actor,p);}
  if(p.op==='admin.update') {confirm(p);return s.auth.updateAccount(actor,p);}
  if(p.op==='password.change') return s.auth.updateAccount(actor,{...p,id:actor._id});
  if(p.op==='govern') return govern(s,actor,p);
  if(p.op==='moderation.decide') {permit(actor,'moderate');const reason=confirm(p);assert(['approved','rejected'].includes(p.decision),'INVALID_INPUT','审核决定无效');await applyResult(s,p.id,p.decision,actor,reason);return {decided:true};}
  if(p.op==='moderation.queue') {
    permit(actor,'moderate');const reason=confirm(p);
    assert(p.targetType==='goods' || p.targetType==='users','INVALID_INPUT','复核对象无效');
    return s.store.transaction(async tx=>{
      const target=await tx.get(p.targetType,p.targetId);assert(target,'NOT_FOUND','对象不存在',404);
      assert(!target.moderationTaskId,'CONFLICT','此内容已有审核记录，请从审核队列发起复核',409);
      const version=target.contentVersion || id();
      const key=id();
      const ownerId=p.targetType==='goods'?target.sellerId:target._openid;
      assert(ownerId,'INVALID_STATE','缺少内容所有者');
      const next={...target,contentVersion:version,moderationStatus:'review',moderationTaskId:key};
      if (p.targetType==='goods') next.enforcement ||= 'normal';
      await tx.put('moderationTasks',key,{targetType:p.targetType,targetId:target._id,ownerId,version,status:'review',textStatus:'review',media:[],reason,createdAt:s.now()});
      await tx.put('moderationCases',key,{taskId:key,targetType:p.targetType,targetId:target._id,ownerId,version,state:'pending',createdAt:s.now()});
      await tx.put(p.targetType,target._id,next);
      await s.audit(tx,actor,'moderation.queue',target._id,null,{taskId:key},reason);
      return {_id:key};
    });
  }
  if(p.op==='moderation.reopen') {
    permit(actor,'moderate');const reason=confirm(p);const key=id();
    return s.store.transaction(async tx=>{
      const original=await tx.get('moderationTasks',p.id);assert(original,'NOT_FOUND','原审核任务不存在',404);
      const target=await tx.get(original.targetType,original.targetId);assert(target?.contentVersion===original.version,'STALE_CONTENT','内容已变化，请处理当前版本',409);
      const oldCase=await tx.get('moderationCases',p.id);
      if(oldCase)await tx.put('moderationCases',p.id,{...oldCase,state:'superseded',reason:'发起新一轮人工复核'});
      await tx.put('moderationTasks',key,{...original,_id:key,status:'review',textStatus:'review',decidedAt:0,decisionBy:'',decisionReason:'',reason:'重新人工复核：'+reason,createdAt:s.now()});
      await tx.put('moderationCases',key,{taskId:key,targetType:original.targetType,targetId:original.targetId,ownerId:original.ownerId,version:original.version,state:'pending',createdAt:s.now()});
      await tx.put(original.targetType,original.targetId,{...target,moderationStatus:'review',moderationTaskId:key});
      await s.audit(tx,actor,'moderation.reopen',original.targetId,{taskId:p.id},{taskId:key},reason);return {_id:key};
    });
  }
  if(p.op==='report.dismiss') {
    permit(actor,'moderate');const reason=confirm(p);
    return s.store.transaction(async tx=>{
      const raw=await tx.get('reports',p.id);assert(raw,'NOT_FOUND','举报不存在',404);
      const r=normalizeReport(raw);assert(r.state!=='resolved','CONFLICT','举报已处理',409);
      await tx.put('reports',r._id,{...r,state:'resolved',status:'resolved',publicResult:'核查后未确认违规：'+reason,decidedBy:actor._id,decidedAt:s.now()});
      await s.notify(tx,r.reporterId,'report.result',r._id,'举报处理结果：'+reason);
      await s.audit(tx,actor,'report.dismiss',r._id,{state:r.state},{state:'resolved'},reason);return {resolved:true};
    });
  }
  if(p.op==='risk.resolve') {
    permit(actor,'moderate');const reason=confirm(p);
    return s.store.transaction(async tx=>{
      const r=await tx.get('riskEvents',p.id);assert(r && r.state==='pending','CONFLICT','风险记录已处理',409);
      await tx.put('riskEvents',r._id,{...r,state:'resolved',result:reason,decidedBy:actor._id,decidedAt:s.now()});
      await s.audit(tx,actor,'risk.resolve',r._id,{state:r.state},{state:'resolved'},reason);return {resolved:true};
    });
  }
  if(p.op==='task.retry') {
    permit(actor,'moderate');const reason=confirm(p);
    return s.store.transaction(async tx=>{
      const t=await tx.get('outboxTasks',p.id);assert(t && t.state==='failed','INVALID_STATE','只能重试失败任务');
      await tx.put('outboxTasks',t._id,{...t,state:'pending',attempts:0,nextAt:s.now()});await s.audit(tx,actor,'task.retry',p.id,null,{state:'pending'},reason);return {queued:true};
    });
  }
  assert(false,'NOT_FOUND','未知管理操作',404);
}
module.exports={miniGovernance,adminList,evidence,govern,adminAction,entities};
