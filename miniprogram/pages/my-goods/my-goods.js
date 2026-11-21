const app = getApp();
const { decorateGoods, fmtTime } = require('../../utils/format');
const {CONDITIONS,NOTE_LEVELS} = require('../../utils/constants');

Page({
  data: {
    list: [],
    statusText: { on: '在售', locked: '已锁定', sold: '已成交', off: '已下架' }
  },

  onShow() { this.load(); },

  load() {
    app.ensureProfile().then(() => {
      app.call('goods', { action: 'myGoods' })
        .then((list) => {
          const items = decorateGoods(list).map((g) => ({ ...g, timeText: fmtTime(g.createdAt) }));
          this.setData({ list: items });
        })
        .catch(() => this.setData({ list: [] }));
    }).catch(() => this.setData({ list: [] }));
  },

  goDetail(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id }); },

  onOffers(e) { wx.navigateTo({ url: '/pages/offers/offers?goodsId=' + e.currentTarget.dataset.id }); },

  onEdit(e) {
    const listing = this.data.list.find(item=>item._id === e.currentTarget.dataset.id);
    if (!listing) return;
    const fields = [['title','标题'],['price','价格'],['condition','成色'],['offerDurationHours','报价有效期（小时）']];
    if (listing.cat === 'book') fields.push(['noteLevel','笔记等级'],['noteDesc','笔记说明'],['defects','缺损']);
    wx.showActionSheet({itemList:fields.map(row=>row[1]),success:result=>{
      const [key,label] = fields[result.tapIndex];
      const choices = key === 'condition' ? CONDITIONS : key === 'noteLevel' ? NOTE_LEVELS : null;
      const submit = async value => {
        try { await app.call('goods',{action:'edit',id:listing._id,[key]:value}); this.load(); }
        catch (error) { wx.showToast({title:error.message,icon:'none'}); }
      };
      if (choices) wx.showActionSheet({itemList:choices,success:item=>submit(choices[item.tapIndex])});
      else wx.showModal({title:'修改'+label,editable:true,content:String(listing[key] ?? (key === 'offerDurationHours'?48:'')),
        success:edit=>{if (edit.confirm) submit(edit.content || '');}});
    }});
  },

  onOffShelf(e) {
    app.call('goods', { action: 'offShelf', id: e.currentTarget.dataset.id })
      .then(() => this.load())
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  onRelist(e) {
    app.call('goods', { action: 'relist', id: e.currentTarget.dataset.id })
      .then(() => this.load())
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  onDelete(e) {
    wx.showModal({
      title: '删除这件商品？',
      content: '删除后不可恢复，重复发布的多余商品可以这样清理',
      confirmColor: '#B4100A',
      success: (r) => {
        if (!r.confirm) return;
        app.call('goods', { action: 'remove', id: e.currentTarget.dataset.id })
          .then(() => this.load())
          .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
      }
    });
  },

  onComplete(e) {
    wx.showModal({
      title: '确认成交？',
      content: '确认后商品标记为已成交',
      success: (r) => {
        if (r.confirm) {
          app.call('goods', { action: 'complete', id: e.currentTarget.dataset.id })
            .then(() => this.load())
            .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
        }
      }
    });
  }
});
