'use strict';

const cloud = require('wx-server-sdk');
const {requireThat,failure} = require('./lib/core');
const {
  loadTemplates,prepareSubscription,registerSubscription,listNotifications,notificationUnread,readNotification
} = require('./lib/delivery');

cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db = cloud.database({throwOnNotFound:false});

exports.main = async (event = {}) => {
  const {OPENID} = cloud.getWXContext();
  if (!OPENID) return {code:-1,msg:'请先登录'};
  try {
    const templates = loadTemplates(process.env.WECHAT_NOTIFICATION_TEMPLATES);
    switch (event.action) {
      case 'list': return await listNotifications(db,OPENID,event);
      case 'unread': return await notificationUnread(db,OPENID);
      case 'read': return await readNotification(db,OPENID,event.id);
      case 'prepareSubscription':
        requireThat(!event.scene || ['chat','trade','system'].includes(event.scene),'INVALID_SCENE','请选择有效订阅类型');
        return await prepareSubscription(db,templates,OPENID,event.scene,Date.now());
      case 'registerSubscription': return await registerSubscription(db,templates,OPENID,event,Date.now());
      default: return {code:-1,msg:'未知通知操作'};
    }
  } catch (error) { return failure(error,'通知服务暂不可用'); }
};
