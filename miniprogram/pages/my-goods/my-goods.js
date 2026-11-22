const app = getApp();
const { decorateGoods, fmtTime } = require('../../utils/format');
const { withPageReload, reloadLatest } = require('../../utils/page-reload');

Page(withPageReload({
  data: {
    list: [],
    loading: false,
    loadError: '',
    statusText: { on: '在售', locked: '已锁定', sold: '已成交', off: '已下架' }
  },

  reload() {
    return reloadLatest(this, async (isCurrent) => {
      const cached = app.globalData.userInfo;
      const patch = { loading: true, loadError: '' };
      if (!cached || !cached.profileComplete || this._listOwner !== cached._openid) patch.list = [];
      this.setData(patch);

      const user = await app.ensureProfile(isCurrent);
      if (!isCurrent()) return;
      this._listOwner = user._openid;
      return app.call('goods', { action: 'myGoods' });
    }, (list) => {
      const items = decorateGoods(list).map((g) => ({ ...g, timeText: fmtTime(g.createdAt) }));
      this.setData({ list: items, loading: false });
    }, (err) => this.setData({ loading: false, loadError: err.message || '商品加载失败' }));
  },

  goDetail(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id }); },

  onOffers(e) { wx.navigateTo({ url: '/pages/offers/offers?goodsId=' + e.currentTarget.dataset.id }); },

  onOffShelf(e) {
    app.call('goods', { action: 'offShelf', id: e.currentTarget.dataset.id })
      .then(() => this.reload())
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  onRelist(e) {
    app.call('goods', { action: 'relist', id: e.currentTarget.dataset.id })
      .then(() => this.reload())
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  onDelete(e) {
    wx.showModal({
      title: '删除这件商品？',
      content: '删除后不可恢复，重复发布的多余商品可以这样清理',
      confirmColor: '#B4100A',
      success: (r) => {
        if (!r.confirm) return;
        app.call('goods', { action: 'remove', id: e.currentTarget.dataset.id })
          .then(() => this.reload())
          .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
      }
    });
  },

  onComplete(e) {
    wx.showModal({
      title: '确认成交？',
      content: '确认后商品标记为已成交',
      success: (r) => {
        if (r.confirm) {
          app.call('goods', { action: 'complete', id: e.currentTarget.dataset.id })
            .then(() => this.reload())
            .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
        }
      }
    });
  }
}));
