const app = getApp();
const { HOT_COLLEGES } = require('../../utils/colleges');
const { decorateGoods } = require('../../utils/format');

Page({
  data: {
    campus: '江安校区',
    hotColleges: HOT_COLLEGES,
    categories: [],
    activeTab: 'all',
    goods: [],
    loading: false
  },

  onLoad() {
    const map = app.globalData.categoryMap;
    const categories = Object.keys(map).map((k) => ({ key: k, ...map[k] }));
    this.setData({ campus: app.globalData.campus, categories });
  },

  onShow() { this.fetch(); },

  fetch() {
    this.setData({ loading: true });
    const params = { action: 'search', campus: this.data.campus };
    if (this.data.activeTab === 'book') params.cat = 'book';
    app.call('goods', params)
      .then((list) => this.setData({ goods: decorateGoods(list) }))
      .catch(() => this.setData({ goods: [] }))
      .then(() => this.setData({ loading: false }));
  },

  onTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab }, () => this.fetch());
  },

  onCategory(e) {
    wx.setStorageSync('searchCat', e.currentTarget.dataset.key);
    wx.switchTab({ url: '/pages/search/search' });
  },

  onHotCollege(e) {
    wx.setStorageSync('searchCollege', e.currentTarget.dataset.college);
    wx.setStorageSync('searchCat', 'book');
    wx.switchTab({ url: '/pages/search/search' });
  },

  onPickCampus() {
    const list = app.globalData.campusList;
    wx.showActionSheet({
      itemList: list,
      success: (res) => {
        const campus = list[res.tapIndex];
        app.globalData.campus = campus;
        this.setData({ campus });
        this.fetch();
      }
    });
  },

  goSearch() { wx.switchTab({ url: '/pages/search/search' }); },
  goMessage() { wx.switchTab({ url: '/pages/message/message' }); },
  goCollege() { wx.navigateTo({ url: '/pages/college/college' }); },
  goDetail(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id }); }
});
