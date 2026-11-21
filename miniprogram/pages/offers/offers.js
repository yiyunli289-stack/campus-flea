const app = getApp();
const { fmtTime, fmtPrice } = require('../../utils/format');
const {requestId,warmSubscription,subscribeTap} = require('../../utils/notifications');

const ST = {pending:'待处理',accepted:'已锁定',rejected:'未选中或已拒绝',cancelled:'已撤回',
  expired:'已到期',closed:'已关闭',completed:'已售出'};

Page({
  data: { tab: 'received', received: [], sent: [], subscriptionOptions:[] },

  onLoad(query) {
    this.goodsId = query.goodsId || '';
    this.setData({tab:query.tab === 'sent'?'sent':'received'});
  },
  onShow() { this.load(); warmSubscription(this,'trade'); },
  onSubscribe(e) { subscribeTap(this,e); },

  load() {
    app.ensureProfile().then(() => {
      app.call('offer', { action: 'received', goodsId: this.goodsId })
        .then((list) => this.setData({ received: this.deco(list) }))
        .catch(() => this.setData({ received: [] }));
      app.call('offer', { action: 'sent', goodsId: this.goodsId })
        .then((list) => this.setData({ sent: this.deco(list) }))
        .catch(() => this.setData({ sent: [] }));
    }).catch(() => {});
  },

  deco(list) {
    return list.map((o) => ({
      ...o,
      statusText: ST[o.status] || o.status,
      priceText: fmtPrice(o.price),
      timeText: fmtTime(o.createdAt)
    }));
  },

  onTab(e) { this.setData({ tab: e.currentTarget.dataset.tab }); },

  onAccept(e) {
    wx.showModal({
      title: '接受此报价？',
      content: '接受后商品将锁定给该买家，其他报价自动失效',
      success: (r) => {
        if (r.confirm) {
          app.call('offer', { action: 'accept', offerId: e.currentTarget.dataset.id })
            .then(() => { wx.showToast({ title: '已接受，交易锁定', icon: 'success' }); this.load(); })
            .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
        }
      }
    });
  },

  onCancel(e) {
    app.call('offer', { action: 'cancel', offerId: e.currentTarget.dataset.id })
      .then(() => this.load())
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  onOfferAction(e) {
    const {action,id} = e.currentTarget.dataset;
    const labels = {update:'修改报价',decline:'拒绝申请',cancelLock:'取消面交锁定',
      restoreListing:'恢复在售',confirmMeetup:'确认面交安排'};
    const editable = ['update','cancelLock'].includes(action);
    wx.showModal({title:labels[action],editable,
      placeholderText:action === 'update'?'新的报价金额':'填写取消原因',
      success:async result => {
        if (!result.confirm) return;
        const params = {action,offerId:id};
        if (action === 'update') {
          const key = JSON.stringify([id,result.content]);
          if (this.pendingUpdate?.key !== key) this.pendingUpdate = {key,id:requestId()};
          Object.assign(params,{price:Number(result.content),requestId:this.pendingUpdate.id});
        }
        if (action === 'cancelLock') params.reason = result.content || '';
        try {
          await app.call('offer',params);
          if (action === 'update') this.pendingUpdate = null;
          this.load();
        } catch (error) { wx.showToast({title:error.message,icon:'none'}); }
      }
    });
  },

  onChat(e) {
    app.call('chat', { action: 'open', goodsId: e.currentTarget.dataset.goodsId })
      .then((conv) => app.openChat(conv._id))
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  }
});
