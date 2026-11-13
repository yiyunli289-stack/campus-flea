const app = getApp();
const { fmtTime } = require('../../utils/format');

Page({
  data: { list: [], loggedIn: false },

  onShow() {
    const me = app.globalData.userInfo;
    if (!me || !me.profileComplete) {
      this.setData({ loggedIn: false, list: [] });
      return;
    }
    this.setData({ loggedIn: true });
    app.call('chat', { action: 'conversations' })
      .then((list) => {
        const items = list.map((c) => {
          const isSeller = c.sellerId === me._openid;
          return {
            ...c,
            unread: isSeller ? c.unreadSeller : c.unreadBuyer,
            timeText: fmtTime(c.updatedAt)
          };
        });
        this.setData({ list: items });
      })
      .catch(() => this.setData({ list: [] }));
  },

  goChat(e) { wx.navigateTo({ url: '/pages/chat/chat?id=' + e.currentTarget.dataset.id }); },
  goLogin() { wx.switchTab({ url: '/pages/mine/mine' }); }
});
