const app = getApp();
const {fmtTime} = require('../../utils/format');
const {warmSubscription,subscribeTap} = require('../../utils/notifications');

const decorate = record => ({...record,timeText:fmtTime(record.createdAt)});

Page({
  data:{list:[],selected:null,loading:false,hasMore:true,subscriptionOptions:[],subscriptionReady:false,error:''},

  onLoad(query) { this.targetId = query.id || ''; },
  onShow() {
    this.load(0);
    warmSubscription(this);
    if (this.targetId) {
      const id = this.targetId;
      this.targetId = '';
      app.call('notification',{action:'read',id})
        .then(record => {
          this.setData({selected:decorate(record),list:this.data.list.map(row=>row._id === id?decorate(record):row)});
          app.refreshUnread();
        })
        .catch(error=>this.setData({error:error.message || '该通知暂不可用'}));
    }
  },
  onSubscribe(e) { subscribeTap(this,e); },
  onReachBottom() { if (this.data.hasMore) this.load(this.loaded || 0); },
  async load(skip) {
    if (this.data.loading) return;
    this.setData({loading:true,error:''});
    try {
      const rows = await app.call('notification',{action:'list',skip});
      const list = skip ? this.data.list : [];
      const seen = new Set(list.map(row=>row._id));
      this.loaded = skip + rows.length;
      this.setData({list:list.concat(rows.filter(row=>!seen.has(row._id)).map(decorate)),hasMore:rows.length === 30});
    } catch (error) {
      this.setData({error:error.message || '通知暂未加载'});
    } finally { this.setData({loading:false}); }
  },
  async onRead(e) {
    const id = e.currentTarget.dataset.id;
    try {
      const n = decorate(await app.call('notification',{action:'read',id}));
      this.setData({selected:n,list:this.data.list.map(row=>row._id === id ? n : row)});
      app.refreshUnread();
    } catch (error) { wx.showToast({title:error.message || '通知暂不可用',icon:'none'}); }
  },
  onOpen() {
    const n = this.data.selected;
    if (!n) return;
    if (n.conversationId) app.openChat(n.conversationId);
    else if (n.offerId && n.goodsId) {
      const tab = ['offer.created','offer.bid','offer.updated','offer.withdrawn'].includes(n.type)?'received':'sent';
      wx.navigateTo({url:'/pages/offers/offers?goodsId='+encodeURIComponent(n.goodsId)+'&tab='+tab});
    } else if (n.goodsId) wx.navigateTo({url:'/pages/detail/detail?id='+encodeURIComponent(n.goodsId)});
  }
});
