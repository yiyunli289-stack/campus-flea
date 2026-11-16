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
    this._seq = 0;
    const cats = [{ key: '', name: '全部' }].concat(
      Object.keys(CATEGORY_MAP).map((k) => ({ key: k, name: CATEGORY_MAP[k].name }))
    );
    this.setData({ cats });
  },

  onShow() {
    // 只有首次进入、或首页/学院页带筛选跳转时才重新查询；
    // 从商品详情返回时保留原列表，不再打断/清空
    const preset = this.applyPreset();
    if (preset || !this.data.searched) this.search();
  },

  onPullDownRefresh() {
    this.search(true);
  },

  // 返回是否有预置筛选变化（搜索结果需要重查）
  applyPreset() {
    let changed = false;

    const cat = wx.getStorageSync('searchCat');
    if (cat) {
      this.setData({ cat });
      wx.removeStorageSync('searchCat');
      changed = true;
    }

    const college = wx.getStorageSync('searchCollege');
    if (college) {
      const pos = ALL_COLLEGES.indexOf(college);
      this.setData({ cat: 'book', collegeIndex: pos >= 0 ? pos + 1 : 0 });
      wx.removeStorageSync('searchCollege');
      changed = true;
    }

    return changed;
  },

  onKeyword(e) { this.setData({ keyword: e.detail.value }); },

  // 改动任一筛选条件后立即查询
  onCat(e) {
    const cat = e.currentTarget.dataset.key;
    const patch = { cat };
    // 学院字段只有图书有，切到非图书类目时一并清掉，避免筛出空结果
    if (cat && cat !== 'book') patch.collegeIndex = 0;
    this.setData(patch, () => this.search());
  },
  onCampus(e) { this.setData({ campusIndex: Number(e.detail.value) }, () => this.search()); },
  onCollege(e) {
    const collegeIndex = Number(e.detail.value);
    const patch = { collegeIndex };
    // 选了具体学院，自动切到图书类目
    if (collegeIndex && this.data.cat !== 'book') patch.cat = 'book';
    this.setData(patch, () => this.search());
  },
  onCond(e) { this.setData({ condIndex: Number(e.detail.value) }, () => this.search()); },
  onTrade(e) { this.setData({ tradeIndex: Number(e.detail.value) }, () => this.search()); },
  onMin(e) { this.setData({ priceMin: e.detail.value }); },
  onMax(e) { this.setData({ priceMax: e.detail.value }); },

  doSearch() { this.search(); },

  reset() {
    this.setData(
      {
        keyword: '',
        cat: '',
        campusIndex: 0,
        collegeIndex: 0,
        condIndex: 0,
        tradeIndex: 0,
        priceMin: '',
        priceMax: ''
      },
      () => this.search()
    );
  },

  search(fromPull) {
    const {
      keyword, cat, campusOptions, campusIndex,
      collegeOptions, collegeIndex,
      condIndex, tradeIndex, priceMin, priceMax
    } = this.data;

    const params = {
      action: 'search',
      keyword: keyword.trim(),
      cat,
      campus: campusIndex ? campusOptions[campusIndex] : '',
      college: collegeIndex ? collegeOptions[collegeIndex] : '',
      condition: condIndex ? this.data.conditionOptions[condIndex] : '',
      tradeType: tradeIndex ? this.data.tradeOptions[tradeIndex] : ''
    };
    if (priceMin !== '' && !isNaN(Number(priceMin))) params.priceMin = Number(priceMin);
    if (priceMax !== '' && !isNaN(Number(priceMax))) params.priceMax = Number(priceMax);

    // 请求序号：快速连点筛选时只认最后一次结果
    const seq = ++this._seq;
    this.setData({ loading: true, searched: true });

    return app
      .call('goods', params)
      .then((list) => {
        if (seq !== this._seq) return;
        // 只有成功才替换列表，失败时保留上一次结果
        this.setData({ list: decorateGoods(list), loading: false });
      })
      .catch((err) => {
        if (seq !== this._seq) return;
        this.setData({ loading: false });
        wx.showToast({ title: (err && (err.friendly || err.message)) || '搜索失败', icon: 'none' });
      })
      .then(() => {
        if (fromPull) wx.stopPullDownRefresh();
      });
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  }
});
