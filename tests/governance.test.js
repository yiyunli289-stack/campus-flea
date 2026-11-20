'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {fixture}=require('./helpers');
const {adminAction,evidence}=require('../shared/server/governance');const {runWorker}=require('../shared/server/worker');
test('审核失败/服务异常内容不公开；人工复核后公开且记录通知审计',async()=>{
  const f=await fixture({provider:{text:async()=>{throw new Error('service down');}}});const gid=await f.listing();
  assert.deepEqual(await f.s.mini('goods',{action:'search'},'buyer'),[]);
  const c=(await f.store.find('moderationCases',{targetId:gid}))[0];
  await adminAction(f.s,f.reviewer,{op:'moderation.decide',id:c._id,decision:'approved',confirm:true,reason:'人工核查内容合规'});
  assert.equal((await f.s.mini('goods',{action:'search'},'buyer')).length,1);
  await assert.rejects(adminAction(f.s,f.reviewer,{op:'moderation.decide',id:c._id,decision:'approved',confirm:true,reason:'重复'}),e=>e.code==='CONFLICT');
  assert.equal((await f.store.find('notifications',{ownerId:'seller'})).length,1);
});
test('拉黑必须在服务端阻止双方报价与聊天',async()=>{
  const f=await fixture();const goodsId=await f.listing();const conv=await f.s.mini('chat',{action:'open',goodsId},'buyer');
  await f.s.mini('governance',{action:'block',targetId:'seller'},'buyer');
  await assert.rejects(f.s.mini('offer',{action:'create',goodsId,price:90},'buyer'),e=>e.code==='USER_BLOCKED');
  await assert.rejects(f.s.mini('chat',{action:'send',conversationId:conv._id,content:'你好'},'seller'),e=>e.code==='USER_BLOCKED');
  await f.s.mini('governance',{action:'unblock',targetId:'seller'},'buyer');
  assert((await f.s.mini('offer',{action:'create',goodsId,price:90},'buyer'))._id);
});
test('举报消息校验参与者；证据保留快照且处置反馈不泄露隐私',async()=>{
  const f=await fixture();const goodsId=await f.listing();const conv=await f.s.mini('chat',{action:'open',goodsId},'buyer');
  const m=await f.s.mini('chat',{action:'send',conversationId:conv._id,content:'原始留言'},'buyer');
  await assert.rejects(f.s.mini('report',{action:'create',targetType:'messages',targetId:m._id,reason:'举报'},'other'),e=>e.code==='FORBIDDEN');
  const r=await f.s.mini('report',{action:'create',targetType:'messages',targetId:m._id,reason:'核查消息'},'seller');
  await f.store.put('messages',m._id,{...(await f.store.get('messages',m._id)),content:'改写'});
  const e=await evidence(f.s,f.reviewer,{entity:'reports',id:r._id,reason:'核查证据'});assert.equal(e.target.content,'原始留言');
  await adminAction(f.s,f.reviewer,{op:'report.dismiss',id:r._id,confirm:true,reason:'未发现违规'});
  assert.equal((await f.s.mini('governance',{action:'myReports'},'seller'))[0].state,'resolved');
});
test('封禁即时生效；违规下架不能由卖家重新上架；恢复不复活sold',async()=>{
  const f=await fixture();const goodsId=await f.listing();
  await adminAction(f.s,f.reviewer,{op:'govern',targetType:'goods',targetId:goodsId,action:'remove',confirm:true,reason:'核查违规'});
  await assert.rejects(f.s.mini('goods',{action:'relist',id:goodsId},'seller'),e=>e.code==='INVALID_STATE');
  await f.store.put('goods',goodsId,{...(await f.store.get('goods',goodsId)),status:'sold'});
  await adminAction(f.s,f.reviewer,{op:'govern',targetType:'goods',targetId:goodsId,action:'restore',confirm:true,reason:'恢复历史展示'});
  assert.equal((await f.store.get('goods',goodsId)).status,'sold');
  await adminAction(f.s,f.reviewer,{op:'govern',targetType:'users',targetId:'buyer',action:'ban',confirm:true,reason:'严重骚扰'});
  await assert.rejects(f.s.mini('offer',{action:'create',goodsId,price:10},'buyer'),e=>e.code==='ACCOUNT_BANNED');
});
test('并发接受只成功一份；未选中通知幂等且不暴露入选信息',async()=>{
  const f=await fixture();const goodsId=await f.listing();
  const a=await f.s.mini('offer',{action:'create',goodsId,price:80},'buyer');const b=await f.s.mini('offer',{action:'create',goodsId,price:90},'other');
  const results=await Promise.allSettled([a,b].map(o=>f.s.mini('offer',{action:'accept',offerId:o._id},'seller')));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);await runWorker(f.s);await runWorker(f.s);
  assert.equal((await f.store.find('offers',{status:'accepted'})).length,1);assert.equal((await f.store.find('offers',{status:'rejected'})).length,1);
  const notices=await f.store.find('notifications',{type:'offer.not_selected'});assert.equal(notices.length,1);assert(!notices[0].content.includes('80'));
});
test('固定价取服务端标价；并发重复报价仅一份；限制账号不能绕过',async()=>{
  const f=await fixture();const goodsId=await f.listing({tradeType:'定价'});
  const results=await Promise.allSettled([1,2].map(price=>f.s.mini('offer',{action:'create',goodsId,price},'buyer')));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const o=(await f.store.find('offers'))[0];assert.equal(o.price,100);assert.equal(o.priceSnapshot,100);
  await adminAction(f.s,f.reviewer,{op:'govern',targetType:'users',targetId:'other',action:'restrict',restrictions:['offer'],hours:1,confirm:true,reason:'限制竞价'});
  await assert.rejects(f.s.mini('offer',{action:'create',goodsId,price:100},'other'),e=>e.code==='ACCOUNT_RESTRICTED');
});
test('待审核消息不出现在对方列表或会话摘要；通过后只投递一次',async()=>{
  const f=await fixture();const goodsId=await f.listing();const conv=await f.s.mini('chat',{action:'open',goodsId},'buyer');f.provider.text=async()=>({status:'review'});
  const msg=await f.s.mini('chat',{action:'send',conversationId:conv._id,content:'待复核消息'},'buyer');
  assert.equal((await f.s.mini('chat',{action:'messages',conversationId:conv._id},'seller')).messages.length,0);assert.equal((await f.store.get('conversations',conv._id)).lastMsg,'');
  const c=(await f.store.find('moderationCases',{targetId:msg._id}))[0];await adminAction(f.s,f.reviewer,{op:'moderation.decide',id:c._id,decision:'approved',confirm:true,reason:'核查通过'});
  await runWorker(f.s);await runWorker(f.s);assert.equal((await f.s.mini('chat',{action:'messages',conversationId:conv._id},'seller')).messages.length,1);
  assert.equal((await f.store.find('notifications',{type:'message.reply'})).length,1);
});
test('最终买家以外的询价会话不展示完整联系方式',async()=>{
  const f=await fixture();const goodsId=await f.listing();const other=await f.s.mini('chat',{action:'open',goodsId},'other');const offer=await f.s.mini('offer',{action:'create',goodsId,price:90},'buyer');
  await f.s.mini('offer',{action:'accept',offerId:offer._id},'seller');const r=await f.s.mini('chat',{action:'messages',conversationId:other._id},'other');assert.equal(r.other.contact,'');
});
