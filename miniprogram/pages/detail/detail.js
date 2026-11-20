const app = getApp();
const { decorateGoods, fmtTime } = require('../../utils/format');

require('../../utils/page')({
  data: {
    goods: null,
    isBook: false,
    isMine: false,
    timeText: ''
  },

  onLoad(query) { this.id = query.id; },
  onShow() { this.fetch(); },

  fetch() {
    this.setData({goods:null});
    app.call('goods', { action: 'detail', id: this.id })
      .then((g) => {
        const goods = decorateGoods([g])[0];
        const NOTE_CLASS = { '无笔记': 'note-none', '少量': 'note-few', '较多': 'note-many', '大量': 'note-lots' };
        goods.noteClass = NOTE_CLASS[goods.noteLevel] || 'note-none';
        const me = app.globalData.userInfo;
        this.setData({
          goods,
          isBook: goods.cat === 'book',
          isMine: goods.isOwner || !!(me && goods.sellerId === me._openid),
          stateText: ({locked:'已锁定',sold:'已售出',off:'已下架',draft:'草稿',removed:'违规下架'})[goods.status] || '',
          timeText: fmtTime(goods.createdAt)
        });
      })
      .catch((err) => wx.showToast({ title: err.message || '加载失败', icon: 'none' }));
  },

  onBuy() { this.makeOffer(this.data.goods.price); },

  onBid() {
    wx.showModal({
      title: '我要出价',
      editable: true,
      placeholderText: '请输入你的出价（元）',
      success: (res) => {
        if (!res.confirm) return;
        const p = Number(res.content);
        if (!p || p <= 0) return wx.showToast({ title: '请输入有效价格', icon: 'none' });
        this.makeOffer(p);
      }
    });
  },

  makeOffer(price) {
    app.ensureProfile('offer').then(() => {
      wx.showLoading({ title: '提交中' });
      app.call('offer', { action: 'create', goodsId: this.id, price })
        .then(() => {
          wx.hideLoading();
          wx.showToast({ title: '已提交，等卖家处理', icon: 'none' });
        })
        .catch((err) => { wx.hideLoading(); wx.showToast({ title: err.message, icon: 'none' }); });
    }).catch(err => app.showActionError(err));
  },

  async onChat() {
    try {
      await app.ensureProfile('message');
      const conversation = await app.call('chat', { action: 'open', goodsId: this.id });
      wx.navigateTo({ url: '/pages/chat/chat?id=' + conversation._id });
    } catch (error) {
      if (error.message !== '请先完善资料') app.showActionError(error);
    }
  },

  onReportSeller() { require('../../utils/governance').report('users', this.data.goods.sellerId); },
  onBlockSeller() { require('../../utils/governance').block(this.data.goods.sellerId); },
  onReport() { require('../../utils/governance').report('goods', this.id); }
});
