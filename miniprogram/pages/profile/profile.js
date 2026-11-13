const app = getApp();
const { ALL_COLLEGES } = require('../../utils/colleges');

Page({
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

  onLoad() {
    const user = app.globalData.userInfo || {};
    const campusList = app.globalData.campusList;
    const campusIndex = Math.max(0, campusList.indexOf(user.campus));
    const collegeIndex = Math.max(0, ALL_COLLEGES.indexOf(user.college));
    this.setData({
      nickName: user.nickName || '',
      avatarUrl: user.avatarUrl || '',
      campusList,
      campusIndex,
      collegeIndex,
      college: user.college || ALL_COLLEGES[0],
      major: user.major || '',
      contact: user.contact || ''
    });
  },

  onChooseAvatar(e) {
    this.setData({ avatarUrl: e.detail.avatarUrl });
  },

  onNickName(e) { this.setData({ nickName: e.detail.value }); },
  onCampus(e) { this.setData({ campusIndex: Number(e.detail.value) }); },
  onCollege(e) {
    const i = Number(e.detail.value);
    this.setData({ collegeIndex: i, college: ALL_COLLEGES[i] });
  },
  onMajor(e) { this.setData({ major: e.detail.value }); },
  onContact(e) { this.setData({ contact: e.detail.value }); },

  onSave() {
    const { nickName, avatarUrl, campusList, campusIndex, college, major, contact } = this.data;
    const campus = campusList[campusIndex];

    if (!nickName.trim()) return wx.showToast({ title: '请填写昵称', icon: 'none' });
    if (!campus) return wx.showToast({ title: '请选择校区', icon: 'none' });
    if (!contact.trim()) return wx.showToast({ title: '请填写联系方式', icon: 'none' });

    wx.showLoading({ title: '保存中' });
    app.updateProfile({ nickName: nickName.trim(), avatarUrl, campus, college, major: major.trim(), contact: contact.trim() })
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '保存成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: err.message || '保存失败', icon: 'none' });
      });
  }
});
