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
    submitting: false, previews:{}, offerDurationHours:'48', editorId:'', editorStatus:'', restriction:''
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

  async onShow() {
    this.setData({restriction:''});
    const id = app.editListingId;
    app.editListingId = '';
    try {
      const account = await app.refreshAccount();
      const error = app.capabilityError(account,'publish');
      if (error) { this.setData({restriction:error.message}); return; }
      if (!id) return;
      const g = await app.call('goods',{action:'editDetail',id});
      this.setData({...g,editorId:id,editorStatus:g.status,
        campusIndex:Math.max(0,CAMPUS_LIST.indexOf(g.campus)),
        conditionIndex:Math.max(0,CONDITIONS.indexOf(g.condition)),
        noteIndex:Math.max(0,NOTE_LEVELS.indexOf(g.noteLevel)),
        collegeIndex:Math.max(0,ALL_COLLEGES.indexOf(g.college)),
        activeFields:app.globalData.config.categories.find(c => c.code === g.cat)?.fields || []});
    } catch (error) {
      this.setData({restriction:error.message});
    }
  },

  cancelEdit() {
    this.setData({editorId:'',editorStatus:'',title:'',desc:'',price:'',images:[],innerPhotos:[],attributes:{},
      isbn:'',author:'',publisher:'',edition:'',course:'',noteDesc:'',defects:'',offerDurationHours:'48',submitting:false});
    this.onLoad();
  },

  async goOcr() {
    try {
      await app.ensureProfile('publish');
      wx.navigateTo({url:'/pages/ocr/ocr'});
    } catch (error) { app.showActionError(error); }
  },

  onSafety() { wx.navigateTo({url:'/pages/safety/safety'}); },

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

  saveDraft() { return this.submit('saveDraft'); },

  onPublish() {
    const d = this.data;
    if (!d.title.trim()) return app.showActionError(new Error('请填写标题'));
    const price = Number(d.price);
    if (d.tradeType === '定价' && (!price || price <= 0 || price > 9999)) {
      return app.showActionError(new Error('请填写0.01至9999元的价格'));
    }
    if (!d.images.length) return app.showActionError(new Error('请上传至少1张实物图'));
    if (d.cat === 'book' && d.noteLevel !== '无笔记' && !d.innerPhotos.length) {
      return app.showActionError(new Error('有笔记须上传内页图'));
    }
    return this.submit(d.editorStatus === 'on' ? 'edit' : 'publish');
  },

  async submit(action) {
    if (this.data.submitting) return;
    const d = this.data;
    this.setData({submitting:true});
    try {
      await app.ensureProfile('publish');
      wx.showLoading({title:'保存中'});
      const upload = paths => Promise.all(paths.map(async path => (await app.uploadFile(path)).fileID));
      const [images,innerPhotos] = await Promise.all([upload(d.images),upload(d.innerPhotos)]);
      const result = await app.call('goods',{
        action,id:d.editorId || undefined,configVersion:app.globalData.config.version,
        cat:d.cat,tradeType:d.tradeType,allowBargain:d.allowBargain,title:d.title.trim(),desc:d.desc,price:Number(d.price),
        condition:d.condition,campus:d.campus,images,innerPhotos,attributes:d.attributes,
        isbn:d.isbn,author:d.author,publisher:d.publisher,edition:d.edition,college:d.colleges[d.collegeIndex],
        course:d.course,noteLevel:d.noteLevel,noteDesc:d.noteDesc,defects:d.defects,offerDurationHours:Number(d.offerDurationHours)
      });
      wx.removeStorageSync('goodsDraft');
      if (action === 'saveDraft') {
        const draft = await app.call('goods',{action:'editDetail',id:result._id});
        this.setData({editorId:result._id,editorStatus:'draft',images,innerPhotos,previews:draft.previews});
      } else {
        this.cancelEdit();
      }
      wx.hideLoading();
      wx.showToast({title:action === 'saveDraft' ? '草稿已保存' : action === 'edit' ? '修改已保存' : '商品已上架'});
      if (action !== 'saveDraft') setTimeout(() => wx.switchTab({url:'/pages/index/index'}),600);
    } catch (error) {
      wx.hideLoading();
      app.showActionError(error);
    } finally {
      this.setData({submitting:false});
    }
  }
});
