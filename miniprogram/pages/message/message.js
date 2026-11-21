const app = getApp();
const { fmtTime } = require('../../utils/format');

Page({
  data: { list: [], loggedIn: false, notificationCount:0 },

  onShow() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(),20000);
  },
  onHide() { clearInterval(this.timer); },
  onUnload() { clearInterval(this.timer); },

  refresh() {
    const me = app.globalData.userInfo;
    if (!me || !me.profileComplete) {
      this.setData({ loggedIn: false, list: [] });
      return;
    }
    this.setData({ loggedIn: true });
    app.refreshUnread().then(notificationCount=>this.setData({notificationCount}));
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

  goNotifications() { wx.navigateTo({url:'/pages/notification/notification'}); },
  goChat(e) { app.openChat(e.currentTarget.dataset.id); },
  goLogin() { wx.switchTab({ url: '/pages/mine/mine' }); }
});
