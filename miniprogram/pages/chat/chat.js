const app = getApp();
const { fmtTime } = require('../../utils/format');

require('../../utils/page')({
  data: { messages: [], other: {}, input: '', lastId: '', canSend: false, state: '' },

  onLoad(query) { this.id = query.id; },
  onShow() { this.load(); },

  load() {
    this.setData({canSend:false,other:{},canShareContact:false});
    app.call('chat', { action: 'messages', conversationId: this.id })
      .then((res) => {
        const me = app.globalData.userInfo ? app.globalData.userInfo._openid : '';
        const messages = res.messages.map((m) => ({
          ...m,
          timeText: fmtTime(m.createdAt),
          mine: m.fromId === me,
          sys: m.fromId === 'system'
        }));
        this.setData({ messages, other: res.other, canSend: res.canSend, state: res.state, stateText:({locked:'已锁定',off:'商品已下架',sold:'商品已售出',removed:'商品已违规下架',deleted:'商品已删除',readonly:'当前会话只读'})[res.state] || '', canShareContact:res.canShareContact, contactConfirmed:res.contactConfirmed, lastId: 'm' + (messages.length - 1) });
      })
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  onReportMessage(e) { require('../../utils/governance').report('messages', e.currentTarget.dataset.id); },
  onInput(e) { this.setData({ input: e.detail.value }); },

  send() {
    const content = this.data.input.trim();
    if (!content || !this.data.canSend) return;
    this.setData({ input: '' });
    app.call('chat', { action: 'send', conversationId: this.id, content })
      .then(() => this.load())
      .catch(err => { this.load(); app.showActionError(err); });
  },

  shareContact() {
    const confirm = !this.data.contactConfirmed;
    wx.showModal({title:confirm?'同意交换联系方式？':'撤回联系方式授权？',content:'双方同意后可查看完整联系方式。',success:async result => {
      if (!result.confirm) return;
      try { await app.call('chat',{action:'shareContact',conversationId:this.id,confirm}); this.load(); }
      catch (error) { app.showActionError(error); }
    }});
  },

  async callContact() {
    let c;
    try { c = (await app.call('chat',{action:'messages',conversationId:this.id})).other.contact; }
    catch (error) { app.showActionError(error); return; }
    if (c) {
      wx.setClipboardData({ data: c, success: () => wx.showToast({ title: '联系方式已复制', icon: 'none' }) });
    } else {
      wx.showToast({ title: '成交锁定后可见联系方式', icon: 'none' });
    }
  }
});
