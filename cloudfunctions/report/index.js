// 云函数：举报
// 对应需求：FR-P0-REP-01 举报、FR-P0-SAF-01 内容安全与治理
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { action, ...params } = event || {};
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: '未登录' };

  if (action === 'create') return create(params, OPENID);
  return { code: -1, msg: '未知操作' };
};

async function create(params, openid) {
  try {
    let goodsTitle = '';
    try {
      const g = await db.collection('goods').doc(params.goodsId).get();
      goodsTitle = g.data ? g.data.title : '';
    } catch (e) { /* 商品可能已删除 */ }

    const data = {
      _openid: openid,
      goodsId: params.goodsId,
      goodsTitle,
      reason: params.reason || '其他',
      detail: params.detail || '',
      reporterId: openid,
      status: 'pending',
      createdAt: Date.now()
    };
    await db.collection('reports').add({ data });
    return { code: 0, data: { _id: params.goodsId } };
  } catch (e) {
    console.error('report.create error:', e);
    return { code: -1, msg: '举报失败：' + e.message };
  }
}
