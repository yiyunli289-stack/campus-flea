'use strict';
const { context } = require('./cloud-context');
const { hash } = require('../shared/server/core');
const trade = require('../shared/server/trade-state');
const { queueGoods } = require('../shared/server/moderation');

const version = 2;
const tables = ['users','goods','offers','messages','reports','conversations'];

function normalize(table, d, now) {
  const next = {...d,governanceMigration:version};
  for (const k of ['createdAt','updatedAt','acceptedAt','soldAt']) {
    if (d[k] && typeof d[k] !== 'number') next[k] = trade.time(d[k]) || now;
  }
  if (table === 'users') next.accountStatus ||= 'normal';
  if (table === 'goods' && d.moderationStatus === 'rejected') next.enforcement = 'removed';
  if (table === 'offers' && !d.expiresAt) next.expiresAt = trade.offerExpiry(next);
  if (table === 'reports') {
    Object.assign(next,{targetType:d.targetType || 'goods',targetId:d.targetId || d.goodsId || '',
      state:d.state || d.status || 'pending',kind:d.kind || 'report',version:d.version || 1,
      snapshot:d.snapshot || {title:d.goodsTitle || ''}});
  }
  if (table === 'conversations') next.state ||= 'open';
  return next;
}

async function migrate(s, {apply = false} = {}) {
  const counts = { scans:{}, goodsQueued:0, historyReviewed:0, legacyBans:0 };
  for (const table of tables) {
    let cursor = '';
    for (;;) {
      const source = await s.store.find(table,cursor ? {_id:{$gt:cursor}} : {},{limit:50,sort:'_id',asc:true});
      for (const row of source) {
        if (row.governanceMigration >= version) continue;
        counts.scans[table] = (counts.scans[table] || 0) + 1;
        const queue = table === 'goods' && row.status === 'on' && row.enforcement !== 'removed' &&
          !['approved','rejected'].includes(row.moderationStatus) && !row.moderationTaskId;
        const mediaReview = ['users','offers','messages'].includes(table) && !row.moderationStatus &&
          !row.moderationTaskId && row.accountStatus !== 'deleted';
        const legacyBan = table === 'users' && row.accountStatus === 'banned' && !row.accessEpoch;
        if (queue) counts.goodsQueued++;
        if (mediaReview) counts.historyReviewed++;
        if (legacyBan) counts.legacyBans++;
        if (!apply) continue;
        await s.store.transaction(async tx => {
          const current = await tx.get(table,row._id);
          if (!current || current.governanceMigration >= version) return;
          const next = normalize(table,current,s.now());
          if (legacyBan && current.accountStatus === 'banned' && !current.accessEpoch) {
            const key = hash('legacy-ban-v2:'+current._id);
            next.accessEpoch = key;
            await s.enqueue(tx,'user-ban',key,{openid:current._openid,previousEpoch:''});
          }
          if (queue && current.status === 'on' && current.enforcement !== 'removed' && !current.moderationTaskId &&
              !['approved','rejected'].includes(current.moderationStatus)) {
            const key = hash('legacy-goods-v2:'+current._id);
            next.enforcement ||= 'normal';
            next.contentVersion ||= key;
            next.moderationStatus = 'review';
            next.moderationTaskId = key;
            await queueGoods(s,tx,next);
          } else {
            if (mediaReview && !current.moderationStatus && !current.moderationTaskId && current.accountStatus !== 'deleted') {
              const key = hash('legacy-review-v2:'+table+':'+current._id);
              next.contentVersion ||= key;
              next.moderationStatus = 'review';
              if (['messages','offers'].includes(table)) next.historyVisible = true;
              next.moderationTaskId = key;
              const task = {targetType:table,targetId:current._id,ownerId:current._openid || current.buyerId || current.fromId || '',
                version:next.contentVersion,status:'review',textStatus:'review',media:[],reason:'历史内容待复核',createdAt:s.now()};
              await tx.put('moderationTasks',key,task);
              await tx.put('moderationCases',key,{...task,taskId:key,state:'pending'});
            }
            if (table === 'messages' && !next.deliveryState) next.deliveryState = 'delivered';
            if (table === 'offers' && next.status === 'pending') {
              const key = hash(next.buyerId+':'+next.goodsId);
              const lock = await tx.get('offerKeys',key);
              if (!lock) await tx.put('offerKeys',key,{offerId:next._id});
              else if (lock.offerId !== next._id) {
                const previous = await tx.get('offers',lock.offerId);
                if (!previous || previous.status !== 'pending' || trade.offerExpiry(previous) <= s.now()) {
                  await tx.put('offerKeys',key,{offerId:next._id});
                } else {
                  next.status = 'closed';
                  next.closedReason = 'duplicate';
                }
              }
            }
            await tx.put(table,row._id,next);
          }
          await s.audit(tx,{_id:'migration',role:'system'},'migration.governance',row._id,null,{table,version});
        });
      }
      if (source.length < 50) break;
      cursor = source.at(-1)._id;
    }
  }
  return counts;
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  Promise.resolve().then(() => migrate(context().service,{apply}))
    .then(counts => console.log(JSON.stringify({mode:apply?'已执行':'只读预览',counts},null,2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { migrate };
