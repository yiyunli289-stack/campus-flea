'use strict';
const {context}=require('./cloud-context');const {id,hash}=require('../shared/server/core');
async function run(){
  const {service:s}=context();const apply=process.argv.includes('--apply');const counts={};
  for(const table of ['users','goods','offers','messages','reports','conversations']){
    let skip=0;let list;
    do{
      list=await s.store.find(table,{}, {limit:100,skip,sort:'_id',asc:true});skip+=list.length;
      for(const old of list){
        if(old.governanceMigration===1)continue;counts[table]=(counts[table]||0)+1;
        if(!apply)continue;
        await s.store.transaction(async tx=>{
          const d=await tx.get(table,old._id);if(d.governanceMigration===1)return;
          const next={...d,governanceMigration:1};
          if(table==='users') {next.accountStatus=d.accountStatus||'normal';next.pendingProfile={nickName:d.nickName||'',avatarUrl:d.avatarUrl||'',campus:d.campus||'',contact:d.contact||'',college:d.college||'',major:d.major||''};}
          if(['goods','offers','messages','users'].includes(table)){
            next.moderationStatus='review';next.contentVersion=d.contentVersion||id();
            if(table==='goods')next.enforcement=d.enforcement||'normal';
            const taskId=hash('legacy:'+table+':'+d._id);
            next.moderationTaskId=taskId;
            const ownerId=table==='users'?d._openid:d.sellerId||d.buyerId||d.fromId;
            await tx.put('moderationTasks',taskId,{targetType:table,targetId:d._id,ownerId,version:next.contentVersion,status:'review',textStatus:'review',media:[],reason:'历史内容未经安全检测，请人工复核',createdAt:s.now()});
            await tx.put('moderationCases',taskId,{taskId,targetType:table,targetId:d._id,ownerId,version:next.contentVersion,state:'pending',createdAt:s.now()});
          }
          if(table==='messages')next.deliveryState='delivered';
          if(table==='conversations')Object.assign(next,{lastMsg:'',state:d.state||'open'});
          if(table==='reports')Object.assign(next,{targetType:d.targetType||'goods',targetId:d.targetId||d.goodsId,state:d.state||d.status||'pending',kind:'report',version:1,snapshot:d.snapshot||{title:d.goodsTitle||''}});
          if(table==='offers'&&d.status==='pending'){
            const pair=hash(d.buyerId+':'+d.goodsId);const lock=await tx.get('offerKeys',pair);
            if(!lock)await tx.put('offerKeys',pair,{offerId:d._id});else if(lock.offerId!==d._id)next.status='closed';
          }
          await tx.put(table,d._id,next);await s.audit(tx,{_id:'migration',role:'system'},'migration.governance',d._id,null,{table,version:1});
        });
      }
    }while(list.length===100);
  }
  console.log(JSON.stringify({mode:apply?'已执行':'只读预览',counts},null,2));
}
run().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
