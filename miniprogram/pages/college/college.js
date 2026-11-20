const { COLLEGE_GROUPS } = require('../../utils/colleges');
const app = getApp();
const feedbackFields = { title: '书名', isbn: 'ISBN', author: '作者', publisher: '出版社', edition: '版次', note: '备注' };
const levels = ['school','campus','college','major','grade','term','course'];

require('../../utils/page')({
  data: { groups: COLLEGE_GROUPS, college: '', rows: [], error: '', busy: false, total: 0,
    keyword: '', selection: {}, filters: [], bookVersion: '' },

  onCollege(e) {
    const name = e.currentTarget.dataset.name;
    this.setData({ college: name, rows: [], keyword: '', selection: {}, filters: [] });
    this.load();
  },
  backToColleges() { this.setData({ college: '', rows: [], busy: false }); },
  onKeyword(e) { this.setData({ keyword: e.detail.value }); },
  onFilter(e) {
    const key = e.currentTarget.dataset.key;
    const filter = this.data.filters.find(option => option.key===key);
    const selection = { ...this.data.selection, [key]: filter.values[Number(e.detail.value)] || '全部' };
    for (const lower of levels.slice(levels.indexOf(key)+1)) delete selection[lower];
    this.setData({ selection });
    this.load();
  },
  async load(append = false) {
    if (!this.data.college || (append && this.data.busy)) return;
    const request = (this.request || 0) + 1;
    this.request = request;
    const { college, keyword, selection } = this.data;
    this.setData({ busy: true, error: '' });
    try {
      const selected = Object.fromEntries(Object.entries(selection).filter(([,value]) => value!=='全部'));
      const result = await app.call('config', {
        action:'booklists', college, keyword, ...selected, offset: append ? this.data.rows.length : 0
      });
      if (request!==this.request || college!==this.data.college) return;
      this.setData({ rows: append ? this.data.rows.concat(result.rows) : result.rows,
        filters: result.filters, total: result.total, bookVersion: result.version });
    } catch (err) {
      if (request===this.request) this.setData({ error: err.message || '书单读取失败' });
    } finally {
      if (request===this.request) this.setData({ busy: false });
    }
  },
  refresh() { this.load(); },
  more() { this.load(true); },
  searchCollege() {
    wx.setStorageSync('searchCollege', this.data.college);
    wx.setStorageSync('searchBook', {});
    wx.setStorageSync('searchCat', 'book');
    wx.switchTab({ url: '/pages/search/search' });
  },
  searchBook(e) {
    const item = this.data.rows.find(row => row._id===e.currentTarget.dataset.id);
    if (!item) return;
    wx.setStorageSync('searchBook', { keyword: item.title, isbn: item.isbn, edition: item.edition });
    wx.switchTab({ url: '/pages/search/search' });
  },
  feedback(e) {
    const itemId = e.currentTarget.dataset.id;
    const keys = Object.keys(feedbackFields);
    wx.showActionSheet({ itemList:Object.values(feedbackFields), success: ({ tapIndex }) => {
      const field=keys[tapIndex];
      wx.showModal({ title:'建议修改'+feedbackFields[field], editable:true, placeholderText:'请输入正确内容',
        success: corrected => {
          if (!corrected.confirm || !corrected.content.trim()) return;
          wx.showModal({ title:'补充纠错依据', editable:true, placeholderText:'填写课程通知或其他来源',
            success: async reason => {
              if (!reason.confirm) return;
              try {
                await app.call('config',{action:'booklist.feedback',itemId,field,value:corrected.content,
                  note:reason.content,version:this.data.bookVersion});
                wx.showToast({ title:'反馈已提交' });
              } catch (err) { wx.showToast({title:err.message,icon:'none'}); }
            }
          });
        }
      });
    } });
  }
});
