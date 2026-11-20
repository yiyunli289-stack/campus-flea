'use strict';
const crypto=require('node:crypto');
const {assert,equal}=require('./core');const {imageCallback}=require('./moderation');
function signature(parts) {return crypto.createHash('sha1').update(parts.sort().join('')).digest('hex');}
function parse(body) {
  if(typeof body==='object')return body;
  if(String(body).trim().startsWith('{'))return JSON.parse(body);
  assert(!/<!DOCTYPE|<!ENTITY/i.test(body),'INVALID_CALLBACK','非法XML',400);
  const {XMLParser}=require('fast-xml-parser');return new XMLParser({ignoreAttributes:true,processEntities:false}).parse(body).xml;
}
function decrypt(encrypted,env) {
  const key=Buffer.from((env.CALLBACK_AES_KEY||'')+'=','base64');assert(key.length===32,'CONFIG_ERROR','回调AES密钥无效',503);
  const dec=crypto.createDecipheriv('aes-256-cbc',key,key.subarray(0,16));dec.setAutoPadding(false);
  const plain=Buffer.concat([dec.update(Buffer.from(encrypted,'base64')),dec.final()]);const pad=plain[plain.length-1];
  assert(pad>=1&&pad<=32&&plain.subarray(-pad).every(n=>n===pad),'INVALID_CALLBACK','填充无效',403);
  const clean=plain.subarray(0,-pad);const length=clean.readUInt32BE(16);
  assert(length<=clean.length-20 && equal(clean.subarray(20+length).toString(),env.WECHAT_APPID),'INVALID_CALLBACK','回调AppID不匹配',403);
  return clean.subarray(20,20+length).toString();
}
async function callback(s,event) {
  try {
    const q=event.queryStringParameters||{};const token=s.env.CALLBACK_TOKEN;assert(token?.length>=16,'CONFIG_ERROR','未配置回调Token',503);
    assert(Math.abs(Date.now()/1000-Number(q.timestamp))<900,'INVALID_CALLBACK','回调时间无效',403);
    if((event.httpMethod||'POST')==='GET') {
      if(q.msg_signature) {assert(equal(signature([token,q.timestamp,q.nonce,q.echostr]),q.msg_signature),'INVALID_CALLBACK','签名无效',403);return {statusCode:200,body:decrypt(q.echostr,s.env)};}
      assert(equal(signature([token,q.timestamp,q.nonce]),q.signature),'INVALID_CALLBACK','签名无效',403);
      return {statusCode:200,body:String(q.echostr||'')};
    }
    let raw=event.isBase64Encoded?Buffer.from(event.body,'base64').toString():event.body;
    assert(typeof raw==='string' && Buffer.byteLength(raw)<=65536,'INVALID_CALLBACK','回调格式无效');
    let msg=parse(raw);
    if(msg.Encrypt) {
      assert(equal(signature([token,q.timestamp,q.nonce,msg.Encrypt]),q.msg_signature),'INVALID_CALLBACK','签名无效',403);
      msg=parse(decrypt(msg.Encrypt,s.env));
    } else assert(equal(signature([token,q.timestamp,q.nonce]),q.signature),'INVALID_CALLBACK','签名无效',403);
    assert((msg.Event||msg.event)==='wxa_media_check','INVALID_CALLBACK','不支持此回调');
    const trace=String(msg.trace_id||msg.TraceId||'');assert(trace.length>0&&trace.length<200,'INVALID_CALLBACK','检测编号无效');
    const result=msg.result||{};
    await imageCallback(s,trace,result.suggest==='pass');
    return {statusCode:200,body:'success'};
  } catch(e) {return {statusCode:e.status||400,body:'callback rejected'};}
}
module.exports={callback,signature};
