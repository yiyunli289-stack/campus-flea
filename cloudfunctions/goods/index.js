// 云函数：商品（发布/搜索/详情/我的/状态流转/演示数据）
// 对应需求：FR-P0-PUB-01 发布、FR-P0-SEA-01 搜索筛选、FR-P0-SEL-03 卖家择一状态机
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { action, ...params } = event || {};
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: '未登录' };

  switch (action) {
    case 'publish': return publish(params, OPENID);
    case 'search': return search(params);
    case 'detail': return detail(params);
    case 'myGoods': return myGoods(OPENID);
    case 'offShelf': return setStatus(params, OPENID, 'off');
    case 'relist': return setStatus(params, OPENID, 'on');
    case 'complete': return complete(params, OPENID);
    case 'seed': return seed();
    default: return { code: -1, msg: '未知操作' };
  }
};

async function getUser(openid) {
  const r = await db.collection('users').where({ _openid: openid }).get();
  return r.data[0] || {};
}

async function publish(params, openid) {
  try {
    const user = await getUser(openid);
    if (!(user.nickName && user.campus && user.contact)) {
      return { code: -1, msg: '请先完善资料' };
    }
    const now = Date.now();
    const data = {
      _openid: openid,
      sellerId: openid,
      sellerName: user.nickName,
      sellerAvatar: user.avatarUrl || '',
      sellerCollege: user.college || '',
      cat: params.cat,
      tradeType: params.tradeType === '竞价' ? '竞价' : '定价',
      allowBargain: !!params.allowBargain,
      title: params.title,
      desc: params.desc || '',
      price: Number(params.price) || 0,
      condition: params.condition || '几乎全新',
      campus: params.campus || user.campus,
      images: params.images || [],
      status: 'on',
      buyerId: '',
      dealPrice: null,
      viewCount: 0,
      createdAt: now,
      updatedAt: now
    };
    if (params.cat === 'book') {
      Object.assign(data, {
        isbn: params.isbn || '',
        author: params.author || '',
        publisher: params.publisher || '',
        edition: params.edition || '',
        college: params.college || '',
        course: params.course || '',
        noteLevel: params.noteLevel || '无笔记',
        noteDesc: params.noteDesc || '',
        defects: params.defects || '',
        innerPhotos: params.innerPhotos || []
      });
    }
    const addRes = await db.collection('goods').add({ data });
    return { code: 0, data: { _id: addRes._id } };
  } catch (e) {
    console.error('publish error:', e);
    return { code: -1, msg: '发布失败：' + e.message };
  }
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function search(params) {
  try {
    const where = { status: 'on' };
    if (params.cat) where.cat = params.cat;
    if (params.campus) where.campus = params.campus;
    if (params.tradeType) where.tradeType = params.tradeType;
    if (params.condition) where.condition = params.condition;
    if (params.college) where.college = params.college;
    if (params.keyword) where.title = db.RegExp({ regexp: esc(params.keyword), options: 'i' });

    const mn = Number(params.priceMin);
    const mx = Number(params.priceMax);
    const pc = [];
    if (!isNaN(mn) && mn > 0) pc.push(_.gte(mn));
    if (!isNaN(mx) && mx > 0) pc.push(_.lte(mx));
    if (pc.length === 1) where.price = pc[0];
    else if (pc.length === 2) where.price = _.and(pc[0], pc[1]);

    const res = await db.collection('goods').where(where).orderBy('createdAt', 'desc')
      .skip(params.skip || 0).limit(50).get();
    return { code: 0, data: res.data };
  } catch (e) {
    console.error('search error:', e);
    return { code: -1, msg: '搜索失败：' + e.message };
  }
}

async function detail(params) {
  try {
    const res = await db.collection('goods').doc(params.id).get();
    if (!res.data) return { code: -1, msg: '商品不存在' };
    await db.collection('goods').doc(params.id).update({ data: { viewCount: _.inc(1) } });
    return { code: 0, data: res.data };
  } catch (e) {
    return { code: -1, msg: '商品不存在' };
  }
}

async function myGoods(openid) {
  const res = await db.collection('goods').where({ sellerId: openid }).orderBy('createdAt', 'desc').limit(200).get();
  return { code: 0, data: res.data };
}

async function setStatus(params, openid, status) {
  try {
    const res = await db.collection('goods').doc(params.id).get();
    if (!res.data || res.data.sellerId !== openid) return { code: -1, msg: '无权操作' };
    await db.collection('goods').doc(params.id).update({ data: { status, updatedAt: Date.now() } });
    return { code: 0, data: { status } };
  } catch (e) {
    return { code: -1, msg: '操作失败' };
  }
}

async function complete(params, openid) {
  try {
    const res = await db.collection('goods').doc(params.id).get();
    const g = res.data;
    if (!g || g.sellerId !== openid) return { code: -1, msg: '无权操作' };
    if (g.status !== 'locked') return { code: -1, msg: '当前状态不可成交' };
    await db.collection('goods').doc(params.id).update({ data: { status: 'sold', updatedAt: Date.now() } });
    return { code: 0, data: { status: 'sold' } };
  } catch (e) {
    return { code: -1, msg: '操作失败' };
  }
}

// 演示数据：方便测试版一键填充（sellerId 固定为 demo-seller，不会混入真实用户）
async function seed() {
  const now = Date.now();
  const items = [
    { sellerName: '阿柠', sellerCollege: '计算机学院（软件学院）', cat: 'digital', tradeType: '定价', allowBargain: true, title: '九成新苹果 iPad 第9代 64G', desc: '自用 iPad 第9代 64G Wi-Fi 版，无磕碰无维修，配原装充电器，可当面验机。', price: 1299, condition: '几乎全新', campus: '江安校区', images: [] },
    { sellerName: '小周', sellerCollege: '电子信息学院', cat: 'digital', tradeType: '定价', allowBargain: false, title: '小米充电宝 20000mAh', desc: '支持双向快充，自用半年，正常使用痕迹。', price: 45, condition: '明显使用', campus: '望江校区', images: [] },
    { sellerName: '阿杰', sellerCollege: '化学工程学院', cat: 'life', tradeType: '竞价', allowBargain: true, title: '宿舍懒人沙发椅', desc: '可折叠，毕业离校出，价格好商量，宿舍自提。', price: 60, condition: '轻微使用', campus: '江安校区', images: [] },
    { sellerName: '小李', sellerCollege: '体育学院', cat: 'sports', tradeType: '定价', allowBargain: true, title: '羽毛球拍一副（带球包）', desc: '线刚换过，附球包和一筒球。', price: 80, condition: '几乎全新', campus: '望江校区', images: [] },
    { sellerName: '小胡', sellerCollege: '电气工程学院', cat: 'book', tradeType: '定价', allowBargain: true, title: '高等数学（第七版）同济', desc: '大一高数教材，课堂笔记少量，不影响阅读使用。', price: 15, condition: '轻微使用', campus: '江安校区', images: [], isbn: '9787040396638', author: '同济大学数学系', publisher: '高等教育出版社', edition: '第七版', college: '数学学院', course: '高等数学A', noteLevel: '少量', noteDesc: '前两章有少量划线，无答案填写', defects: '书脊轻微磨损', innerPhotos: [] },
    { sellerName: '小赵', sellerCollege: '计算机学院（软件学院）', cat: 'book', tradeType: '竞价', allowBargain: true, title: '数据结构（C语言版）', desc: '数据结构教材，笔记较多但对复习有帮助，价格可议。', price: 18, condition: '轻微使用', campus: '江安校区', images: [], isbn: '9787302251446', author: '严蔚敏', publisher: '清华大学出版社', edition: '第二版', college: '计算机学院（软件学院）', course: '数据结构', noteLevel: '较多', noteDesc: '多个章节有划线批注和答案填写', defects: '封面边角有折痕', innerPhotos: [] }
  ];

  for (const it of items) {
    const g = { _openid: 'demo-seller', sellerId: 'demo-seller', status: 'on', buyerId: '', dealPrice: null, viewCount: 0, createdAt: now, updatedAt: now, ...it };
    await db.collection('goods').add({ data: g });
  }
  return { code: 0, data: { count: items.length } };
}
