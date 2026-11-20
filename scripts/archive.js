'use strict';
const crypto=require('node:crypto');const {context}=require('./cloud-context');const {canonical,equal,hash}=require('../shared/server/core');
async function run(){
  const {service:s}=context();const checkpoint=await s.store.get('settings','archive-checkpoint')||{sequence:0,digest:''};
  const batch=await s.store.find('auditLogs',{sequence:{$gte:checkpoint.sequence+1}},{sort:'sequence',asc:true,limit:100});
  let previous=checkpoint.digest;let sequence=checkpoint.sequence;
  for(const row of batch){const {digest,...rest}=row;const expected=crypto.createHmac('sha256',process.env.AUDIT_SECRET).update(canonical(rest)).digest('hex');if(!equal(digest,expected)||rest.previousHash!==previous||rest.sequence!==sequence+1)throw new Error('审计完整性校验失败，停止归档');previous=digest;sequence=rest.sequence;}
  if(!batch.length){console.log('没有待归档记录');return;}
  if(!process.argv.includes('--apply')){console.log(`校验通过，预览：序号 ${batch[0].sequence} 至 ${sequence}，共${batch.length}条；未写入归档。`);return;}
  if(!process.env.ARCHIVE_BUCKET||!process.env.ARCHIVE_REGION)throw new Error('须配置归档桶、地域及只写归档凭证');
  const COS=require('cos-nodejs-sdk-v5');const cos=new COS({SecretId:process.env.ARCHIVE_SECRET_ID,SecretKey:process.env.ARCHIVE_SECRET_KEY});
  const body=Buffer.from(batch.map(row=>JSON.stringify(row)).join('\n')+'\n');const key=`audit/${batch[0].sequence}-${sequence}-${hash(body.toString())}.jsonl`;
  await cos.putObject({Bucket:process.env.ARCHIVE_BUCKET,Region:process.env.ARCHIVE_REGION,Key:key,Body:body,ContentType:'application/x-ndjson'});
  await s.store.transaction(async tx=>{
    const current=await tx.get('settings','archive-checkpoint')||{sequence:0};if(current.sequence!==checkpoint.sequence)throw new Error('另一个归档任务已推进检查点，请重试');
    await tx.put('auditArchives',hash(key),{key,from:batch[0].sequence,to:sequence,count:batch.length,digest:previous,createdAt:s.now(),retainUntil:s.now()+3*366*86400000});
    await tx.put('settings','archive-checkpoint',{sequence,digest:previous});
  });
  console.log('已归档'+batch.length+'条记录；原数据库记录未删除。生产归档桶必须配置至少三年的保留策略。');
}
run().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
