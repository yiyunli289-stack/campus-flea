const app = getApp();
const { decorateGoods, fmtTime } = require('../../utils/format');
const { withPageReload, reloadLatest } = require('../../utils/page-reload');

Page(withPageReload({
  data: {
    goods: null,
    isBook: false,
    isMine: false,
    timeText: ''
  },

  onLoad(query) { this.id = query.id; },
  reload() {
    return reloadLatest(this,
      () => app.call('goods', { action: 'detail', id: this.id }),
      (g) => {
        const goods = decorateGoods([g])[0];
        const NOTE_CLASS = { '无笔记': 'note-none', '少量': 'note-few', '较多': 'note-many', '大量': 'note-lots' };
        goods.noteClass = NOTE_CLASS[goods.noteLevel] || 'note-none';
        const me = app.globalData.userInfo;
        this.setData({
          goods,
          isBook: goods.cat === 'book',
          isMine: !!(me && goods.sellerId === me._openid),
          timeText: fmtTime(goods.createdAt)
        });
      },
      (err) => wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    );
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
    app.ensureProfile().then(() => {
      wx.showLoading({ title: '提交中' });
      app.call('offer', { action: 'create', goodsId: this.id, price })
        .then(() => {
          wx.hideLoading();
          wx.showToast({ title: '已提交，等卖家处理', icon: 'none' });
        })
        .catch((err) => { wx.hideLoading(); wx.showToast({ title: err.message, icon: 'none' }); });
    }).catch(() => {});
  },

  onChat() {
    // 防连点：一次点击可能触发多次 open + navigateTo，导致叠出多个聊天页
    if (this._chatting) return;
    this._chatting = true;

    wx.showLoading({ title: '打开中', mask: true });
    const done = () => {
      this._chatting = false;
      wx.hideLoading();
    };

    app
      .ensureProfile()
      .then(() => app.call('chat', { action: 'open', goodsId: this.id }))
      .then((conv) => {
        done();
        app.openChat(conv._id);
      })
      .catch((err) => {
        done();
        if (err && err.message === '请先完善资料') return; // ensureProfile 已跳转资料页
        wx.showToast({ title: (err && (err.friendly || err.message)) || '打开失败', icon: 'none' });
      });
  },

  onReport() {
    const reasons = ['虚假信息', '违禁物品', '涉嫌诈骗', '其他'];
    wx.showActionSheet({
      itemList: reasons,
      success: (res) => {
        const reason = reasons[res.tapIndex];
        wx.showModal({
          title: '举报 · ' + reason,
          editable: true,
          placeholderText: '补充说明（选填）',
          success: (r) => {
            if (!r.confirm) return;
            app.call('report', { action: 'create', goodsId: this.id, reason, detail: r.content || '' })
              .then(() => wx.showToast({ title: '已提交举报', icon: 'success' }))
              .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
          }
        });
      }
    });
  }
}));
