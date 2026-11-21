function requestId() {
  const part = () => Math.random().toString(36).slice(2,12).padEnd(10,'0');
  return [Date.now().toString(36),part(),part()].join('-');
}

function warmSubscription(page, scene) {
  const app = getApp();
  page._subscriptionScene = scene;
  page._subscriptionTicket = '';
  return app.call('notification',{action:'prepareSubscription',scene})
    .then(result => {
      page._subscriptionTicket = result.ticketId || '';
      page.setData({subscriptionOptions:result.choices || [],subscriptionReady:true});
    })
    .catch(() => page.setData({subscriptionOptions:[],subscriptionReady:false}));
}

function saveSubscription(page) {
  const receipt = page._subscriptionReceipt;
  return getApp().call('notification',{action:'registerSubscription',...receipt})
    .then(() => {
      page._subscriptionReceipt = null;
      wx.showToast({
        title:receipt.accepted.length?'已开启此次微信提醒':'将通过站内通知提醒',icon:'none'
      });
      return warmSubscription(page,page._subscriptionScene);
    })
    .catch(error => {
      if (['FORBIDDEN','INVALID_TICKET'].includes(error.errCode)) {
        page._subscriptionReceipt = null;
        warmSubscription(page,page._subscriptionScene);
      }
      wx.showToast({title:error.message || '保存失败，请重试',icon:'none'});
    })
    .finally(() => {page._subscribing = false;});
}

function subscribeTap(page, e) {
  if (page._subscribing) return;
  if (page._subscriptionReceipt) {
    page._subscribing = true;
    return saveSubscription(page);
  }
  const templateId = e.currentTarget.dataset.template;
  const ticketId = page._subscriptionTicket;
  if (!templateId || !ticketId) {
    wx.showToast({title:'提醒设置正在刷新',icon:'none'});
    return;
  }
  page._subscribing = true;
  wx.requestSubscribeMessage({
    tmplIds:[templateId],
    success:result => {
      const accepted = result[templateId] === 'accept' ? [templateId] : [];
      page._subscriptionReceipt = {ticketId,accepted};
      return saveSubscription(page);
    },
    fail:() => {
      page._subscribing = false;
      wx.showToast({title:'微信授权未完成，站内通知照常',icon:'none'});
    }
  });
}

module.exports = {requestId,warmSubscription,subscribeTap};
