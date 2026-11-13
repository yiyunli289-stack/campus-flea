const { CAMPUS_LIST, CATEGORY_MAP } = require('./utils/constants');

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    wx.cloud.init({
      env: 'cloud1-d5gody0jj8418ae20',
      traceUser: true
    });
    this.globalData.userInfo = wx.getStorageSync('userInfo') || null;
  },

  // 统一云函数调用封装：code!==0 抛错
  call(name, data) {
    return wx.cloud.callFunction({ name, data }).then((res) => {
      const r = res.result;
      if (r.code !== 0) throw new Error(r.msg || '操作失败');
      return r.data;
    });
  },

  login() {
    return this.call('login', { action: 'login' }).then((user) => {
      this.globalData.userInfo = user;
      wx.setStorageSync('userInfo', user);
      return user;
    });
  },

  updateProfile(data) {
    return this.call('login', { action: 'updateProfile', ...data }).then((user) => {
      this.globalData.userInfo = user;
      wx.setStorageSync('userInfo', user);
      return user;
    });
  },

  // 确保已登录且资料补全，否则引导去资料页（发布/报价/聊天的前置门槛）
  ensureProfile() {
    const u = this.globalData.userInfo;
    if (u && u.profileComplete) return Promise.resolve(u);
    return this.login().then((user) => {
      if (!user.profileComplete) {
        wx.navigateTo({ url: '/pages/profile/profile' });
        return Promise.reject(new Error('请先完善资料'));
      }
      return user;
    });
  },

  globalData: {
    userInfo: null,
    campus: '江安校区',
    campusList: CAMPUS_LIST,
    categoryMap: CATEGORY_MAP
  }
});
