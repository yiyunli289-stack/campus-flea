'use strict';
// Local development only: never selects a cloud environment or writes production data.
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {MemoryStore}=require('../shared/server/store');const {Service}=require('../shared/server/service');
const {createServer}=require('./cloud-admin');
async function start(){
  if(process.env.NODE_ENV==='production')throw new Error('本地模拟服务禁止用于生产');
  const localRoot=path.resolve(__dirname,'../.local');
  const dir=path.resolve(localRoot,process.env.LOCAL_DATA_DIR||'.');if(dir!==localRoot&&!dir.startsWith(localRoot+path.sep))throw new Error('本地数据目录须位于 .local 内');
  fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'database.json');
  const secretFile=path.join(dir,'audit.key');if(!fs.existsSync(secretFile))fs.writeFileSync(secretFile,crypto.randomBytes(48).toString('hex'),{mode:0o600});
  const env={...process.env,NODE_ENV:'development',ADMIN_ORIGIN:process.env.ADMIN_ORIGIN||'http://127.0.0.1:5173',AUDIT_SECRET:fs.readFileSync(secretFile,'utf8')};
  const store=new MemoryStore(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{},async data=>{fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);});
  const provider={text:async()=>({status:'review',reason:'本地环境：等待人工复核，未调用微信检测'}),image:async()=>({status:'review'}),urls:async files=>files,inspect:async()=>{throw new Error('本地环境不接收云文件');}};
  const s=new Service(store,provider,env);await s.initialize(require('../miniprogram/utils/colleges').ALL_COLLEGES);
  if(!await store.get('systemLocks','bootstrap')){
    if(!process.env.ADMIN_BOOTSTRAP_PASSWORD)throw new Error('首次启动请通过 ADMIN_BOOTSTRAP_PASSWORD 提供至少12位初始密码；账号默认为 admin');
    await s.auth.createAccount(null,{username:process.env.ADMIN_BOOTSTRAP_USERNAME||'admin',password:process.env.ADMIN_BOOTSTRAP_PASSWORD,role:'super'},true);
  }
  const server=createServer(s);
  const port=Number(process.env.PORT ?? 8787);
  server.listen(port,'127.0.0.1',()=>{
    const origin='http://127.0.0.1:'+server.address().port;
    if (port===0) s.env.ADMIN_ORIGIN=origin;
    console.log('本地管理API '+origin+'；数据仅保存在 .local/');
  });
}
start().catch(e=>{console.error(e.message);process.exitCode=1;});
