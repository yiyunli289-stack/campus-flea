const app = getApp();
const { fmtTime } = require('../../utils/format');
const { withPageReload, reloadLatest } = require('../../utils/page-reload');

Page(withPageReload({
  data: { messages: [], other: {}, input: '', lastId: '' },

  onLoad(query) { this.id = query.id; },
  reload() {
    return reloadLatest(this,
      () => app.call('chat', { action: 'messages', conversationId: this.id }),
      (res) => {
        const me = app.globalData.userInfo ? app.globalData.userInfo._openid : '';
        const messages = res.messages.map((m) => ({
          ...m,
          timeText: fmtTime(m.createdAt),
          mine: m.fromId === me,
          sys: m.fromId === 'system'
        }));
        this.setData({ messages, other: res.other, lastId: 'm' + (messages.length - 1) });
      },
      (err) => wx.showToast({ title: err.message || '聊天加载失败', icon: 'none' })
    );
  },

  onInput(e) { this.setData({ input: e.detail.value }); },

  send() {
    const content = this.data.input.trim();
    if (!content) return;
    this.setData({ input: '' });
    app.call('chat', { action: 'send', conversationId: this.id, content })
      .then(() => this.reload())
      .catch((err) => wx.showToast({ title: err.message, icon: 'none' }));
  },

  callContact() {
    const c = this.data.other.contact;
    if (c) {
      wx.setClipboardData({ data: c, success: () => wx.showToast({ title: '联系方式已复制', icon: 'none' }) });
    } else {
      wx.showToast({ title: '成交锁定后可见联系方式', icon: 'none' });
    }
  }
}));
