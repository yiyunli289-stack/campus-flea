const app = getApp();
const { ALL_COLLEGES } = require('../../utils/colleges');

require('../../utils/page')({
  data: {
    nickName: '',
    avatarUrl: '',
    campusList: [],
    campusIndex: 0,
    colleges: ALL_COLLEGES,
    collegeIndex: 0,
    college: '',
    major: '',
    contact: ''
  },

  async onLoad() {
    try { await app.refreshAccount() || await app.login(); } catch (error) { app.showActionError(error); }
    const user = app.globalData.userInfo || {};
    const campusList = app.globalData.campusList;
    const campusIndex = Math.max(0, campusList.indexOf(user.campus));
    const collegeIndex = Math.max(0, ALL_COLLEGES.indexOf(user.college));
    this.setData({
      nickName: user.nickName || '',
      avatarUrl: user.avatarUrl || '',avatarPreview:user.avatarPreview || '',
      campusList,
      campusIndex,
      collegeIndex,
      college: user.college || ALL_COLLEGES[0],
      major: user.major || '',
      contact: user.contact || '',
      restriction: app.capabilityError(user,'profile')?.message || ''
    });
  },

  onShow() { app.refreshAccount().then(user => this.setData({restriction:app.capabilityError(user,'profile')?.message || ''})).catch(app.showActionError); },

  onChooseAvatar(e) {
    this.setData({ avatarUrl: e.detail.avatarUrl, avatarPreview:e.detail.avatarUrl });
  },

  onNickName(e) { this.setData({ nickName: e.detail.value }); },
  onCampus(e) { this.setData({ campusIndex: Number(e.detail.value) }); },
  onCollege(e) {
    const i = Number(e.detail.value);
    this.setData({ collegeIndex: i, college: ALL_COLLEGES[i] });
  },
  onMajor(e) { this.setData({ major: e.detail.value }); },
  onContact(e) { this.setData({ contact: e.detail.value }); },

  async onSave() {
    try { await app.ensureProfile('profile'); } catch (error) { app.showActionError(error); return; }
    const { nickName, avatarUrl, campusList, campusIndex, college, major, contact } = this.data;
    const campus = campusList[campusIndex];

    if (!nickName.trim()) return wx.showToast({ title: '请填写昵称', icon: 'none' });
    if (!campus) return wx.showToast({ title: '请选择校区', icon: 'none' });
    if (!contact.trim()) return wx.showToast({ title: '请填写联系方式', icon: 'none' });

    wx.showLoading({ title: '保存中' });
    Promise.resolve(avatarUrl && avatarUrl !== app.globalData.userInfo?.avatarUrl && !avatarUrl.startsWith('cloud://') ? app.uploadFile(avatarUrl).then(r => r.fileID) : avatarUrl).then(savedAvatar => app.updateProfile({ nickName: nickName.trim(), avatarUrl: savedAvatar, campus, college, major: major.trim(), contact: contact.trim() }))
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '资料已提交审核', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: err.message || '保存失败', icon: 'none' });
      });
  }
});
