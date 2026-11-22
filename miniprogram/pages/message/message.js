const app = getApp();
const { fmtTime } = require('../../utils/format');
const { withPageReload, reloadLatest } = require('../../utils/page-reload');

Page(withPageReload({
  data: { list: [], loggedIn: false, loading: false, loadError: '' },

  reload() {
    const me = app.globalData.userInfo;
    const owner = me && me.profileComplete ? me._openid : '';
    return reloadLatest(this, () => {
      const patch = { loggedIn: !!owner, loading: !!owner, loadError: '' };
      if (!owner || this._listOwner !== owner) patch.list = [];
      this._listOwner = owner;
      this.setData(patch);
      return owner ? app.call('chat', { action: 'conversations' }) : [];
    }, (list) => {
      const items = list.map((c) => ({
        ...c,
        unread: c.sellerId === owner ? c.unreadSeller : c.unreadBuyer,
        timeText: fmtTime(c.updatedAt)
      }));
      this.setData({ list: items, loading: false });
    }, () => this.setData({ loading: false, loadError: '会话加载失败，请稍后重试' }));
  },

  goChat(e) { app.openChat(e.currentTarget.dataset.id); },
  goLogin() { wx.switchTab({ url: '/pages/mine/mine' }); }
}));
