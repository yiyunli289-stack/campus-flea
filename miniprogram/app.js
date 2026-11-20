const { CAMPUS_LIST, CATEGORY_MAP, CONDITIONS, NOTE_LEVELS } = require('./utils/constants');
const collegeData = require('./utils/colleges');

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
      if (r.code !== 0) { const err = new Error(r.msg || '操作失败'); err.code = r.code; throw err; }
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

  loadConfig(force) {
    if (!force && this.globalData.config && Date.now() - (this.configFetchedAt || 0) < 60000) return Promise.resolve(this.globalData.config);
    if (this.configLoading) return this.configLoading;
    this.configLoading = this.call('config', {}).then(c => {
      this.globalData.config = c; this.configFetchedAt = Date.now(); wx.setStorageSync('publicConfig', c);
      const codes = key => c[key].filter(x => x.active).map(x => x.code);
      CAMPUS_LIST.splice(0, CAMPUS_LIST.length, ...codes('campuses'));
      CONDITIONS.splice(0, CONDITIONS.length, ...codes('conditions'));
      NOTE_LEVELS.splice(0, NOTE_LEVELS.length, ...codes('noteLevels'));
      collegeData.ALL_COLLEGES.splice(0, collegeData.ALL_COLLEGES.length, ...codes('colleges'));
      collegeData.COLLEGE_GROUPS.splice(0, collegeData.COLLEGE_GROUPS.length, { group: '学院', colleges: codes('colleges') });
      collegeData.HOT_COLLEGES.splice(0, collegeData.HOT_COLLEGES.length, ...codes('colleges').slice(0, 8));
      Object.keys(CATEGORY_MAP).forEach(k => delete CATEGORY_MAP[k]);
      c.categories.filter(x => x.active).forEach(x => { CATEGORY_MAP[x.code] = { name: x.name, icon: x.icon || '📦' }; });
      return c;
    }).finally(() => { this.configLoading = null; });
    return this.configLoading;
  },
  async uploadFile(filePath) {
    if (filePath.startsWith('cloud://')) return { fileID: filePath };
    if (!this.globalData.userInfo) await this.login();
    const ticket = await this.call('governance', { action: 'uploadTicket' });
    const upload = await wx.cloud.uploadFile({ cloudPath: ticket.cloudPath, filePath });
    return this.call('governance', { action: 'registerMedia', id: ticket.id, fileID: upload.fileID });
  },
  globalData: {
    userInfo: null,
    campus: '江安校区',
    campusList: CAMPUS_LIST,
    categoryMap: CATEGORY_MAP
  }
});
