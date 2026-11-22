const app = getApp();
const { CATEGORY_MAP, CONDITIONS, TRADE_TYPES, CAMPUS_LIST } = require('../../utils/constants');
const { ALL_COLLEGES } = require('../../utils/colleges');
const { decorateGoods } = require('../../utils/format');
const { withPageReload, reloadLatest } = require('../../utils/page-reload');

function isTemporaryNetworkError(err) {
  if (!err || err.biz || err.friendly) return false;
  return /timeout|timed out|网络超时|网络断开|网络连接失败|network (?:error|is (?:down|unreachable)|(?:connection )?(?:lost|disconnected))|(?:ENETDOWN|ENETUNREACH|ECONNRESET|ERR_INTERNET_DISCONNECTED)/i
    .test(err.message || err.errMsg || '');
}

Page(withPageReload({
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
    searched: false,
    loadError: ''
  },

  onLoad() {
    const cats = [{ key: '', name: '全部' }].concat(
      Object.keys(CATEGORY_MAP).map((k) => ({ key: k, name: CATEGORY_MAP[k].name }))
    );
    this.setData({ cats });
  },

  reload() {
    this.applyPreset();
    return this.search();
  },

  async onPullDownRefresh() {
    try {
      await this.search();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  applyPreset() {
    const cat = wx.getStorageSync('searchCat');
    const college = wx.getStorageSync('searchCollege');
    if (!cat && !college) return;

    const patch = {};
    if (cat) {
      patch.cat = cat;
      if (cat !== 'book') patch.collegeIndex = 0;
      wx.removeStorageSync('searchCat');
    }
    if (college) {
      const pos = ALL_COLLEGES.indexOf(college);
      patch.cat = 'book';
      patch.collegeIndex = pos + 1;
      wx.removeStorageSync('searchCollege');
    }
    this.setData(patch);
  },

  onKeyword(e) { this.setData({ keyword: e.detail.value }); },

  // 改动任一筛选条件后立即查询
  onCat(e) {
    const cat = e.currentTarget.dataset.key;
    const patch = { cat };
    // 学院字段只有图书有，切到非图书类目时一并清掉，避免筛出空结果
    if (cat && cat !== 'book') patch.collegeIndex = 0;
    this.setData(patch);
    return this.search();
  },
  onCampus(e) {
    this.setData({ campusIndex: Number(e.detail.value) });
    return this.search();
  },
  onCollege(e) {
    const collegeIndex = Number(e.detail.value);
    const patch = { collegeIndex };
    // 选了具体学院，自动切到图书类目
    if (collegeIndex && this.data.cat !== 'book') patch.cat = 'book';
    this.setData(patch);
    return this.search();
  },
  onCond(e) {
    this.setData({ condIndex: Number(e.detail.value) });
    return this.search();
  },
  onTrade(e) {
    this.setData({ tradeIndex: Number(e.detail.value) });
    return this.search();
  },
  onMin(e) { this.setData({ priceMin: e.detail.value }); },
  onMax(e) { this.setData({ priceMax: e.detail.value }); },

  doSearch() { return this.search(); },

  reset() {
    this.setData({
      keyword: '',
      cat: '',
      campusIndex: 0,
      collegeIndex: 0,
      condIndex: 0,
      tradeIndex: 0,
      priceMin: '',
      priceMax: ''
    });
    return this.search();
  },

  searchParams() {
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

    return params;
  },

  search() {
    const params = this.searchParams();
    const query = JSON.stringify(params);

    return reloadLatest(this, async (isCurrent) => {
      const first = !this._searchStarted;
      this._searchStarted = true;
      const patch = { loading: true, loadError: '' };
      if (query !== this._loadedQuery) Object.assign(patch, { list: [], searched: false });
      this.setData(patch);

      try {
        return await app.call('goods', params);
      } catch (err) {
        if (!first || !isCurrent() || !isTemporaryNetworkError(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!isCurrent() || query !== JSON.stringify(this.searchParams())) throw err;
        return app.call('goods', params);
      }
    }, (list) => {
      const items = decorateGoods(list);
      this._loadedQuery = query;
      this.setData({ list: items, loading: false, searched: true });
    }, (err) => {
      this.setData({ loading: false, loadError: '商品加载失败，请稍后重试' });
      if (err && err.friendly) wx.showToast({ title: err.friendly, icon: 'none' });
    });
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  }
}));
