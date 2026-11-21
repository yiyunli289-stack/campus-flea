'use strict';

const {createHash, randomBytes} = require('node:crypto');

const hour = 3600000;
const events = {
  'chat.consult': ['chat','新咨询','有买家发起了商品咨询'],
  'chat.message': ['chat','新回复','你有一条新回复'],
  'offer.created': ['trade','新购买申请','有买家提交了新的购买申请'],
  'offer.bid': ['trade','新竞价','有买家提交了新的竞价'],
  'offer.updated': ['trade','报价已更新','买家已更新报价'],
  'offer.withdrawn': ['trade','申请已撤回','买家已撤回购买申请'],
  'offer.accepted': ['trade','申请已接受','卖家已接受你的购买申请'],
  'offer.unselected': ['trade','申请未选中','该购买申请未被选中'],
  'offer.declined': ['trade','申请已拒绝','卖家已拒绝该购买申请'],
  'offer.expired': ['trade','申请已到期','该购买申请已到期'],
  'trade.meetup': ['trade','面交提醒','请与对方确认面交安排'],
  'trade.meetup-confirmed': ['trade','面交已确认','对方已确认面交安排'],
  'trade.cancelled': ['trade','锁定已取消','该交易锁定已取消'],
  'goods.sold': ['trade','商品已售出','卖家已标记商品售出'],
  'goods.off': ['trade','商品已下架','相关商品已下架，申请已结束'],
  'goods.changed': ['trade','商品信息已更新','请查看相关商品的最新信息'],
  'moderation.result': ['system','审核结果','你有一条新的审核结果'],
  'report.result': ['system','举报处理结果','你有一条新的举报处理结果'],
  'appeal.result': ['system','申诉处理结果','你有一条新的申诉处理结果']
};

class BusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireThat(condition, code, message) {
  if (!condition) throw new BusinessError(code,message);
}

function failure(error, fallback) {
  if (error instanceof BusinessError) return {code:-1,errCode:error.code,msg:error.message};
  console.error(fallback,error?.code || error?.errCode || 'UNKNOWN');
  return {code:-1,msg:fallback};
}

function key(...values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0,32);
}

const nonce = () => randomBytes(16).toString('hex');
const get = async (store, collection, id) => id ? (await store.collection(collection).doc(id).get()).data : null;
const put = (store, collection, id, data) => store.collection(collection).doc(id).set({data});
const update = (store, collection, id, data) => store.collection(collection).doc(id).update({data});
const ok = data => ({code:0,data});
const isParticipant = (row, user) => !!row && [row.buyerId,row.sellerId].includes(user);

function text(value, limit, required = false) {
  requireThat(value === undefined || typeof value === 'string','INVALID_INPUT','请输入有效的文本');
  const result = (value || '').trim();
  requireThat(result.length <= limit && (!required || result.length > 0),'INVALID_INPUT','请输入符合长度要求的文本');
  return result;
}

function requestKey(params) {
  if (params.requestId === undefined) return nonce();
  requireThat(typeof params.requestId === 'string' && /^[a-zA-Z0-9_-]{12,80}$/.test(params.requestId),
    'INVALID_REQUEST','请求编号有误，请重试');
  return params.requestId;
}

async function recordNotice(tx, {type,ownerId,source,conversationId = '',offerId = '',goodsId = '',content = '',createdAt}) {
  const event = events[type];
  requireThat(event && ownerId && source,'INVALID_NOTIFICATION','通知来源无效');
  const id = key('notification',type,source,ownerId);
  if (await get(tx,'notifications',id)) return id;
  const at = createdAt ?? Date.now();
  await put(tx,'notifications',id,{
    ownerId,type,title:event[1],content:content || event[2],conversationId,offerId,goodsId,read:false,createdAt:at
  });
  await put(tx,'notificationDeliveries',id,{notificationId:id,ownerId,state:'pending',attempts:0,nextAt:at,createdAt:at});
  return id;
}

async function queueTask(tx, type, source, payload, now, runAt = now) {
  const id = key('notification-task',type,source);
  if (await get(tx,'notificationTasks',id)) return id;
  await put(tx,'notificationTasks',id,{type,payload,state:'pending',nextAt:runAt,attempts:0,createdAt:now});
  return id;
}

function invalidListing(g) {
  return !g || g.enforcement === 'removed' || g.moderationStatus === 'rejected';
}

function cycle(g) { return g.listingCycle || ''; }

function due(offer) {
  return offer.expiresAt || Number(offer.createdAt) + 48 * hour;
}

function validPending(offer, goods, now) {
  return offer?.status === 'pending' && !invalidListing(goods) && goods.status === 'on' &&
    (offer.listingCycle || '') === cycle(goods) && due(offer) > now;
}

function quoteExpiryHours(value = 48) {
  const hours = Number(value);
  requireThat(Number.isInteger(hours) && hours >= 24 && hours <= 72,'INVALID_INPUT','报价有效期须为 24 至 72 小时');
  return hours;
}

function conversationId(goodsId,buyerId) {
  return 'c' + createHash('md5').update(goodsId + '_' + buyerId).digest('hex');
}

async function lookupConversation(db, goods, buyerId) {
  const rows = (await db.collection('conversations').where({goodsId:goods._id,sellerId:goods.sellerId,buyerId})
    .orderBy('updatedAt','desc').limit(1).get()).data;
  return rows[0]?._id || conversationId(goods._id,buyerId);
}

function newConversation(goods,buyerId,now) {
  return {
    _openid:buyerId,goodsId:goods._id,goodsTitle:goods.title,goodsCover:goods.images?.[0] || '',
    sellerId:goods.sellerId,buyerId,lastMsg:'',lastTime:now,updatedAt:now,
    unreadSeller:0,unreadBuyer:0,lastMessageId:''
  };
}

async function addMessage(tx, id, convId, conv, {actorId,ownerId,content,kind,offerId = '',now}) {
  const unreadField = ownerId === conv.sellerId ? 'unreadSeller' : 'unreadBuyer';
  await put(tx,'messages',id,{_openid:actorId,conversationId:convId,fromId:kind === 'text' ? actorId : 'system',
    toId:ownerId,content,kind,offerId,createdAt:now});
  const {_id,...body} = conv;
  await put(tx,'conversations',convId,{...body,lastMsg:content,lastMessageId:id,lastTime:now,updatedAt:now,
    [unreadField]:(conv[unreadField] || 0)+1});
}

module.exports = {
  hour,events,BusinessError,requireThat,failure,key,nonce,get,put,update,ok,isParticipant,text,requestKey,
  recordNotice,queueTask,invalidListing,cycle,due,validPending,quoteExpiryHours,conversationId,
  lookupConversation,newConversation,addMessage
};
