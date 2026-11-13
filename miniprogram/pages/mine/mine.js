const app = getApp();

Page({
  data: {
    userInfo: null,
    menu: [
      { icon: '📦', text: '我的发布', url: '/pages/my-goods/my-goods' },
      { icon: '💰', text: '我的报价', url: '/pages/offers/offers' },
      { icon: '⭐', text: '我的收藏', url: '' },
      { icon: '🔍', text: '我的求购', url: '' },
      { icon: '📅', text: '我的租用', url: '' }
    ]
  },

  onShow() { this.setData({ userInfo: app.globalData.userInfo }); },

  onLogin() {
    wx.showLoading({ title: '登录中' });
    app.login()
      .then((user) => {
        wx.hideLoading();
        this.setData({ userInfo: user });
        if (!user.profileComplete) wx.navigateTo({ url: '/pages/profile/profile' });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: err.message || '登录失败', icon: 'none' });
      });
  },

  onEditProfile() { wx.navigateTo({ url: '/pages/profile/profile' }); },

  onMenu(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.navigateTo({ url });
    else wx.showToast({ title: '建设中', icon: 'none' });
  },

  onSeed() {
    wx.showLoading({ title: '初始化中' });
    app.call('goods', { action: 'seed' })
      .then((r) => {
        wx.hideLoading();
        wx.showToast({ title: '已添加 ' + r.count + ' 条演示数据', icon: 'none' });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: err.message, icon: 'none' });
      });
  },

  onAbout() {
    wx.showModal({
      title: '校园二手 · 测试版',
      content: '四川大学校园全品类二手交易平台\n线下面交，无在线支付\n内置举报与安全提示',
      showCancel: false
    });
  }
});
