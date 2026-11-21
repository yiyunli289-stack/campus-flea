const app = getApp();
const { CAMPUS_LIST, CONDITIONS, NOTE_LEVELS } = require('../../utils/constants');
const { ALL_COLLEGES } = require('../../utils/colleges');
const {prepareAttempt, uploadPublishImages, submitGoods} = require('../../utils/publish-goods');

Page({
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

  onLoad() {
    const saved = wx.getStorageSync('ocrCandidates') || { list: [], source: '' };
    const user = app.globalData.userInfo || {};
    const list = (saved.list || []).map((b, i) => ({
      id: b.id || 'c' + i + '_' + Date.now(),
      title: b.title || '',
      author: b.author || '',
      publisher: b.publisher || '',
      edition: b.edition || '',
      isbn: b.isbn || '',
      cover: b.coverFileID || b.cover || '',
      pubDate: b.pubDate || '',
      price: b.price ?? '',
      noteLevel: b.noteLevel || '',
      rawText: b.rawText || (b.raw || []).join(' / '),
      images: Array.isArray(b.images) ? b.images : []
    }));
    this.publishAttempts = saved.publishAttempts || {};
    this.setData({
      list,
      source: saved.source || '',
      campusIndex: saved.campusIndex ?? Math.max(0, CAMPUS_LIST.indexOf(user.campus || app.globalData.campus)),
      conditionIndex: saved.conditionIndex ?? 1,
      collegeIndex: saved.collegeIndex ?? Math.max(0, ALL_COLLEGES.indexOf(user.college))
    });
  },

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
    if (this.data.publishing) return;
    const [removed] = list.splice(e.currentTarget.dataset.i, 1);
    if (removed) delete this.publishAttempts[removed.id];
    this.setData({list});
    this.storeBatch();
  },

  onChoosePhotos(e) {
    const i = Number(e.currentTarget.dataset.i);
    const item = this.data.list[i];
    if (!item || this.data.publishing || item.images.length >= 9) return;
    wx.chooseMedia({count:9-item.images.length, mediaType:['image'], sizeType:['compressed'],
      success:result => {
        const current = this.data.list[i];
        if (current?.id !== item.id || this.data.publishing) return;
        const images = [...current.images, ...result.tempFiles.map(file => file.tempFilePath)];
        this.setData({['list[' + i + '].images']:images});
        this.storeBatch();
      }
    });
  },

  onRemovePhoto(e) {
    const {i, photo} = e.currentTarget.dataset;
    if (this.data.publishing) return;
    const images = this.data.list[i].images.filter((_, index) => index !== Number(photo));
    this.setData({['list[' + i + '].images']:images});
    this.storeBatch();
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

  storeBatch() {
    const {list,source,campusIndex,conditionIndex,collegeIndex} = this.data;
    if (!list.length) {
      wx.removeStorageSync('ocrCandidates');
      return;
    }
    wx.setStorageSync('ocrCandidates',{list,source,campusIndex,conditionIndex,collegeIndex,
      publishAttempts:this.publishAttempts});
  },

  async onPublish() {
    if (this.data.publishing) return;
    const list = this.data.list.slice();
    if (!list.length) return wx.showToast({title:'没有可发布的图书', icon:'none'});

    for (let i = 0; i < list.length; i++) {
      if (!list[i].title.trim()) return wx.showToast({title:'第 ' + (i + 1) + ' 本缺书名', icon:'none'});
      if (!list[i].noteLevel) return wx.showToast({title:'第 ' + (i + 1) + ' 本请确认笔记等级', icon:'none'});
      if (!(Number(list[i].price) > 0)) return wx.showToast({title:'第 ' + (i + 1) + ' 本缺价格', icon:'none'});
    }

    const campus = this.data.campusList[this.data.campusIndex];
    const condition = this.data.conditions[this.data.conditionIndex];
    const college = this.data.colleges[this.data.collegeIndex];
    this.setData({publishing:true});

    let ok = 0;
    let skipped = 0;
    const failed = [];
    try {
      const user = await app.ensureProfile();
      for (const item of list) {
        const payload = {
          cat:'book', tradeType:'定价', allowBargain:true, title:item.title.trim(),
          price:Number(item.price), condition, campus,
          images:item.images.length ? item.images : item.cover ? [item.cover] : [],
          isbn:item.isbn, author:item.author, publisher:item.publisher, edition:item.edition,
          college, course:'', noteLevel:item.noteLevel, noteDesc:'', defects:''
        };
        const attempt = prepareAttempt(this.publishAttempts[item.id],user._openid,payload);
        this.publishAttempts[item.id] = attempt;
        try {
          wx.showLoading({title:'发布中', mask:true});
          await uploadPublishImages(attempt,user._openid,payload);
          this.storeBatch();
          if (await submitGoods(app,attempt)) {
            ok++;
            delete this.publishAttempts[item.id];
            this.setData({list:this.data.list.filter(row => row.id !== item.id)});
          } else {
            skipped++;
          }
        } catch (error) {
          failed.push({title:item.title, reason:error.friendly || error.message || '发布失败'});
        } finally {
          wx.hideLoading();
          this.storeBatch();
        }
      }
    } catch (error) {
      if (error.message !== '请先完善资料') {
        wx.showToast({title:error.friendly || error.message || '登录失败', icon:'none'});
      }
      return;
    } finally {
      this.setData({publishing:false});
    }

    const summary = '成功 ' + ok + ' 本，跳过 ' + skipped + ' 本，失败 ' + failed.length + ' 本';
    const detail = failed.length ? '。' + failed[0].title + '：' + failed[0].reason : '';
    wx.showModal({
      title:'批量发布结果',
      content:summary + detail + (this.data.list.length ? '。未发布条目已保留。' : ''),
      showCancel:false,
      success:() => { if (!this.data.list.length) wx.redirectTo({url:'/pages/my-goods/my-goods'}); }
    });
  }
});
