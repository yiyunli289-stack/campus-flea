'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');const {fixture}=require('./helpers');
const {adminAction}=require('../shared/server/governance');const {runWorker}=require('../shared/server/worker');const {canonical,hash}=require('../shared/server/core');
const {imageCallback}=require('../shared/server/moderation');const {callback,signature}=require('../shared/server/wechat-callback');
test('配置草稿不生效；发布及回滚生效；停用字典拒绝新发布',async()=>{
  const f=await fixture();const initial=await f.s.setting('public');const next=structuredClone(initial.content);next.categories.find(x=>x.code==='digital').active=false;
  const draft=await adminAction(f.s,f.superAdmin,{op:'config.save',kind:'public',content:next});assert.equal((await f.s.setting('public')).version,initial.version);
  await adminAction(f.s,f.superAdmin,{op:'config.publish',id:draft._id,confirm:true,reason:'停用数码'});
  await assert.rejects(f.listing(),e=>e.code==='INVALID_INPUT');
  await adminAction(f.s,f.superAdmin,{op:'config.publish',id:initial.version,confirm:true,reason:'恢复原配置'});assert(await f.listing());
});
test('动态字段前后端契约：必填、枚举、数字和非法字段编码校验',async()=>{
  const f=await fixture();const initial=await f.s.setting('public');const next=structuredClone(initial.content);next.categories.find(x=>x.code==='digital').fields=[{code:'brand',name:'品牌',type:'enum',required:true,options:['甲','乙']}];
  const d=await adminAction(f.s,f.superAdmin,{op:'config.save',kind:'public',content:next});await adminAction(f.s,f.superAdmin,{op:'config.publish',id:d._id,confirm:true,reason:'配置字段'});
  await assert.rejects(f.listing({attributes:{brand:'丙'}}),e=>e.code==='INVALID_INPUT');assert(await f.listing({attributes:{brand:'甲'}}));
  next.categories.find(x=>x.code==='digital').fields[0].code='constructor';await assert.rejects(adminAction(f.s,f.superAdmin,{op:'config.save',kind:'public',content:next}),e=>e.code==='INVALID_CONFIG');
});
test('图书照片约束与上传凭证：不接受外部URL、其他用户文件或无举证发布',async()=>{
  const f=await fixture();await assert.rejects(f.listing({images:[]}),e=>e.code==='INVALID_FILE');
  await assert.rejects(f.listing({cat:'book',noteLevel:'少量'}),e=>e.code==='NOTE_PHOTO_REQUIRED');
  await assert.rejects(f.listing({images:['https://evil.example/image']}),e=>e.code==='INVALID_FILE');
  const ticket=await f.s.mini('governance',{action:'uploadTicket'},'buyer');
  await assert.rejects(f.s.mini('governance',{action:'registerMedia',id:ticket.id,fileID:'cloud://env/'+ticket.cloudPath},'other'),e=>e.code==='FORBIDDEN');
  const media=await f.s.mini('governance',{action:'registerMedia',id:ticket.id,fileID:'cloud://env/'+ticket.cloudPath},'buyer');assert(media.fileID);
});
test('图片回调前不公开，重复回调不重复通知，旧版本不能放行新内容',async()=>{
  const f=await fixture({provider:{image:async()=>({status:'pending',traceId:'trace-pending'})}});const goodsId=await f.listing();assert.equal((await f.s.mini('goods',{action:'search'},'buyer')).length,0);
  await imageCallback(f.s,'trace-pending',true);await imageCallback(f.s,'trace-pending',true);assert.equal((await f.s.mini('goods',{action:'search'},'buyer')).length,1);
  assert.equal((await f.store.find('notifications',{ownerId:'seller'})).length,1);
  f.provider.image=async()=>({status:'pending',traceId:'trace-new'});const second=await f.listing();const g=await f.store.get('goods',second);await f.store.put('goods',second,{...g,contentVersion:'new-version',moderationStatus:'review'});
  await imageCallback(f.s,'trace-new',true);assert.equal((await f.store.get('goods',second)).moderationStatus,'review');
});
test('早到图片回调持久化，后续任务登记后自动补偿',async()=>{
  const f=await fixture({provider:{image:async()=>({status:'pending',traceId:'early-trace'})}});
  assert((await imageCallback(f.s,'early-trace',true)).deferred);const gid=await f.listing();await runWorker(f.s);assert.equal((await f.store.get('goods',gid)).moderationStatus,'approved');
});
test('微信回调拒绝伪造签名，接受有效签名和AES加密回调',async()=>{
  const f=await fixture();const timestamp=String(Math.floor(Date.now()/1000));const nonce='nonce';
  const body=JSON.stringify({Event:'wxa_media_check',trace_id:'test',result:{suggest:'pass'}});
  assert.equal((await callback(f.s,{httpMethod:'POST',body,queryStringParameters:{timestamp,nonce,signature:'bad'}})).statusCode,403);
  const sig=signature([f.env.CALLBACK_TOKEN,timestamp,nonce]);assert.equal((await callback(f.s,{httpMethod:'POST',body,queryStringParameters:{timestamp,nonce,signature:sig}})).statusCode,200);
  const key=crypto.randomBytes(32);f.env.CALLBACK_AES_KEY=key.toString('base64').slice(0,-1);f.env.WECHAT_APPID='wx-test';
  const content=Buffer.from(body);const len=Buffer.alloc(4);len.writeUInt32BE(content.length);let plain=Buffer.concat([crypto.randomBytes(16),len,content,Buffer.from('wx-test')]);const pad=32-plain.length%32;plain=Buffer.concat([plain,Buffer.alloc(pad,pad)]);
  const cipher=crypto.createCipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false);const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]).toString('base64');
  const r=await callback(f.s,{httpMethod:'POST',body:JSON.stringify({Encrypt:encrypted}),queryStringParameters:{timestamp,nonce,msg_signature:signature([f.env.CALLBACK_TOKEN,timestamp,nonce,encrypted])}});assert.equal(r.statusCode,200);
  const echo=await callback(f.s,{httpMethod:'GET',queryStringParameters:{timestamp,nonce,echostr:encrypted,msg_signature:signature([f.env.CALLBACK_TOKEN,timestamp,nonce,encrypted])}});assert.equal(echo.body,body);
});
test('报价修改间隔、低价待复核、消息限流',async()=>{
  const f=await fixture();const gid=await f.listing();const o=await f.s.mini('offer',{action:'create',goodsId:gid,price:80},'buyer');
  await assert.rejects(f.s.mini('offer',{action:'update',offerId:o._id,price:70},'buyer'),e=>e.code==='PRICE_CHANGE_LIMIT');
  f.tick(301000);await f.s.mini('offer',{action:'update',offerId:o._id,price:5},'buyer');assert.equal((await f.store.get('offers',o._id)).moderationStatus,'review');
  const conv=await f.s.mini('chat',{action:'open',goodsId:gid},'buyer');const settings=await f.s.setting('rules');await f.store.put('settings','rules',{...settings,content:{...settings.content,messagePerMinute:1}});
  await f.s.mini('chat',{action:'send',conversationId:conv._id,content:'正常消息'},'buyer');await assert.rejects(f.s.mini('chat',{action:'send',conversationId:conv._id,content:'第二条'},'buyer'),e=>e.code==='RATE_LIMITED');
});
test('审核中的昵称不提前公开；通过后更新；联系人不进入审计',async()=>{
  const f=await fixture({provider:{text:async()=>({status:'review'})}});await f.s.mini('login',{action:'updateProfile',nickName:'新昵称',contact:'private-contact',campus:'江安校区',college:'计算机学院'},'seller');
  const u=await f.store.get('users','seller');assert.equal(u.nickName,'seller');const task=(await f.store.find('moderationCases',{targetType:'users'}))[0];
  await adminAction(f.s,f.reviewer,{op:'moderation.decide',id:task._id,decision:'approved',confirm:true,reason:'昵称正常'});assert.equal((await f.store.get('users','seller')).nickName,'新昵称');
  const audit=JSON.stringify(await f.store.find('auditLogs',{}, {limit:100}));assert(!audit.includes('private-contact'));
});
test('审计链签名可校验，篡改后检测失败，事务失败不留下伪成功审计',async()=>{
  const f=await fixture();await f.s.store.transaction(tx=>f.s.audit(tx,f.superAdmin,'test','target',null,{value:1}));
  const log=(await f.store.find('auditLogs'))[0];const {digest,...payload}=log;assert.equal(digest,crypto.createHmac('sha256',f.env.AUDIT_SECRET).update(canonical(payload)).digest('hex'));
  payload.after.value=2;assert.notEqual(digest,crypto.createHmac('sha256',f.env.AUDIT_SECRET).update(canonical(payload)).digest('hex'));
  await assert.rejects(f.store.transaction(async tx=>{await f.s.audit(tx,f.superAdmin,'failed','target',null,{});throw new Error('rollback');}));assert.equal((await f.store.find('auditLogs')).length,1);
});
test('失败任务重试有上限并可由审核员恢复；只读不能重试',async()=>{
  const f=await fixture();await f.store.put('outboxTasks','bad',{kind:'unknown',data:{},state:'pending',attempts:0,nextAt:0,createdAt:0});
  for(let i=0;i<5;i++){await runWorker(f.s);f.tick(100000);}assert.equal((await f.store.get('outboxTasks','bad')).state,'failed');
  await assert.rejects(adminAction(f.s,f.readonly,{op:'task.retry',id:'bad',confirm:true,reason:'重试'}),e=>e.code==='FORBIDDEN');
  await adminAction(f.s,f.reviewer,{op:'task.retry',id:'bad',confirm:true,reason:'已检查任务配置'});assert.equal((await f.store.get('outboxTasks','bad')).state,'pending');
});
