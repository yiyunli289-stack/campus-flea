// 云函数：会话与消息
// 对应需求：FR-P0-CHT-01 会话、FR-P0-NOT-01 通知（成交锁定后互见联系方式）
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { action, ...params } = event || {};
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: '未登录' };

  switch (action) {
    case 'conversations': return conversations(OPENID);
    case 'open': return resolveConv(params, OPENID);
    case 'messages': return messages(params, OPENID);
    case 'send': return send(params, OPENID);
    default: return { code: -1, msg: '未知操作' };
  }
};

async function getUser(openid) {
  const r = await db.collection('users').where({ _openid: openid }).get();
  return r.data[0] || {};
}

async function conversations(openid) {
  try {
    const res = await db.collection('conversations')
      .where(_.or([{ buyerId: openid }, { sellerId: openid }]))
      .orderBy('updatedAt', 'desc').limit(100).get();

    const ids = [];
    res.data.forEach((c) => {
      if (c.buyerId && !ids.includes(c.buyerId)) ids.push(c.buyerId);
      if (c.sellerId && !ids.includes(c.sellerId)) ids.push(c.sellerId);
    });
    const users = {};
    if (ids.length) {
      const u = await db.collection('users').where({ _openid: _.in(ids) }).get();
      u.data.forEach((x) => { users[x._openid] = x; });
    }
    // 兼容历史重复会话：同一商品 + 同一买家只保留最近一条
    const seen = Object.create(null);
    const uniq = [];
    res.data.forEach((c) => {
      const key = c.goodsId + '|' + c.buyerId;
      if (seen[key]) return;
      seen[key] = true;
      uniq.push(c);
    });

    const list = uniq.map((c) => {
      const isSeller = c.sellerId === openid;
      const other = users[isSeller ? c.buyerId : c.sellerId] || {};
      return { ...c, otherName: other.nickName || '匿名', otherAvatar: other.avatarUrl || '' };
    });
    return { code: 0, data: list };
  } catch (e) {
    console.error('conversations error:', e);
    return { code: -1, msg: '加载失败' };
  }
}

async function resolveConv(params, openid) {
  try {
    const gRes = await db.collection('goods').doc(params.goodsId).get();
    const g = gRes.data;
    if (!g) return { code: -1, msg: '商品不存在' };

    const isSeller = g.sellerId === openid;
    let buyerId;
    if (isSeller) {
      if (g.status !== 'locked' && g.status !== 'sold') return { code: -1, msg: '商品尚未锁定买家' };
      if (!g.buyerId) return { code: -1, msg: '商品尚未锁定买家' };
      buyerId = g.buyerId;
    } else {
      buyerId = openid;
    }

    const exist = await db.collection('conversations')
      .where({ goodsId: g._id, sellerId: g.sellerId, buyerId }).get();
    if (exist.data.length) return { code: 0, data: exist.data[0] };

    const now = Date.now();
    // 固定 _id：连点/并发调用也只会落一条会话
    const convId = convDocId(g._id, buyerId);
    const conv = {
      _id: convId,
      _openid: openid,
      goodsId: g._id,
      goodsTitle: g.title,
      goodsCover: (g.images && g.images[0]) || '',
      sellerId: g.sellerId,
      buyerId,
      lastMsg: '',
      lastTime: now,
      unreadSeller: 0,
      unreadBuyer: 0,
      updatedAt: now
    };
    try {
      await db.collection('conversations').add({ data: conv });
    } catch (e) {
      // 并发时另一请求已按同一 _id 建好，回查复用
      const again = await db.collection('conversations')
        .where({ goodsId: g._id, sellerId: g.sellerId, buyerId }).get();
      if (again.data.length) return { code: 0, data: again.data[0] };
      throw e;
    }
    return { code: 0, data: conv };
  } catch (e) {
    console.error('resolveConv error:', e);
    return { code: -1, msg: '发起会话失败' };
  }
}

async function messages(params, openid) {
  try {
    const cRes = await db.collection('conversations').doc(params.conversationId).get();
    const conv = cRes.data;
    if (!conv || (conv.buyerId !== openid && conv.sellerId !== openid)) return { code: -1, msg: '无权查看' };

    const isSeller = conv.sellerId === openid;
    const otherId = isSeller ? conv.buyerId : conv.sellerId;
    const other = await getUser(otherId);

    const mRes = await db.collection('messages').where({ conversationId: conv._id }).orderBy('createdAt', 'asc').limit(200).get();

    // 标记已读
    const unreadField = isSeller ? 'unreadSeller' : 'unreadBuyer';
    await db.collection('conversations').doc(conv._id).update({ data: { [unreadField]: 0 } });

    // 成交锁定后才暴露对方联系方式
    let contact = '';
    try {
      const g = await db.collection('goods').doc(conv.goodsId).get();
      if (g.data && (g.data.status === 'locked' || g.data.status === 'sold')) contact = other.contact || '';
    } catch (e) { /* ignore */ }

    return { code: 0, data: { messages: mRes.data, other: { nickName: other.nickName, avatarUrl: other.avatarUrl, contact } } };
  } catch (e) {
    console.error('messages error:', e);
    return { code: -1, msg: '加载失败' };
  }
}

// 会话固定 _id：商品 + 买家 决定，保证幂等
function convDocId(goodsId, buyerId) {
  return 'c' + crypto.createHash('md5').update(goodsId + '_' + buyerId).digest('hex');
}

async function send(params, openid) {
  try {
    const cRes = await db.collection('conversations').doc(params.conversationId).get();
    const conv = cRes.data;
    if (!conv || (conv.buyerId !== openid && conv.sellerId !== openid)) return { code: -1, msg: '无权操作' };

    const isSeller = conv.sellerId === openid;
    const toId = isSeller ? conv.buyerId : conv.sellerId;
    const now = Date.now();
    await db.collection('messages').add({ data: { _openid: openid, conversationId: conv._id, fromId: openid, toId, content: params.content, createdAt: now } });

    const unreadField = isSeller ? 'unreadBuyer' : 'unreadSeller';
    await db.collection('conversations').doc(conv._id).update({
      data: { lastMsg: params.content, lastTime: now, updatedAt: now, [unreadField]: _.inc(1) }
    });
    return { code: 0, data: { _id: conv._id } };
  } catch (e) {
    console.error('send error:', e);
    return { code: -1, msg: '发送失败' };
  }
}
