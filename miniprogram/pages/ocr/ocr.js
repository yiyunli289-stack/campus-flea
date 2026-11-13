const app = getApp();

Page({
  data: {
    images: [],
    scanList: [],
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

  // 路线 C：ISBN 连续扫码
  scanIsbn() {
    const list = this.data.scanList.slice();
    const loop = () => {
      wx.scanCode({
        scanType: ['barCode'],
        success: (r) => {
          const isbn = (r.result || '').replace(/[^0-9Xx]/g, '');
          if (isbn.length >= 10) list.push({ isbn });
          this.setData({ scanList: list });
          wx.showModal({
            title: '已添加 ' + list.length + ' 本',
            content: '继续扫下一本？',
            confirmText: '继续',
            cancelText: '完成',
            success: (m) => {
              if (m.confirm) loop();
              else this.goReview(list, 'scan');
            }
          });
        },
        fail: () => {
          if (list.length) this.goReview(list, 'scan');
        }
      });
    };
    loop();
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
        return wx.showToast({ title: e.message || '识别失败', icon: 'none' });
      }
      wx.hideLoading();
      this.setData({ processing: false });
      if (!all.length) {
        return wx.showToast({ title: '没识别到图书，请让书脊横向、清晰后重拍', icon: 'none' });
      }
      this.goReview(all, 'ocr');
    }).catch(() => {});
  },

  goReview(list, source) {
    wx.setStorageSync('ocrCandidates', { list, source });
    wx.navigateTo({ url: '/pages/ocr-review/ocr-review' });
  }
});
