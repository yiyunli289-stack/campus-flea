const app = getApp();
const { HOT_COLLEGES } = require('../../utils/colleges');
const { decorateGoods } = require('../../utils/format');

const ALL_CAMPUS = '全部校区';

Page({
  data: {
    campus: ALL_CAMPUS,
    campusOptions: [ALL_CAMPUS].concat(app.globalData.campusList),
    hotColleges: HOT_COLLEGES,
    categories: [],
    activeTab: 'all',
    goods: [],
    loading: false
  },

  onLoad() {
    const map = app.globalData.categoryMap;
    const categories = Object.keys(map).map((k) => ({ key: k, ...map[k] }));
    // 默认全部校区，保证首页与搜索页口径一致；记住上次选择
    const campus = wx.getStorageSync('homeCampus') || ALL_CAMPUS;
    this.setData({ campus, categories });
  },

  onShow() { this.fetch(); },

  fetch() {
    this.setData({ loading: true });
    const params = { action: 'search' };
    if (this.data.campus && this.data.campus !== ALL_CAMPUS) params.campus = this.data.campus;
    if (this.data.activeTab === 'book') params.cat = 'book';
    app.call('goods', params)
      .then((list) => this.setData({ goods: decorateGoods(list) }))
      // 查询失败时保留已有列表，避免从详情返回后整页空白
      .catch((err) => wx.showToast({ title: (err && (err.friendly || err.message)) || '加载失败', icon: 'none' }))
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
    const list = this.data.campusOptions;
    wx.showActionSheet({
      itemList: list,
      success: (res) => {
        const campus = list[res.tapIndex];
        wx.setStorageSync('homeCampus', campus);
        if (campus !== ALL_CAMPUS) app.globalData.campus = campus; // 发布页默认校区跟随
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
