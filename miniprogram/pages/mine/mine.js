const app = getApp();

require('../../utils/page')({
  data: {
    userInfo: null,
    menu: [
      { icon: '🛡️', text: '安全中心与通知', url: '/pages/safety/safety' },
      { icon: '📦', text: '我的发布', url: '/pages/my-goods/my-goods' },
      { icon: '💰', text: '我的报价', url: '/pages/offers/offers' },
      { icon: '⭐', text: '我的收藏', url: '' },
      { icon: '🔍', text: '我的求购', url: '' },
      { icon: '📅', text: '我的租用', url: '' }
    ]
  },

  onShow() { app.refreshAccount().then(userInfo => this.setData({userInfo})).catch(app.showActionError); },

  onLogin() {
    wx.showLoading({ title: '登录中' });
    app.login()
      .then((user) => {
        wx.hideLoading();
        this.setData({ userInfo: user });
        if (!app.capabilityError(user,'profile') && !user.profileComplete) wx.navigateTo({ url: '/pages/profile/profile' });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: err.message || '登录失败', icon: 'none' });
      });
  },

  async onEditProfile() {
    try { await app.ensureProfile('profile'); wx.navigateTo({url:'/pages/profile/profile'}); }
    catch (error) { app.showActionError(error); }
  },

  onMenu(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.navigateTo({ url });
    else wx.showToast({ title: '建设中', icon: 'none' });
  },

  onAbout() {
    wx.showModal({
      title: '校园二手 · 测试版',
      content: '四川大学校园全品类二手交易平台\n线下面交，无在线支付\n内置举报与安全提示',
      showCancel: false
    });
  }
});
