'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {fixture}=require('./helpers');const {adminAction,adminList}=require('../shared/server/governance');
test('迟到的自动检测结果不能覆盖已完成的人工决定',async()=>{
  const f=await fixture({provider:{text:async()=>({status:'review'})}});const gid=await f.listing();const c=(await f.store.find('moderationCases',{targetId:gid}))[0];
  await adminAction(f.s,f.reviewer,{op:'moderation.decide',id:c._id,decision:'approved',reason:'人工核查确认合规',confirm:true});
  await require('../shared/server/moderation').applyResult(f.s,c._id,'rejected',null,'迟到回调');
  assert.equal((await f.store.get('goods',gid)).moderationStatus,'approved');assert.equal((await f.store.get('moderationTasks',c._id)).decisionBy,f.reviewer._id);
});
test('复核误判保留原决定，新审核通过后仍需显式恢复商品',async()=>{
  const f=await fixture({provider:{text:async()=>({status:'review'})}});const gid=await f.listing();const original=(await f.store.find('moderationCases',{targetId:gid}))[0];
  await adminAction(f.s,f.reviewer,{op:'moderation.decide',id:original._id,decision:'rejected',reason:'初次核查',confirm:true});
  assert.equal((await f.store.get('goods',gid)).enforcement,'removed');
  const reopened=await adminAction(f.s,f.reviewer,{op:'moderation.reopen',id:original._id,reason:'补充证据后重新复核',confirm:true});
  await assert.rejects(adminAction(f.s,f.reviewer,{op:'moderation.decide',id:original._id,decision:'approved',reason:'旧任务不能放行',confirm:true}),e=>e.code==='STALE_CONTENT');
  await adminAction(f.s,f.reviewer,{op:'moderation.decide',id:reopened._id,decision:'approved',reason:'新证据核查通过',confirm:true});
  assert.equal((await f.store.get('goods',gid)).enforcement,'removed');
  await adminAction(f.s,f.reviewer,{op:'govern',targetType:'goods',targetId:gid,action:'restore',reason:'完成复核，恢复展示',confirm:true});
  assert.equal((await f.store.get('goods',gid)).enforcement,'normal');assert.equal((await f.store.get('moderationTasks',original._id)).status,'rejected');
});
test('运营只读列表不包含风险金额、报价买家身份、消息任务载荷',async()=>{
  const f=await fixture();await f.store.put('riskEvents','risk',{type:'low-price',targetId:'goods',ownerId:'secret-buyer',facts:{price:12},state:'pending',createdAt:1});
  await f.store.put('moderationCases','case',{targetType:'offers',ownerId:'secret-buyer',targetId:'offer',state:'pending',createdAt:1});
  await f.store.put('outboxTasks','task',{kind:'message-visible',data:{openid:'secret-user',content:'private'},state:'pending',createdAt:1});
  for(const entity of ['risks','moderation','tasks']){const r=JSON.stringify(await adminList(f.s,f.readonly,{entity}));assert(!r.includes('secret-'));assert(!r.includes('private'));assert(!r.includes('"price"'));}
});
