'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {fixture}=require('./helpers');const {adminAction}=require('../shared/server/governance');const {runWorker}=require('../shared/server/worker');
test('下架与接受报价并发后不会允许新的购买申请',async()=>{
  const f=await fixture();const gid=await f.listing();const o=await f.s.mini('offer',{action:'create',goodsId:gid,price:80},'buyer');
  await Promise.allSettled([f.s.mini('offer',{action:'accept',offerId:o._id},'seller'),adminAction(f.s,f.reviewer,{op:'govern',targetType:'goods',targetId:gid,action:'remove',reason:'违规处置',confirm:true})]);
  assert.equal((await f.store.get('goods',gid)).enforcement,'removed');await assert.rejects(f.s.mini('offer',{action:'create',goodsId:gid,price:100},'other'),e=>e.code==='INVALID_STATE');
  await runWorker(f.s);assert.equal((await f.store.get('offers',o._id)).status,'closed');
});
test('封禁买家关闭其已接受申请并解除商品承诺，保留历史',async()=>{
  const f=await fixture();const gid=await f.listing();const o=await f.s.mini('offer',{action:'create',goodsId:gid,price:80},'buyer');await f.s.mini('offer',{action:'accept',offerId:o._id},'seller');
  await adminAction(f.s,f.reviewer,{op:'govern',targetType:'users',targetId:'buyer',action:'ban',reason:'严重骚扰',confirm:true});
  await runWorker(f.s);await runWorker(f.s);assert.equal((await f.store.get('goods',gid)).status,'off');assert.equal((await f.store.get('offers',o._id)).status,'closed');
});
test('恢复前积压的下架任务不能关闭恢复后新创建的申请',async()=>{
  const f=await fixture();const gid=await f.listing();await adminAction(f.s,f.reviewer,{op:'govern',targetType:'goods',targetId:gid,action:'remove',reason:'下架',confirm:true});f.tick(1);
  await adminAction(f.s,f.reviewer,{op:'govern',targetType:'goods',targetId:gid,action:'restore',reason:'核查恢复',confirm:true});f.tick(1);
  const o=await f.s.mini('offer',{action:'create',goodsId:gid,price:80},'buyer');await runWorker(f.s);assert.equal((await f.store.get('offers',o._id)).status,'pending');
});
test('拉黑前送审的消息通过后仍不得投递给被拉黑者',async()=>{
  const f=await fixture();const gid=await f.listing();const c=await f.s.mini('chat',{action:'open',goodsId:gid},'buyer');f.provider.text=async()=>({status:'review'});
  const m=await f.s.mini('chat',{action:'send',conversationId:c._id,content:'待审核'},'buyer');const task=(await f.store.find('moderationCases',{targetId:m._id}))[0];
  await f.s.mini('governance',{action:'block',targetId:'buyer'},'seller');await adminAction(f.s,f.reviewer,{op:'moderation.decide',id:task._id,decision:'approved',reason:'文字合规',confirm:true});await runWorker(f.s);
  assert.equal((await f.s.mini('chat',{action:'messages',conversationId:c._id},'seller')).messages.length,0);
});
