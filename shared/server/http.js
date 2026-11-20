'use strict';
const crypto=require('node:crypto');
const {assert,id,hash,publicAdmin,permit}=require('./core');
const {adminList,evidence,adminAction}=require('./governance');
const {reportStateFilter}=require('./service');
function cookie(token,env,clear=false) {return 'campus_admin='+ (clear?'':token)+'; Path=/api/admin; HttpOnly; SameSite=Strict; '+(env.NODE_ENV==='production'?'Secure; ':'')+'Max-Age='+(clear?0:28800);}
async function adminHttp(s,event) {
  const requestId=id();const headers=Object.fromEntries(Object.entries(event.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));
  const responseHeaders={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','X-Request-ID':requestId};
  try {
    const method=(event.httpMethod||event.method||'GET').toUpperCase();
    assert(['GET','POST','OPTIONS'].includes(method),'METHOD_NOT_ALLOWED','请求方法不允许',405);
    const allowed=s.env.ADMIN_ORIGIN;
    assert(allowed,'CONFIG_ERROR','未配置 ADMIN_ORIGIN',503);
    if(headers.origin) {
      assert(headers.origin===allowed,'ORIGIN_REJECTED','来源不允许',403);
      Object.assign(responseHeaders,{'Access-Control-Allow-Origin':allowed,'Access-Control-Allow-Credentials':'true','Vary':'Origin','Access-Control-Allow-Headers':'Content-Type, X-CSRF-Token','Access-Control-Allow-Methods':'GET, POST, OPTIONS'});
    }
    if(method==='OPTIONS') return {statusCode:204,headers:responseHeaders,body:''};
    const url=new URL(event.path||event.rawPath||'/',allowed);const route=url.pathname.replace(/^\/api\/admin/,'')||'/';
    const query={...Object.fromEntries(url.searchParams),...(event.queryStringParameters||{})};
    const raw=event.isBase64Encoded?Buffer.from(event.body||'','base64').toString('utf8'):event.body||'';
    assert(typeof raw==='string' && Buffer.byteLength(raw)<=128*1024,'INVALID_INPUT','请求体过大');
    const body=raw?JSON.parse(raw):{};
    assert(body && typeof body==='object' && !Array.isArray(body),'INVALID_INPUT','请求格式无效');
    const token=String(headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('campus_admin='))?.slice(13)||'';
    let data;
    if(route==='/login' && method==='POST') {
      // Only use the ingress-provided IP, never arbitrary X-Forwarded-For from clients.
      const ip=event.requestContext?.sourceIp||event.requestContext?.identity?.sourceIp||'unknown';
      const login=await s.auth.login(body,ip);responseHeaders['Set-Cookie']=cookie(login.token,s.env);data={admin:login.admin,csrf:login.csrf};
    } else {
      const actor=await s.auth.session(token,headers['x-csrf-token'],method==='POST');
      if(route==='/session' && method==='GET') {
        const csrf=crypto.randomBytes(24).toString('base64url');
        await s.store.transaction(async tx=>{const current=await tx.get('adminSessions',hash(token));await tx.put('adminSessions',hash(token),{...current,csrfHash:hash(csrf)});});
        data={admin:publicAdmin(actor),csrf};
      } else if(route==='/logout' && method==='POST') {await s.auth.logout(actor,token);responseHeaders['Set-Cookie']=cookie('',s.env,true);data={loggedOut:true};}
      else if(route==='/list' && method==='GET') data=await adminList(s,actor,query);
      else if(route==='/evidence' && method==='GET') data=await evidence(s,actor,query);
      else if(route==='/booklists' && method==='GET') data=await require('./booklists').adminList(s,actor,query);
      else if(route==='/statistics' && method==='GET') data=await require('./statistics').adminStatistics(s,actor,query);
      else if(route==='/settings' && method==='GET') {
        permit(actor,'configure');const key=query.kind==='rules'?'rules':'public';data=await s.setting(key);
        await s.store.transaction(tx=>s.audit(tx,actor,'query.settings',key,null,{version:data.version}));
      } else if(route==='/dashboard' && method==='GET') {
        permit(actor,'read');data={moderation:await s.store.count('moderationCases',{state:'pending'}),reports:await s.store.count('reports',reportStateFilter('pending')),risks:await s.store.count('riskEvents',{state:'pending'}),failedTasks:await s.store.count('outboxTasks',{state:'failed'})};
        await s.store.transaction(tx=>s.audit(tx,actor,'query.dashboard','dashboard',null,data));
      } else if(route==='/action' && method==='POST') data=await adminAction(s,actor,body);
      else assert(false,'NOT_FOUND','接口不存在',404);
    }
    return {statusCode:200,headers:responseHeaders,body:JSON.stringify({code:0,data,requestId})};
  } catch(e) {
    const status=e.status|| (e instanceof SyntaxError?400:500);
    return {statusCode:status,headers:responseHeaders,body:JSON.stringify({code:e.code||'INTERNAL_ERROR',msg:status>=500?'服务暂时不可用，请联系管理员':e.message,requestId})};
  }
}
module.exports={adminHttp};
