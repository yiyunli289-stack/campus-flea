// 云函数：报价/购买意向（创建、收到的、我发出的、卖家择一锁定、取消）
// 对应需求：FR-P0-OFF-01 买家出价/购买意向、FR-P0-SEL-03 卖家择一 + 锁定状态机
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { action, ...params } = event || {};
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: '未登录' };

  switch (action) {
    case 'create': return create(params, OPENID);
    case 'received': return list(params, OPENID, 'sellerId');
    case 'sent': return list(params, OPENID, 'buyerId');
    case 'accept': return accept(params, OPENID);
    case 'cancel': return cancel(params, OPENID);
    default: return { code: -1, msg: '未知操作' };
  }
};

async function create(params, openid) {
  try {
    const gRes = await db.collection('goods').doc(params.goodsId).get();
    const g = gRes.data;
    if (!g) return { code: -1, msg: '商品不存在' };
    if (g.status !== 'on') return { code: -1, msg: '商品已不在售' };
    if (g.sellerId === openid) return { code: -1, msg: '不能报价自己的商品' };

    const dup = await db.collection('offers').where({ goodsId: g._id, buyerId: openid, status: 'pending' }).get();
    if (dup.data.length) return { code: -1, msg: '你已报过价，等待卖家处理' };

    const now = Date.now();
    const offer = {
      _openid: openid,
      goodsId: g._id,
      goodsTitle: g.title,
      goodsCover: (g.images && g.images[0]) || '',
      sellerId: g.sellerId,
      buyerId: openid,
      price: Number(params.price) || 0,
      message: params.message || '',
      status: 'pending',
      createdAt: now
    };
    const addRes = await db.collection('offers').add({ data: offer });
    return { code: 0, data: { _id: addRes._id } };
  } catch (e) {
    console.error('offer.create error:', e);
    return { code: -1, msg: '提交失败：' + e.message };
  }
}

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
  if (ids.length) {
    const u = await db.collection('users').where({ _openid: _.in(ids) }).get();
    u.data.forEach((x) => { users[x._openid] = x; });
  }
  return offers.map((o) => {
    const buyer = users[o.buyerId] || {};
    const seller = users[o.sellerId] || {};
    const locked = o.status === 'accepted'; // 成交锁定后互相可见联系方式
    return {
      ...o,
      buyerName: buyer.nickName || '匿名',
      buyerCollege: buyer.college || '',
      buyerContact: locked ? (buyer.contact || '') : '',
      sellerName: seller.nickName || '匿名',
      sellerCollege: seller.college || '',
      sellerContact: locked ? (seller.contact || '') : ''
    };
  });
}

async function accept(params, openid) {
  try {
    const oRes = await db.collection('offers').doc(params.offerId).get();
    const o = oRes.data;
    if (!o) return { code: -1, msg: '报价不存在' };
    if (o.sellerId !== openid) return { code: -1, msg: '无权操作' };
    if (o.status !== 'pending') return { code: -1, msg: '该报价已处理' };

    const gRes = await db.collection('goods').doc(o.goodsId).get();
    const g = gRes.data;
    if (!g || g.status !== 'on') return { code: -1, msg: '商品已不在售' };

    const now = Date.now();
    // 卖家择一：接受该报价、拒绝该商品其余待处理报价、锁定商品
    await db.collection('offers').doc(o._id).update({ data: { status: 'accepted' } });
    await db.collection('offers').where({ goodsId: o.goodsId, status: 'pending' }).update({ data: { status: 'rejected' } });
    await db.collection('goods').doc(o.goodsId).update({ data: { status: 'locked', buyerId: o.buyerId, dealPrice: o.price, updatedAt: now } });

    // 自动建立/更新会话，通知买家
    const exist = await db.collection('conversations').where({ goodsId: o.goodsId, sellerId: openid, buyerId: o.buyerId }).get();
    const sysMsg = '交易已锁定，成交价 ¥' + o.price + '，请线下联系完成面交';
    if (exist.data.length) {
      const cid = exist.data[0]._id;
      await db.collection('conversations').doc(cid).update({ data: { lastMsg: sysMsg, lastTime: now, updatedAt: now, unreadBuyer: _.inc(1) } });
      await db.collection('messages').add({ data: { _openid: openid, conversationId: cid, fromId: 'system', toId: o.buyerId, content: sysMsg, createdAt: now } });
    } else {
      const conv = { _openid: openid, goodsId: o.goodsId, goodsTitle: o.goodsTitle, goodsCover: o.goodsCover, sellerId: openid, buyerId: o.buyerId, lastMsg: sysMsg, lastTime: now, unreadSeller: 0, unreadBuyer: 1, updatedAt: now };
      const addRes = await db.collection('conversations').add({ data: conv });
      await db.collection('messages').add({ data: { _openid: openid, conversationId: addRes._id, fromId: 'system', toId: o.buyerId, content: sysMsg, createdAt: now } });
    }
    return { code: 0, data: { status: 'accepted' } };
  } catch (e) {
    console.error('offer.accept error:', e);
    return { code: -1, msg: '操作失败：' + e.message };
  }
}

async function cancel(params, openid) {
  try {
    const oRes = await db.collection('offers').doc(params.offerId).get();
    const o = oRes.data;
    if (!o || o.buyerId !== openid) return { code: -1, msg: '无权操作' };
    if (o.status !== 'pending') return { code: -1, msg: '报价已处理，无法取消' };
    await db.collection('offers').doc(o._id).update({ data: { status: 'cancelled' } });
    return { code: 0, data: { status: 'cancelled' } };
  } catch (e) {
    return { code: -1, msg: '操作失败' };
  }
}
