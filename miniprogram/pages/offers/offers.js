const app = getApp();
const { fmtTime, fmtPrice } = require('../../utils/format');

const ST = { pending: '待处理', accepted: '已锁定', rejected: '未选中', cancelled: '已取消', closed: '已关闭', completed: '已结束' };

require('../../utils/page')({
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

  onTradeDecision(e) {
    const { action, id } = e.currentTarget.dataset;
    wx.showModal({
      title: action==='decline'?'拒绝购买申请':'取消面交锁定',
      editable: true, placeholderText: '请填写原因',
      success: async result => {
        if (!result.confirm) return;
        try {
          await app.call('offer', { action, offerId:id, reason:result.content });
          this.load();
        } catch (err) { wx.showToast({ title:err.message, icon:'none' }); }
      }
    });
  },

  onReportOffer(e) { require('../../utils/governance').report('offers', e.currentTarget.dataset.id); },
  onUpdate(e) { const offerId = e.currentTarget.dataset.id; wx.showModal({ title: '修改竞价', editable: true, placeholderText: '新的报价金额', success: async r => { if (!r.confirm) return; try { await app.call('offer', { action: 'update', offerId, price: Number(r.content) }); wx.showToast({ title: '报价已提交审核' }); this.load(); } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); } } }); },
  onChat(e) {
    app.call('chat', { action: 'open', goodsId: e.currentTarget.dataset.goodsId })
      .then((conv) => wx.navigateTo({ url: '/pages/chat/chat?id=' + conv._id }))
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  }
});
