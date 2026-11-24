const app = getApp();
const { decorateGoods, fmtTime } = require('../../utils/format');

require('../../utils/page')({
  data: {
    list: [],
    statusText: { on: '在售', locked: '已锁定', sold: '已成交', off: '已下架', draft: '草稿', removed: '违规下架' }
  },

  onShow() { this.load(); },

  load() {
    app.login().then(() => {
      app.call('goods', { action: 'myGoods' })
        .then((list) => {
          const items = decorateGoods(list).map((g) => ({ ...g, timeText: fmtTime(g.createdAt), displayState: this.data.statusText[g.status] }));
          this.setData({ list: items });
        })
        .catch(() => this.setData({ list: [] }));
    }).catch(() => this.setData({ list: [] }));
  },

  goDetail(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id }); },

  onAppeal(e) { const targetId = e.currentTarget.dataset.id; wx.showModal({ title: '申请复核', editable: true, placeholderText: '请说明申诉理由', success: async r => { if (!r.confirm || !r.content.trim()) return; try { await app.call('report', { action: 'appeal', targetType: 'goods', targetId, reason: r.content }); wx.showToast({ title: '已提交复核' }); } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); } } }); },
  onOffers(e) { wx.navigateTo({ url: '/pages/offers/offers?goodsId=' + e.currentTarget.dataset.id }); },

  onEdit(e) {
    app.editListingId = e.currentTarget.dataset.id;
    wx.switchTab({url:'/pages/publish/publish'});
  },

  onUndoSold(e) {
    wx.showModal({title:'撤回售出确认？',content:'系统会按当前交易状态恢复商品。',success:async result => {
      if (!result.confirm) return;
      try {
        await app.call('goods',{action:'undoSold',id:e.currentTarget.dataset.id});
        this.load();
      } catch (error) { app.showActionError(error); }
    }});
  },

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

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除这件商品？',
      content: '删除后将从我的商品中移除。',
      success: async result => {
        if (!result.confirm) return;
        try {
          await app.call('goods', { action: 'remove', id });
          this.load();
        } catch (error) { app.showActionError(error); }
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
            .then(() => this.load())
            .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
        }
      }
    });
  }
});
