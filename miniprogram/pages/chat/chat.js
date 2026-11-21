const app = getApp();
const { fmtTime } = require('../../utils/format');
const {requestId,warmSubscription,subscribeTap} = require('../../utils/notifications');

Page({
  data: { messages: [], other: {}, input: '', lastId: '', canSend:false,subscriptionOptions:[] },

  onLoad(query) { this.id = query.id; },
  onShow() {
    this.load();
    warmSubscription(this,'chat');
    this.timer = setInterval(() => this.load(),15000);
  },
  onHide() { clearInterval(this.timer); },
  onUnload() { clearInterval(this.timer); },
  onSubscribe(e) { subscribeTap(this,e); },

  load() {
    app.call('chat', { action: 'messages', conversationId: this.id })
      .then((res) => {
        const me = app.globalData.userInfo ? app.globalData.userInfo._openid : '';
        const messages = res.messages.map((m) => ({
          ...m,
          timeText: fmtTime(m.createdAt),
          mine: m.fromId === me,
          sys: m.fromId === 'system'
        }));
        this.offerContext = res.offerContext;
        this.setData({ messages, other: res.other, canSend:res.canSend !== false, lastId: 'm' + (messages.length - 1) });
      })
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  onOpenOffer() {
    const context = this.offerContext;
    if (context) wx.navigateTo({url:'/pages/offers/offers?goodsId='+encodeURIComponent(context.goodsId)+'&tab='+context.tab});
  },

  onInput(e) { this.setData({ input: e.detail.value }); },

  async send() {
    const content = this.data.input.trim();
    if (!content || !this.data.canSend || this.sending) return;
    if (this.pendingMessage?.content !== content) this.pendingMessage = {content,id:requestId()};
    this.sending = true;
    try {
      await app.call('chat',{action:'send',conversationId:this.id,content,requestId:this.pendingMessage.id});
      this.pendingMessage = null;
      if (this.data.input.trim() === content) this.setData({input:''});
      this.load();
    } catch (error) { wx.showToast({title:error.message,icon:'none'}); }
    finally { this.sending = false; }
  },

  callContact() {
    const c = this.data.other.contact;
    if (c) {
      wx.setClipboardData({ data: c, success: () => wx.showToast({ title: '联系方式已复制', icon: 'none' }) });
    } else {
      wx.showToast({ title: '成交锁定后可见联系方式', icon: 'none' });
    }
  }
});
