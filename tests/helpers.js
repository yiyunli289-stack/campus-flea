'use strict';
const {MemoryStore}=require('../shared/server/store');const {Service}=require('../shared/server/service');
const {hash}=require('../shared/server/core');
async function fixture(options={}) {
  let now=1800000000000;
  const provider={text:async()=>({status:'approved'}),image:async()=>({status:'approved',traceId:'trace-test'}),urls:async files=>files.map(f=>'https://files.example/'+encodeURIComponent(f)),uploadTicket:async cloudPath=>({fileID:'cloud://env/'+cloudPath}),freeze:async cloudPath=>'cloud://env/'+cloudPath,inspect:async()=>({bytes:100,image:true,hash:'image',extension:'.jpg'}),...options.provider};
  const store=new MemoryStore();const env={AUDIT_SECRET:'a'.repeat(48),ADMIN_ORIGIN:'http://localhost:5173',NODE_ENV:'test',CALLBACK_TOKEN:'callback-token-123456',...options.env};
  const s=new Service(store,provider,env,()=>now);await s.initialize(['计算机学院']);
  for(const who of ['seller','buyer','other']) await store.put('users',who,{_id:who,_openid:who,nickName:who,campus:'江安校区',contact:'contact-'+who,college:'计算机学院',avatarUrl:'',profileComplete:true,accountStatus:'normal',createdAt:now});
  const superAdmin={_id:'super-admin',role:'super',username:'super',active:true};const reviewer={_id:'reviewer',role:'reviewer'};const readonly={_id:'readonly',role:'readonly'};
  return {s,store,env,provider,superAdmin,reviewer,readonly,tick:ms=>{now+=ms;},async listing(extra={}){
    const file='cloud://env.bucket/quarantine/seller/test.jpg';await store.put('mediaFiles','media',{ownerId:'seller',state:'uploaded',fileID:file});
    return (await s.mini('goods',{action:'publish',cat:'digital',title:'测试数码',desc:'正常商品',price:100,tradeType:'竞价',condition:'几乎全新',campus:'江安校区',images:[file],...extra},'seller'))._id;
  }};
}
module.exports={fixture};
