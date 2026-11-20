'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {fixture}=require('./helpers');
const {adminHttp}=require('../shared/server/http');const {adminAction,adminList}=require('../shared/server/governance');
const {hash}=require('../shared/server/core');
test('独立管理员：哈希密码、HttpOnly会话、CSRF、来源与退出',async()=>{
  const {s,store}=await fixture();await s.auth.createAccount(null,{username:'root-admin',password:'correct-password-123',role:'super'},true);
  const account=await store.get('adminUsers',hash('root-admin'));assert(!account.passwordHash.includes('correct-password'));
  const req=(path,body,headers={})=>adminHttp(s,{path:'/api/admin'+path,httpMethod:body===undefined?'GET':'POST',headers,body:body===undefined?'':JSON.stringify(body),requestContext:{sourceIp:'127.0.0.1'}});
  assert.equal((await req('/dashboard')).statusCode,401);
  assert.equal((await req('/login',{username:'root-admin',password:'wrong'})).statusCode,401);
  const login=await req('/login',{username:'root-admin',password:'correct-password-123'});assert.equal(login.statusCode,200);assert(login.headers['Set-Cookie'].includes('HttpOnly'));
  const data=JSON.parse(login.body).data;const cookie=login.headers['Set-Cookie'].split(';')[0];
  assert.equal((await req('/dashboard',undefined,{cookie})).statusCode,200);
  assert.equal((await req('/action',{op:'config.publish'},{cookie})).statusCode,403);
  assert.equal((await req('/dashboard',undefined,{cookie,origin:'https://evil.example'})).statusCode,403);
  assert.equal((await req('/logout',{}, {cookie,'x-csrf-token':data.csrf})).statusCode,200);
  assert.equal((await req('/dashboard',undefined,{cookie})).statusCode,401);
});
test('角色接口权限与查询审计：只读不能读证据、改配置或封禁',async()=>{
  const {s,readonly,reviewer}=await fixture();
  for(const actor of [readonly,reviewer]) await assert.rejects(adminAction(s,actor,{op:'config.save',content:{}}),e=>e.code==='FORBIDDEN');
  await assert.rejects(adminAction(s,readonly,{op:'govern',confirm:true,reason:'核查',targetType:'users',targetId:'seller',action:'ban'}),e=>e.code==='FORBIDDEN');
  const {evidence}=require('../shared/server/governance');await assert.rejects(evidence(s,readonly,{entity:'users',id:'seller',reason:'查看'}),e=>e.code==='FORBIDDEN');
  await adminList(s,readonly,{entity:'users'});const logs=await s.store.find('auditLogs',{action:'query.users'});assert.equal(logs.length,1);
});
test('最后一个超级管理员受保护，改密和停用撤销原会话',async()=>{
  const {s}=await fixture();const a=await s.auth.createAccount(null,{username:'root-admin',password:'correct-password-123',role:'super'},true);
  const actor={...a};const login=await s.auth.login({username:a.username,password:'correct-password-123'},'test');
  await assert.rejects(s.auth.updateAccount(actor,{id:a._id,active:false}),e=>e.code==='LAST_SUPER');
  await s.auth.updateAccount(actor,{id:a._id,currentPassword:'correct-password-123',password:'updated-password-456'});
  await assert.rejects(s.auth.session(login.token,login.csrf),e=>e.code==='UNAUTHENTICATED');
});
test('管理员bootstrap幂等竞争与会话闲置超时',async()=>{
  const {s,tick}=await fixture();
  const result=await Promise.allSettled(['root-one','root-two'].map(username=>s.auth.createAccount(null,{username,password:'correct-password-123',role:'super'},true)));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  const account=result.find(r=>r.status==='fulfilled').value;const session=await s.auth.login({username:account.username,password:'correct-password-123'},'ip');tick(31*60000);
  await assert.rejects(s.auth.session(session.token,session.csrf),e=>e.code==='UNAUTHENTICATED');
});
