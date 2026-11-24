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

  onShow() {
    if (this.globalData.userInfo) this.refreshAccount().catch(() => {});
  },

  rememberAccount(user) {
    this.globalData.userInfo = user;
    if (user?.accountStatus === 'deleted') {
      wx.removeStorageSync('userInfo');
      wx.removeStorageSync('goodsDraft');
    } else if (user) {
      const { contact, ...cached } = user;
      wx.setStorageSync('userInfo', cached);
    } else wx.removeStorageSync('userInfo');
    return user;
  },

  login() {
    return this.call('login', { action: 'login' }).then(user => this.rememberAccount(user));
  },

  refreshAccount() {
    if (this.accountRequest) return this.accountRequest;
    this.accountRequest = this.call('login', { action: 'state' })
      .then(user => this.rememberAccount(user))
      .finally(() => { this.accountRequest = null; });
    return this.accountRequest;
  },

  updateProfile(data) {
    return this.call('login', { action: 'updateProfile', ...data }).then(user => this.rememberAccount(user));
  },

  async ensureProfile(capability) {
    const user = await this.refreshAccount() || await this.login();
    const denied = this.capabilityError(user, capability);
    if (denied) throw denied;
    if (!user.profileComplete && capability !== 'profile') {
      wx.navigateTo({ url: '/pages/profile/profile' });
      throw new Error('请先完善资料');
    }
    return user;
  },

  capabilityError(user, capability) {
    if (!user) return null;
    if (user.accountStatus === 'deleted') return new Error('账号已注销');
    if (user.accountStatus === 'banned') return new Error('账号已封禁，请在安全中心查看处置或申诉');
    if (capability && user.allowedCapabilities && !user.allowedCapabilities.includes(capability)) {
      return new Error('账号当前不能执行此操作，请在安全中心查看限制');
    }
    return null;
  },

  showActionError(error) {
    wx.showToast({title:error.message || '操作失败',icon:'none'});
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
    const user = await this.refreshAccount() || await this.login();
    const denied = this.capabilityError(user, 'upload');
    if (denied) throw denied;
    const fileInfo = await new Promise((resolve,reject) => wx.getFileSystemManager().getFileInfo({
      filePath,success:resolve,fail:reject
    }));
    if (fileInfo.size > 10*1024*1024) throw new Error('上传图片最大为10MB');
    const ticket = await this.call('governance',{action:'uploadTicket'});
    await new Promise((resolve,reject) => wx.uploadFile({
      url:ticket.url,filePath,name:'file',formData:ticket.formData,
      success:res => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error('图片上传失败')),
      fail:() => reject(new Error('图片上传失败，请检查网络或云存储配置'))
    }));
    return this.call('governance',{action:'registerMedia',id:ticket.id,fileID:ticket.fileID});
  },
  globalData: {
    userInfo: null,
    campus: '江安校区',
    campusList: CAMPUS_LIST,
    categoryMap: CATEGORY_MAP
  }
});
