const app = getApp();
const { fmtTime, fmtPrice } = require('../../utils/format');
const { withPageReload, reloadLatest } = require('../../utils/page-reload');

const ST = { pending: '待处理', accepted: '已成交', rejected: '未选中', cancelled: '已取消' };

Page(withPageReload({
  data: { tab: 'received', received: [], sent: [], loading: false, loadError: '' },

  onLoad(query) { this.goodsId = query.goodsId || ''; },

  reload() {
    const { tab } = this.data;
    return reloadLatest(this, async (isCurrent) => {
      const cached = app.globalData.userInfo;
      const patch = { loading: true, loadError: '' };
      if (!cached || !cached.profileComplete || this._listOwner !== cached._openid) {
        Object.assign(patch, { received: [], sent: [] });
      }
      this.setData(patch);

      const user = await app.ensureProfile(isCurrent);
      if (!isCurrent()) return;
      this._listOwner = user._openid;
      return app.call('offer', { action: tab, goodsId: this.goodsId });
    }, (list) => {
      this.setData({ [tab]: this.deco(list), loading: false });
    }, (err) => this.setData({ loading: false, loadError: err.message || '报价加载失败' }));
  },

  deco(list) {
    return list.map((o) => ({
      ...o,
      statusText: ST[o.status] || o.status,
      priceText: fmtPrice(o.price),
      timeText: fmtTime(o.createdAt)
    }));
  },

  onTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
    return this.reload();
  },

  onAccept(e) {
    wx.showModal({
      title: '接受此报价？',
      content: '接受后商品将锁定给该买家，其他报价自动失效',
      success: (r) => {
        if (r.confirm) {
          app.call('offer', { action: 'accept', offerId: e.currentTarget.dataset.id })
            .then(() => { wx.showToast({ title: '已接受，交易锁定', icon: 'success' }); return this.reload(); })
            .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
        }
      }
    });
  },

  onCancel(e) {
    app.call('offer', { action: 'cancel', offerId: e.currentTarget.dataset.id })
      .then(() => this.reload())
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  onChat(e) {
    app.call('chat', { action: 'open', goodsId: e.currentTarget.dataset.goodsId })
      .then((conv) => app.openChat(conv._id))
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  }
}));
