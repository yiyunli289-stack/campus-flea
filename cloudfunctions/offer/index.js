// 云函数：报价/购买意向（创建、收到的、我发出的、卖家择一锁定、取消）
// 对应需求：FR-P0-OFF-01 买家出价/购买意向、FR-P0-SEL-03 卖家择一 + 锁定状态机
const cloud = require('wx-server-sdk');
const {failure, due, invalidListing, cycle, hour} = require('./lib/core');
const {submitOffer, changeOffer} = require('./lib/trade');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({throwOnNotFound:false});
const _ = db.command;

exports.main = async (event) => {
  const { action, ...params } = event || {};
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: '未登录' };

  try {
    switch (action) {
      case 'create':
      case 'update': return await submitOffer(db,{action,...params},OPENID,Date.now());
      case 'accept':
      case 'cancel':
      case 'decline':
      case 'cancelLock':
      case 'restoreListing':
      case 'confirmMeetup': return await changeOffer(db,{action,...params},OPENID,Date.now());
      case 'received': return await list(params,OPENID,'sellerId');
      case 'sent': return await list(params,OPENID,'buyerId');
      default: return {code:-1,msg:'未知操作'};
    }
  } catch(error) { return failure(error,'购买申请操作失败'); }
};

async function list(params, openid, field) {
  try {
    const where = {};
    where[field] = openid;
    if (params.goodsId) where.goodsId = params.goodsId;
    const res = await db.collection('offers').where(where).orderBy('createdAt', 'desc').limit(200).get();
    const data = await enrich(res.data);
    return { code: 0, data };
  } catch (e) {
    console.error('offer.list error:', e);
    return { code: -1, msg: '加载失败' };
  }
}

async function enrich(offers) {
  const ids = [];
  offers.forEach((o) => {
    if (o.buyerId && !ids.includes(o.buyerId)) ids.push(o.buyerId);
    if (o.sellerId && !ids.includes(o.sellerId)) ids.push(o.sellerId);
  });
  const users = {};
  for (let i = 0; i < ids.length; i += 50) {
    const u = await db.collection('users').where({ _openid: _.in(ids.slice(i,i+50)) }).limit(50).get();
    u.data.forEach((x) => { users[x._openid] = x; });
  }
  const goodsIds = [...new Set(offers.map(o=>o.goodsId))];
  const goods = new Map();
  for (let i = 0; i < goodsIds.length; i += 50) {
    const rows = await db.collection('goods').where({_id:_.in(goodsIds.slice(i,i+50))}).limit(50).get();
    for (const row of rows.data) goods.set(row._id,row);
  }
  const now = Date.now();
  return offers.map(o => {
    const buyer = users[o.buyerId] || {};
    const seller = users[o.sellerId] || {};
    const g = goods.get(o.goodsId);
    let status = o.status;
    if (status === 'pending') {
      if (invalidListing(g) || cycle(g) !== (o.listingCycle || '')) status = 'closed';
      else if (g.status === 'locked') status = 'rejected';
      else if (g.status !== 'on') status = 'closed';
      else if (due(o) <= now) status = 'expired';
    }
    const locked = status === 'accepted' && !invalidListing(g) && g.status === 'locked' &&
      g.buyerId === o.buyerId && (!g.acceptedOfferId || g.acceptedOfferId === o._id);
    if (status === 'accepted' && !locked) {
      status = g?.status === 'sold' && g.buyerId === o.buyerId ? 'completed' : 'closed';
    }
    return {...o,status,tradeType:o.tradeType || g?.tradeType,canTrade:locked,
      canRestore:locked && !g.meetupConfirmedAt && now >= Number(g.lockedAt || o.acceptedAt || g.updatedAt) + 48 * hour,
      buyerName:buyer.nickName || '匿名',buyerCollege:buyer.college || '',
      buyerContact:locked ? buyer.contact || '' : '',sellerName:seller.nickName || '匿名',
      sellerCollege:seller.college || '',sellerContact:locked ? seller.contact || '' : ''};
  });
}
