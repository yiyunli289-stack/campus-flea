const app = getApp();
const { decorateGoods, fmtTime } = require('../../utils/format');

Page({
  data: {
    list: [],
    statusText: { on: '在售', locked: '已锁定', sold: '已成交', off: '已下架' }
  },

  onShow() { this.load(); },

  load() {
    app.ensureProfile().then(() => {
      app.call('goods', { action: 'myGoods' })
        .then((list) => {
          const items = decorateGoods(list).map((g) => ({ ...g, timeText: fmtTime(g.createdAt) }));
          this.setData({ list: items });
        })
        .catch(() => this.setData({ list: [] }));
    }).catch(() => this.setData({ list: [] }));
  },

  goDetail(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id }); },

  onOffers(e) { wx.navigateTo({ url: '/pages/offers/offers?goodsId=' + e.currentTarget.dataset.id }); },

  onOffShelf(e) {
    app.call('goods', { action: 'offShelf', id: e.currentTarget.dataset.id })
      .then(() => this.load())
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  onRelist(e) {
    app.call('goods', { action: 'relist', id: e.currentTarget.dataset.id })
      .then(() => this.load())
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  onComplete(e) {
    wx.showModal({
      title: '确认成交？',
      content: '确认后商品标记为已成交',
      success: (r) => {
        if (r.confirm) {
          app.call('goods', { action: 'complete', id: e.currentTarget.dataset.id })
            .then(() => this.load())
            .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
        }
      }
    });
  }
});
