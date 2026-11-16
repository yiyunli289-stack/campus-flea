const app = getApp();

function cleanIsbn(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^0-9X]/g, '');
}

Page({
  data: {
    images: [],
    scanList: [],
    manualIsbn: '',
    processing: false
  },

  chooseImages() {
    wx.chooseMedia({
      count: 3 - this.data.images.length,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath);
        this.setData({ images: this.data.images.concat(paths) });
      }
    });
  },

  removeImage(e) {
    const arr = this.data.images.slice();
    arr.splice(e.currentTarget.dataset.i, 1);
    this.setData({ images: arr });
  },

  // 路线 C：ISBN 连续扫码，扫完立刻查书名
  scanIsbn() {
    const loop = () => {
      wx.scanCode({
        scanType: ['barCode'],
        success: async (r) => {
          const isbn = cleanIsbn(r.result);
          if (isbn.length < 10) {
            wx.showToast({ title: '不是有效的 ISBN 条码', icon: 'none' });
            return loop();
          }

          const list = this.data.scanList.slice();
          list.push({ key: 'k' + Date.now(), isbn, title: '', loading: true });
          const idx = list.length - 1;
          this.setData({ scanList: list });

          const book = this._lookupBroken ? null : await this.fillByIsbn(isbn, idx);
          const cur = this.data.scanList[idx] || {};
          const found = !!(book && book.found);

          wx.showModal({
            title: found ? '已找到：' + (cur.title || '') : '已添加 ISBN ' + isbn,
            content: found
              ? '作者：' + (cur.author || '未知') + '\n继续扫下一本？'
              : '书目库未收录这本，可稍后在确认页手填书名。\n继续扫下一本？',
            confirmText: '继续',
            cancelText: '完成',
            success: (m) => {
              if (m.confirm) loop();
              else this.goReview(this.data.scanList, 'scan');
            }
          });
        },
        fail: () => {
          if (this.data.scanList.length) this.goReview(this.data.scanList, 'scan');
        }
      });
    };
    loop();
  },

  onManualInput(e) {
    this.setData({ manualIsbn: e.detail.value });
  },

  // 手动输入 ISBN 查询（扫码不方便时用）
  manualLookup() {
    const isbn = cleanIsbn(this.data.manualIsbn);
    if (isbn.length < 10) {
      return wx.showToast({ title: '请输入 10 或 13 位 ISBN', icon: 'none' });
    }
    const list = this.data.scanList.slice();
    const idx = list.length;
    list.push({ key: 'k' + Date.now(), isbn, title: '', loading: true });
    this.setData({ scanList: list, manualIsbn: '' });

    wx.showLoading({ title: '查询中', mask: true });
    this.fillByIsbn(isbn, idx).then((b) => {
      wx.hideLoading();
      if (b && b.found) wx.showToast({ title: '已找到：' + b.title, icon: 'none' });
      else if (b) wx.showToast({ title: b.note || '未收录，可手填书名', icon: 'none' });
    });
  },

  // 查询单本 ISBN，并回填到 scanList[index]
  fillByIsbn(isbn, index) {
    return app
      .call('ocr', { action: 'isbnLookup', isbn })
      .then((b) => {
        const patch = { ['scanList[' + index + '].loading']: false };
        if (b && b.found) {
          patch['scanList[' + index + '].title'] = b.title || '';
          patch['scanList[' + index + '].author'] = b.author || '';
          patch['scanList[' + index + '].publisher'] = b.publisher || '';
          patch['scanList[' + index + '].pubDate'] = b.pubDate || '';
          patch['scanList[' + index + '].cover'] = b.coverFileID || '';
        } else if (b) {
          patch['scanList[' + index + '].note'] = b.note || '未收录';
        }
        this.setData(patch);
        return b;
      })
      .catch((e) => {
        this.setData({ ['scanList[' + index + '].loading']: false });
        if (e && e.friendly) this._lookupBroken = true;
        this.showError(e);
        return null;
      });
  },

  // 路线 A：拍照识别
  recognize() {
    if (!this.data.images.length) {
      return wx.showToast({ title: '请先选择书脊照片', icon: 'none' });
    }
    app.ensureProfile().then(async () => {
      this.setData({ processing: true });
      wx.showLoading({ title: '识别中', mask: true });
      const openid = (app.globalData.userInfo && app.globalData.userInfo._openid) || 'u';
      let all = [];
      try {
        for (let i = 0; i < this.data.images.length; i++) {
          const up = await wx.cloud.uploadFile({
            cloudPath: 'ocr/' + openid + '/' + Date.now() + '-' + i + '.jpg',
            filePath: this.data.images[i]
          });
          const r = await app.call('ocr', { action: 'ocrImage', fileID: up.fileID });
          all = all.concat(r.books || []);
        }
      } catch (e) {
        wx.hideLoading();
        this.setData({ processing: false });
        return this.showError(e);
      }
      wx.hideLoading();
      this.setData({ processing: false });
      if (!all.length) {
        return wx.showToast({ title: '没识别到图书，请让书脊横向、清晰后重拍', icon: 'none' });
      }
      // OCR 从书脊上抓到的 ISBN，用书目库补齐书名/作者/封面
      this.enrichAll(all).then(() => this.goReview(all, 'ocr'));
    }).catch(() => {});
  },

  enrichAll(list) {
    if (this._lookupBroken) return Promise.resolve();
    const targets = list.filter((b) => b.isbn && (!b.title || b.title.length < 4)).slice(0, 8);
    if (!targets.length) return Promise.resolve();

    wx.showLoading({ title: '补全书目', mask: true });
    return Promise.all(
      targets.map((b) =>
        app
          .call('ocr', { action: 'isbnLookup', isbn: b.isbn })
          .then((d) => {
            if (!d || !d.found) return;
            if (!b.title) b.title = d.title;
            b.author = b.author || d.author;
            b.publisher = b.publisher || d.publisher;
            if (d.coverFileID) b.coverFileID = d.coverFileID;
          })
          .catch(() => {})
      )
    ).then(() => wx.hideLoading());
  },

  showError(e) {
    if (e && e.friendly) {
      wx.showModal({ title: '云函数不可用', content: e.friendly, showCancel: false });
    } else {
      wx.showToast({ title: (e && (e.message || e.errMsg)) || '操作失败', icon: 'none' });
    }
  },

  goReview(list, source) {
    wx.setStorageSync('ocrCandidates', { list, source });
    wx.navigateTo({ url: '/pages/ocr-review/ocr-review' });
  }
});
