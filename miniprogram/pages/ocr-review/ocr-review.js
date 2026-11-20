const app = getApp();
const { CAMPUS_LIST, CONDITIONS, NOTE_LEVELS } = require('../../utils/constants');
const { ALL_COLLEGES } = require('../../utils/colleges');

require('../../utils/page')({
  data: {
    list: [],
    source: '',
    noteLevels: NOTE_LEVELS,
    campusList: CAMPUS_LIST,
    campusIndex: 0,
    conditions: CONDITIONS,
    conditionIndex: 1,
    colleges: ALL_COLLEGES,
    collegeIndex: 0,
    batchPrice: '',
    publishing: false
  },

  onShow() {
    app.refreshAccount()
      .then(user => this.setData({restriction:app.capabilityError(user,'publish')?.message || ''}))
      .catch(error => this.setData({restriction:error.message}));
  },

  onLoad() {
    const saved = wx.getStorageSync('ocrCandidates') || { list: [], source: '' };
    const user = app.globalData.userInfo || {};
    const list = (saved.list || []).map((b, i) => ({
      id: 'c' + i + '_' + Date.now(),
      title: b.title || '',
      author: b.author || '',
      publisher: b.publisher || '',
      edition: b.edition || '',
      isbn: b.isbn || '',
      price: '',
      noteLevel: '',
      rawText: (b.raw || []).join(' / '), images: b.images || [], innerPhotos: b.innerPhotos || []
    }));
    this.setData({
      list,
      source: saved.source || '',
      campusIndex: Math.max(0, CAMPUS_LIST.indexOf(user.campus || app.globalData.campus)),
      collegeIndex: Math.max(0, ALL_COLLEGES.indexOf(user.college))
    });
  },

  chooseBookImages(e) { const i = Number(e.currentTarget.dataset.i); const field = e.currentTarget.dataset.kind; wx.chooseMedia({ count: 3, mediaType: ['image'], success: r => this.setData({ ['list[' + i + '].' + field]: r.tempFiles.map(f => f.tempFilePath) }) }); },
  onItemInput(e) {
    const i = e.currentTarget.dataset.i;
    const field = e.currentTarget.dataset.field;
    this.setData({ ['list[' + i + '].' + field]: e.detail.value });
  },

  onNote(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ ['list[' + i + '].noteLevel']: e.currentTarget.dataset.level });
  },

  onDelete(e) {
    const list = this.data.list.slice();
    list.splice(e.currentTarget.dataset.i, 1);
    this.setData({ list });
  },

  onBatchCampus(e) { this.setData({ campusIndex: Number(e.detail.value) }); },
  onBatchCond(e) { this.setData({ conditionIndex: Number(e.detail.value) }); },
  onBatchCollege(e) { this.setData({ collegeIndex: Number(e.detail.value) }); },
  onBatchPrice(e) { this.setData({ batchPrice: e.detail.value }); },

  applyBatch() {
    const p = this.data.batchPrice;
    if (!p || !(Number(p) > 0)) return wx.showToast({ title: '请输入统一价格', icon: 'none' });
    this.setData({ list: this.data.list.map((it) => ({ ...it, price: p })) });
    wx.showToast({ title: '已应用到全部', icon: 'success' });
  },

  onPublish() {
    const list = this.data.list;
    if (!list.length) return wx.showToast({ title: '没有可发布的图书', icon: 'none' });

    for (let i = 0; i < list.length; i++) {
      if (!list[i].title.trim()) return wx.showToast({ title: '第 ' + (i + 1) + ' 本缺书名', icon: 'none' });
      if (!list[i].images.length || (list[i].noteLevel !== '无笔记' && !list[i].innerPhotos.length)) return wx.showToast({ title: '第 ' + (i + 1) + ' 本缺实物或内页图', icon: 'none' });
      if (!list[i].noteLevel) return wx.showToast({ title: '第 ' + (i + 1) + ' 本请确认笔记等级', icon: 'none' });
      if (!(Number(list[i].price) > 0)) return wx.showToast({ title: '第 ' + (i + 1) + ' 本缺价格', icon: 'none' });
    }

    const campus = this.data.campusList[this.data.campusIndex];
    const condition = this.data.conditions[this.data.conditionIndex];
    const college = this.data.colleges[this.data.collegeIndex];

    app.ensureProfile('publish').then(async () => {
      this.setData({ publishing: true });
      wx.showLoading({ title: '发布中', mask: true });
      let ok = 0;
      const fail = [];
      for (const it of list) {
        try {
          it.images = await Promise.all(it.images.map(f => app.uploadFile(f).then(r => r.fileID)));
          it.innerPhotos = await Promise.all(it.innerPhotos.map(f => app.uploadFile(f).then(r => r.fileID)));
          await app.call('goods', {
            action: 'publish',
            cat: 'book',
            tradeType: '定价',
            allowBargain: true,
            title: it.title.trim(),
            price: Number(it.price),
            condition,
            campus,
            images: it.images, innerPhotos: it.innerPhotos,
            isbn: it.isbn,
            author: it.author,
            publisher: it.publisher,
            edition: it.edition,
            college,
            course: '',
            noteLevel: it.noteLevel,
            noteDesc: '',
            defects: ''
          });
          ok++;
        } catch (e) {
          fail.push({ ...it, error: e.message });
        }
      }
      wx.hideLoading();
      this.setData({ publishing: false });
      if (fail.length) wx.setStorageSync('ocrCandidates', { list: fail, source: this.data.source }); else wx.removeStorageSync('ocrCandidates');
      wx.showModal({
        title: '提交审核完成',
        content: '成功 ' + ok + ' 本' + (fail.length ? '，失败 ' + fail.length + ' 本：' + fail.slice(0, 3).map(x => x.title + '：' + x.error).join('、') : ''),
        showCancel: false,
        success: () => wx.redirectTo({ url: '/pages/my-goods/my-goods' })
      });
    }).catch(() => {});
  }
});
