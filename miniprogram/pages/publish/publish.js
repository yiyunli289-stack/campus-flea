const app = getApp();
const { CATEGORY_MAP, CONDITIONS, NOTE_LEVELS, CAMPUS_LIST } = require('../../utils/constants');
const { ALL_COLLEGES } = require('../../utils/colleges');

require('../../utils/page')({
  data: {
    cats: [],
    cat: 'book',
    tradeType: '定价',
    allowBargain: true,
    conditions: CONDITIONS,
    condition: '几乎全新',
    conditionIndex: 1,
    campusList: CAMPUS_LIST,
    campus: '江安校区',
    campusIndex: 0,
    noteLevels: NOTE_LEVELS,
    noteLevel: '无笔记',
    noteIndex: 0,
    colleges: ALL_COLLEGES,
    collegeIndex: 0,
    title: '',
    price: '',
    desc: '',
    images: [],
    innerPhotos: [],
    isbn: '', author: '', publisher: '', edition: '', course: '', noteDesc: '', defects: '',
    attributes: {}, activeFields: [],
    submitting: false
  },

  onLoad() {
    const cats = Object.keys(CATEGORY_MAP).map((k) => ({ key: k, name: CATEGORY_MAP[k].name, icon: CATEGORY_MAP[k].icon }));
    const user = app.globalData.userInfo || {};
    const campus = user.campus || app.globalData.campus;
    const campusIndex = Math.max(0, CAMPUS_LIST.indexOf(campus));
    const collegeIndex = Math.max(0, ALL_COLLEGES.indexOf(user.college));
    this.setData({ cats, campus, campusIndex, collegeIndex });

    const draft = wx.getStorageSync('goodsDraft');
    if (draft) this.setData(draft);
    this.setData({ activeFields: ((app.globalData.config || {}).categories || []).find(c => c.code === this.data.cat)?.fields || [] });
  },

  goOcr() { wx.navigateTo({ url: '/pages/ocr/ocr' }); },

  onCat(e) { const cat = e.currentTarget.dataset.key; this.setData({ cat, attributes: {}, activeFields: (app.globalData.config.categories.find(c => c.code === cat) || {}).fields || [] }); },
  onAttribute(e) { this.setData({ ['attributes.' + e.currentTarget.dataset.field]: e.detail.value }); },
  onAttributeEnum(e) { const f = this.data.activeFields[Number(e.currentTarget.dataset.i)]; this.setData({ ['attributes.' + f.code]: f.options[Number(e.detail.value)] }); },
  onTrade(e) { this.setData({ tradeType: e.currentTarget.dataset.key }); },
  onBargain(e) { this.setData({ allowBargain: e.detail.value }); },
  onInput(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  onCondition(e) { const i = Number(e.detail.value); this.setData({ conditionIndex: i, condition: CONDITIONS[i] }); },
  onCampus(e) { const i = Number(e.detail.value); this.setData({ campusIndex: i, campus: CAMPUS_LIST[i] }); },
  onNote(e) { const i = Number(e.detail.value); this.setData({ noteIndex: i, noteLevel: NOTE_LEVELS[i] }); },
  onCollege(e) { this.setData({ collegeIndex: Number(e.detail.value) }); },

  chooseImages() {
    wx.chooseMedia({
      count: 9 - this.data.images.length,
      mediaType: ['image'],
      success: (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath);
        this.setData({ images: this.data.images.concat(paths) });
      }
    });
  },
  chooseInner() {
    wx.chooseMedia({
      count: 6 - this.data.innerPhotos.length,
      mediaType: ['image'],
      success: (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath);
        this.setData({ innerPhotos: this.data.innerPhotos.concat(paths) });
      }
    });
  },
  removeImage(e) {
    const arr = this.data.images.slice(); arr.splice(e.currentTarget.dataset.i, 1);
    this.setData({ images: arr });
  },
  removeInner(e) {
    const arr = this.data.innerPhotos.slice(); arr.splice(e.currentTarget.dataset.i, 1);
    this.setData({ innerPhotos: arr });
  },

  saveDraft() {
    wx.setStorageSync('goodsDraft', this.data);
    wx.showToast({ title: '草稿已保存', icon: 'success' });
  },

  uploadFiles(paths) { return Promise.all(paths.map(p => app.uploadFile(p))).then(rows => rows.map(r => r.fileID)); },

  onPublish() {
    const d = this.data;
    if (!d.title.trim()) return wx.showToast({ title: '请填写标题', icon: 'none' });
    const price = Number(d.price);
    if (d.tradeType === '定价' && (!price || price <= 0 || price > 9999)) return wx.showToast({ title: '请填写0.01至9999元的价格', icon: 'none' });
    if (!d.images.length) return wx.showToast({ title: '请上传至少1张实物图', icon: 'none' });
    if (d.cat === 'book' && d.noteLevel !== '无笔记' && !d.innerPhotos.length) return wx.showToast({ title: '有笔记须上传内页图', icon: 'none' });

    app.ensureProfile().then(() => {
      this.setData({ submitting: true });
      wx.showLoading({ title: '发布中' });
      Promise.all([
        this.uploadFiles(d.images, 'goods-images'),
        this.uploadFiles(d.innerPhotos, 'goods-inner')
      ]).then(([images, innerPhotos]) => {
        return app.call('goods', {
          action: 'publish', configVersion: app.globalData.config.version, attributes: d.attributes,
          cat: d.cat,
          tradeType: d.tradeType,
          allowBargain: d.allowBargain,
          title: d.title.trim(),
          desc: d.desc,
          price,
          condition: d.condition,
          campus: d.campus,
          images,
          isbn: d.isbn, author: d.author, publisher: d.publisher, edition: d.edition,
          college: d.colleges[d.collegeIndex],
          course: d.course,
          noteLevel: d.noteLevel, noteDesc: d.noteDesc, defects: d.defects,
          innerPhotos
        });
      }).then(() => {
        wx.hideLoading();
        wx.removeStorageSync('goodsDraft');
        wx.showToast({ title: '已提交审核', icon: 'success' });
        setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 800);
      }).catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: err.message || '发布失败', icon: 'none' });
      });
    }).catch(() => {});
  }
});
