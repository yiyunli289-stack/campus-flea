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

  onShow() { this.refreshUnread(); },

  refreshUnread() {
    if (!this.globalData.userInfo) return Promise.resolve(0);
    if (this._notificationUnread) return this._notificationUnread;
    this._notificationUnread = this.call('notification',{action:'unread'}).then(({count}) => {
      if (count) wx.setTabBarBadge({index:3,text:count>99?'99+':String(count),fail(){}});
      else wx.removeTabBarBadge({index:3,fail(){}});
      return count;
    }).catch(() => 0).finally(() => {this._notificationUnread = null;});
    return this._notificationUnread;
  },

  // 统一云函数调用封装：code!==0 抛错；未部署/调用失败给出可执行的提示
  call(name, data) {
    return wx.cloud
      .callFunction({ name, data })
      .then((res) => {
        const r = res && res.result;
        if (!r || r.code !== 0) {
          const e = new Error((r && r.msg) || '操作失败');
          e.biz = true;
          e.rawResult = r;
          e.errCode = (r && r.errCode) || '';
          e.errMsg = (r && r.errMsg) || '';
          throw e;
        }
        return r.data;
      })
      .catch((err) => {
        if (err && err.biz) throw err;
        const raw = (err && (err.errMsg || err.message)) || '云函数调用失败';
        const e = new Error(raw);
        e.functionName = name;
        const m = raw.match(/-5\d{5}|-4\d{5}/);
        e.errCode = (err && err.errCode) || (m ? m[0] : '');
        // -501000 云函数不存在 / -504002 依赖未安装 / -404011 调用失败
        if (/-501000|-504002|-404011/.test(raw)) {
          e.friendly =
            '云函数「' +
            name +
            '」不可用。请在微信开发者工具中右键 cloudfunctions/' +
            name +
            ' → 上传并部署（云端安装依赖），然后重新打开小程序再试。';
        }
        throw e;
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

  // 打开聊天页：防连点 + 栈顶已是同一会话时不再重复压栈
  openChat(convId) {
    if (!convId) return;
    const now = Date.now();
    if (this._chatNavAt && now - this._chatNavAt < 800) return;
    this._chatNavAt = now;

    const pages = getCurrentPages();
    const top = pages[pages.length - 1];
    if (top && top.route === 'pages/chat/chat' && top.options && top.options.id === convId) return;

    wx.navigateTo({ url: '/pages/chat/chat?id=' + convId, fail: () => {} });
  },

  globalData: {
    userInfo: null,
    campus: '江安校区',
    campusList: CAMPUS_LIST,
    categoryMap: CATEGORY_MAP
  }
});
