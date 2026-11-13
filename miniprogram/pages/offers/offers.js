const app = getApp();
const { fmtTime, fmtPrice } = require('../../utils/format');

const ST = { pending: '待处理', accepted: '已成交', rejected: '未选中', cancelled: '已取消' };

Page({
  data: { tab: 'received', received: [], sent: [] },

  onLoad(query) { this.goodsId = query.goodsId || ''; },
  onShow() { this.load(); },

  load() {
    app.ensureProfile().then(() => {
      app.call('offer', { action: 'received', goodsId: this.goodsId })
        .then((list) => this.setData({ received: this.deco(list) }))
        .catch(() => this.setData({ received: [] }));
      app.call('offer', { action: 'sent', goodsId: this.goodsId })
        .then((list) => this.setData({ sent: this.deco(list) }))
        .catch(() => this.setData({ sent: [] }));
    }).catch(() => {});
  },

  deco(list) {
    return list.map((o) => ({
      ...o,
      statusText: ST[o.status] || o.status,
      priceText: fmtPrice(o.price),
      timeText: fmtTime(o.createdAt)
    }));
  },

  onTab(e) { this.setData({ tab: e.currentTarget.dataset.tab }); },

  onAccept(e) {
    wx.showModal({
      title: '接受此报价？',
      content: '接受后商品将锁定给该买家，其他报价自动失效',
      success: (r) => {
        if (r.confirm) {
          app.call('offer', { action: 'accept', offerId: e.currentTarget.dataset.id })
            .then(() => { wx.showToast({ title: '已接受，交易锁定', icon: 'success' }); this.load(); })
            .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
        }
      }
    });
  },

  onCancel(e) {
    app.call('offer', { action: 'cancel', offerId: e.currentTarget.dataset.id })
      .then(() => this.load())
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  onChat(e) {
    app.call('chat', { action: 'open', goodsId: e.currentTarget.dataset.goodsId })
      .then((conv) => wx.navigateTo({ url: '/pages/chat/chat?id=' + conv._id }))
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  }
});
