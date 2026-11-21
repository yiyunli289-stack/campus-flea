function prepareAttempt(previous, openid, payload) {
  const key = JSON.stringify([openid, payload]);
  if (previous?.key === key) return previous;
  const random = () => Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return {key, requestId:[Date.now().toString(36), random(), random()].join('-')};
}

async function uploadPublishImages(attempt, openid, payload) {
  if (attempt.uploaded) return attempt.uploaded;
  const upload = (paths, prefix) => Promise.all(paths.map((path, index) => {
    if (path.startsWith('cloud://') || /^https?:\/\//.test(path)) return path;
    return wx.cloud.uploadFile({
      cloudPath:[prefix, openid, attempt.requestId + '-' + index + '.jpg'].join('/'),
      filePath:path
    }).then(result => result.fileID);
  }));
  const [images, innerPhotos] = await Promise.all([
    upload(payload.images || [], 'goods-images'),
    upload(payload.innerPhotos || [], 'goods-inner')
  ]);
  attempt.uploaded = {...payload, images, innerPhotos};
  return attempt.uploaded;
}

function confirmDuplicate(matches) {
  const titles = matches.slice(0, 3).map(item => '「' + String(item.title || '未命名商品').slice(0, 36) + '」');
  return new Promise((resolve, reject) => wx.showModal({
    title:'可能重复发布',
    content:'你已有相似商品在售：' + titles.join('、') + '。确定继续发布？',
    confirmText:'继续发布',
    cancelText:'取消',
    success:result => resolve(result.confirm === true),
    fail:reject
  }));
}

async function submitGoods(app, attempt) {
  let confirmation;
  for (let request = 0; request < 3; request++) {
    wx.showLoading({title:'发布中', mask:true});
    try {
      const result = await app.call('goods', {
        ...attempt.uploaded, action:'publish', requestId:attempt.requestId,
        ...(confirmation ? {duplicateConfirmation:confirmation} : {})
      });
      if (!result?._id) throw new Error('发布结果未确认，请重试');
      return result;
    } catch (error) {
      const warning = error.rawResult;
      if (warning?.errCode !== 'DUPLICATE_PUBLISH' || !Array.isArray(warning.data?.matches) ||
          !warning.data.confirmation) throw error;
      wx.hideLoading();
      if (request === 2) break;
      if (!await confirmDuplicate(warning.data.matches)) return null;
      confirmation = warning.data.confirmation;
    } finally {
      wx.hideLoading();
    }
  }
  throw new Error('相似商品已变化，请重新提交');
}

module.exports = {prepareAttempt, uploadPublishImages, submitGoods};
