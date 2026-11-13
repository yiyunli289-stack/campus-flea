const app = getApp();
const { CATEGORY_MAP, CONDITIONS, TRADE_TYPES, CAMPUS_LIST } = require('../../utils/constants');
const { ALL_COLLEGES } = require('../../utils/colleges');
const { decorateGoods } = require('../../utils/format');

Page({
  data: {
    keyword: '',
    cats: [],
    cat: '',
    campusOptions: ['全部校区'].concat(CAMPUS_LIST),
    campusIndex: 0,
    collegeOptions: ['全部学院'].concat(ALL_COLLEGES),
    collegeIndex: 0,
    conditionOptions: ['全部成色'].concat(CONDITIONS),
    condIndex: 0,
    tradeOptions: ['全部方式'].concat(TRADE_TYPES),
    tradeIndex: 0,
    priceMin: '',
    priceMax: '',
    list: [],
    loading: false,
    searched: false
  },

  onLoad() {
    const cats = [{ key: '', name: '全部' }].concat(Object.keys(CATEGORY_MAP).map((k) => ({ key: k, name: CATEGORY_MAP[k].name })));
    this.setData({ cats });
  },

  onShow() {
    // 每次进入（含从首页/学院页带参跳转）都检查预置筛选
    this.applyPreset();
    this.search();
  },

  applyPreset() {
    const cat = wx.getStorageSync('searchCat');
    if (cat) { this.setData({ cat }); wx.removeStorageSync('searchCat'); }

    const college = wx.getStorageSync('searchCollege');
    if (college) {
      const idx = ALL_COLLEGES.indexOf(college);
      this.setData({ cat: 'book', collegeIndex: Math.max(0, idx) + 1 });
      wx.removeStorageSync('searchCollege');
    }
  },

  onKeyword(e) { this.setData({ keyword: e.detail.value }); },
  onCat(e) { this.setData({ cat: e.currentTarget.dataset.key }); },
  onCampus(e) { this.setData({ campusIndex: Number(e.detail.value) }); },
  onCollege(e) { this.setData({ collegeIndex: Number(e.detail.value) }); },
  onCond(e) { this.setData({ condIndex: Number(e.detail.value) }); },
  onTrade(e) { this.setData({ tradeIndex: Number(e.detail.value) }); },
  onMin(e) { this.setData({ priceMin: e.detail.value }); },
  onMax(e) { this.setData({ priceMax: e.detail.value }); },

  doSearch() { this.search(); },

  reset() {
    this.setData({
      keyword: '', cat: '', campusIndex: 0, collegeIndex: 0,
      condIndex: 0, tradeIndex: 0, priceMin: '', priceMax: ''
    }, () => this.search());
  },

  search() {
    const { keyword, cat, campusOptions, campusIndex, collegeOptions, collegeIndex, condIndex, tradeIndex, priceMin, priceMax } = this.data;
    const params = {
      action: 'search',
      keyword: keyword.trim(),
      cat,
      campus: campusIndex ? campusOptions[campusIndex] : '',
      college: collegeIndex ? collegeOptions[collegeIndex] : '',
      condition: condIndex ? this.data.conditionOptions[condIndex] : '',
      tradeType: tradeIndex ? this.data.tradeOptions[tradeIndex] : ''
    };
    if (priceMin) params.priceMin = Number(priceMin);
    if (priceMax) params.priceMax = Number(priceMax);

    this.setData({ loading: true, searched: true });
    app.call('goods', params)
      .then((list) => this.setData({ list: decorateGoods(list) }))
      .catch(() => this.setData({ list: [] }))
      .then(() => this.setData({ loading: false }));
  },

  goDetail(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id }); }
});
