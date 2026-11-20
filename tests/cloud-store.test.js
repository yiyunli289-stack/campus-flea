'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {CloudStore}=require('../shared/server/store');
test('CloudBase Node SDK 4适配：直接传文档，不写入错误data外壳',async()=>{
  let saved;const db={collection:()=>({doc:()=>({set:async value=>{saved=value;return {updated:1};},get:async()=>({data:[{_id:'x',value:2}]})})})};
  const store=new CloudStore(db);await store.put('goods','x',{_id:'x',value:2});assert.deepEqual(saved,{value:2});assert.equal((await store.get('goods','x')).value,2);
});
test('SDK以返回值报告权限或集合错误时必须抛错，不能当成成功/不存在',async()=>{
  const db={collection:()=>({doc:()=>({get:async()=>({code:'PERMISSION_DENIED',message:'denied'}),set:async()=>({code:'DATABASE_COLLECTION_NOT_EXIST'})})})};
  const store=new CloudStore(db);await assert.rejects(store.get('x','y'),e=>e.code==='PERMISSION_DENIED');await assert.rejects(store.put('x','y',{}),e=>e.code==='DATABASE_COLLECTION_NOT_EXIST');
});
test('云库没有初始化文档时允许首次启动',async()=>{
  const db={collection:()=>({doc:()=>({get:async()=>{throw Error('Document not found');}})})};
  assert.equal(await new CloudStore(db).get('systemLocks','bootstrap'),null);
});
