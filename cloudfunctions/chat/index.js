// 云函数：会话与消息
// 对应需求：FR-P0-CHT-01 会话、FR-P0-NOT-01 通知（成交锁定后互见联系方式）
const cloud = require('wx-server-sdk');
const {failure, get, isParticipant, update} = require('./lib/core');
const {chatOpen, chatSend} = require('./lib/trade');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({throwOnNotFound:false});
const _ = db.command;

exports.main = async (event) => {
  const { action, ...params } = event || {};
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: '未登录' };

  try {
    switch (action) {
      case 'conversations': return await conversations(OPENID);
      case 'open': return await chatOpen(db,params,OPENID,Date.now());
      case 'messages': return await messages(params,OPENID);
      case 'send': return await chatSend(db,params,OPENID,Date.now());
      default: return {code:-1,msg:'未知操作'};
    }
  } catch(error) { return failure(error,'会话操作失败'); }
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

async function messages(params, openid) {
  const conv = await get(db,'conversations',params.conversationId);
  if (!isParticipant(conv,openid)) return {code:-1,msg:'无权查看'};
  const seller = conv.sellerId === openid;
  const other = await getUser(seller?conv.buyerId:conv.sellerId);
  const page = await db.collection('messages').where({conversationId:conv._id})
    .orderBy('createdAt','desc').limit(200).get();
  const unread = seller ? 'unreadSeller' : 'unreadBuyer';
  await db.runTransaction(async tx => {
    const current = await get(tx,'conversations',conv._id);
    if (isParticipant(current,openid) && current.lastMessageId === conv.lastMessageId &&
        current.lastTime === conv.lastTime && current[unread]) {
      await update(tx,'conversations',conv._id,{[unread]:0});
    }
  });
  const g = await get(db,'goods',conv.goodsId);
  const contact = g?.status === 'locked' && g.buyerId === conv.buyerId ? other.contact || '' : '';
  const canSend = !!g && g.enforcement !== 'removed' && g.moderationStatus !== 'rejected' &&
    (g.status === 'on' || g.status === 'locked' && g.buyerId === conv.buyerId);
  return {code:0,data:{messages:page.data.reverse(),other:{nickName:other.nickName || '校园用户',
    avatarUrl:other.avatarUrl || '',contact},canSend,offerContext:{goodsId:conv.goodsId,tab:seller?'received':'sent'}}};
}
