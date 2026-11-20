'use strict';
const crypto=require('node:crypto');
const {Service}=require('./service');const {CloudStore}=require('./store');
const {adminHttp}=require('./http');const {assert,hash}=require('./core');const {runWorker}=require('./worker');
let cached;
function createRuntime() {
  if(cached)return cached;
  const cloud=require('wx-server-sdk');cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
  const sdk=require('@cloudbase/node-sdk');const app=sdk.init({env:process.env.TCB_ENV||sdk.SYMBOL_CURRENT_ENV,throwOnCode:true});
  const store=new CloudStore(app.database());
  const provider={
    async text({content,openid,scene}) {
      if(!content.trim())return {status:'approved'};
      const r=await cloud.openapi.security.msgSecCheck({version:2,openid,scene,content});
      const suggestion=r.result?.suggest;
      return {status:suggestion==='pass'?'approved':suggestion==='risky'?'rejected':'review',reason:suggestion==='risky'?'内容安全检测未通过':''};
    },
    async image({fileID,openid}) {
      const url=(await provider.urls([fileID]))[0];
      const r=await cloud.openapi.security.mediaCheckAsync({version:2,openid,scene:1,mediaType:2,mediaUrl:url});
      const traceId=r.traceId||r.trace_id;assert(traceId,'DETECTION_UNAVAILABLE','图片检测未返回任务编号',503);
      return {traceId,status:'pending'};
    },
    async urls(files) {
      const cloudFiles=files.filter(f=>f.startsWith('cloud://'));if(!cloudFiles.length)return files;
      const r=await cloud.getTempFileURL({fileList:cloudFiles});const map=new Map(r.fileList.map(f=>[f.fileID,f.tempFileURL]));
      return files.map(f=>{const url=map.get(f)||(!f.startsWith('cloud://')?f:'');assert(url,'FILE_UNAVAILABLE','图片暂不可用',503);return url;});
    },
    async inspect(fileID) {
      const r=await cloud.downloadFile({fileID});const b=r.fileContent;
      return {bytes:b.length,hash:hash(b.toString('base64')),image:(b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)||b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))};
    }
  };
  const service=new Service(store,provider,process.env);
  cached={service,cloud};return cached;
}
function entry(name) {
  return async event=>{
    const {service:s,cloud}=createRuntime();
    if(name==='admin')return adminHttp(s,event);
    if(name==='governance-worker') {
      // Worker invocations from client SDKs have an OPENID and must never run jobs.
      assert(!cloud.getWXContext().OPENID && process.env.TCB_SOURCE==='timer' && event?.Type==='Timer','FORBIDDEN','只允许平台定时触发任务',403);
      return runWorker(s,20);
    }
    if(name==='safety-callback')return require('./wechat-callback').callback(s,event);
    try {
      const data=await s.mini(name,event||{},cloud.getWXContext().OPENID);
      // Fast-path this message only; never make a public search drain unrelated bulk jobs.
      if(name==='chat' && event?.action==='send' && data.moderationStatus==='approved') {
        await require('./worker').processTask(s,{kind:'message-visible',data:{messageId:data._id}}).catch(e=>console.error('message delivery deferred',e.code||'INTERNAL_ERROR'));
      }
      return {code:0,data};
    } catch(e) {return {code:e.code||'INTERNAL_ERROR',msg:e.status>=500||!e.code?'服务暂时不可用':e.message};}
  };
}
module.exports={createRuntime,entry};
