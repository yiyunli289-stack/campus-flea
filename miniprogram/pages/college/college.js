const { COLLEGE_GROUPS } = require('../../utils/colleges');

Page({
  data: { groups: COLLEGE_GROUPS },

  onCollege(e) {
    const name = e.currentTarget.dataset.name;
    // 学院书单 = 按学院筛选二手书
    wx.setStorageSync('searchCollege', name);
    wx.setStorageSync('searchCat', 'book');
    wx.switchTab({ url: '/pages/search/search' });
  }
});
