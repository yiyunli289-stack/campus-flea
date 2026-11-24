const app = getApp();
const { HOT_COLLEGES } = require('../../utils/colleges');
const { decorateGoods } = require('../../utils/format');
const { withPageReload, reloadLatest } = require('../../utils/page-reload');

const ALL_CAMPUS = '全部校区';

Page(withPageReload({
  data: {
    campus: ALL_CAMPUS,
    campusOptions: [ALL_CAMPUS].concat(app.globalData.campusList),
    hotColleges: HOT_COLLEGES,
    categories: [],
    activeTab: 'all',
    goods: [],
    loading: false,
    loadError: ''
  },

  onLoad() {
    const map = app.globalData.categoryMap;
    const categories = Object.keys(map).map((k) => ({ key: k, ...map[k] }));
    // 默认全部校区，保证首页与搜索页口径一致；记住上次选择
    const campus = wx.getStorageSync('homeCampus') || ALL_CAMPUS;
    this.setData({ campus, categories });
  },

  reload() {
    const params = { action: 'search' };
    if (this.data.campus && this.data.campus !== ALL_CAMPUS) params.campus = this.data.campus;
    if (this.data.activeTab === 'book') params.cat = 'book';
    const query = JSON.stringify(params);
    return reloadLatest(this, () => {
      const patch = { loading: true, loadError: '' };
      if (query !== this._loadedQuery) patch.goods = [];
      this.setData(patch);
      return app.call('goods', params);
    }, (list) => {
      const goods = decorateGoods(list);
      this._loadedQuery = query;
      this.setData({ goods, loading: false });
    }, (err) => {
      this.setData({ loading: false, loadError: '商品加载失败，请稍后重试' });
      if (err && err.friendly) wx.showToast({ title: err.friendly, icon: 'none' });
    });
  },

  onTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
    return this.reload();
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
        this.reload();
      }
    });
  },

  goSearch() { wx.switchTab({ url: '/pages/search/search' }); },
  goMessage() { wx.switchTab({ url: '/pages/message/message' }); },
  goCollege() { wx.navigateTo({ url: '/pages/college/college' }); },
  goDetail(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id }); }
}));
