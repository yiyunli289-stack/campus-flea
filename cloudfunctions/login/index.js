// 云函数：登录 / 资料
// 对应需求 FR-P0-ACC-01 微信授权登录、FR-P0-ACC-02 最低资料补全、FR-P0-ACC-03 资料编辑
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { action, ...params } = event || {};
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: '获取用户身份失败' };

  switch (action) {
    case 'updateProfile':
      return updateProfile(params, OPENID);
    case 'login':
    default:
      return login(OPENID);
  }
};

// 登录：查询或创建用户
async function login(openid) {
  try {
    const res = await db.collection('users').where({ _openid: openid }).get();
    if (res.data.length === 0) {
      const newUser = {
        _openid: openid,
        nickName: '',
        avatarUrl: '',
        campus: '',
        contact: '',
        college: '',
        major: '',
        profileComplete: false,
        createdAt: db.serverDate()
      };
      const addRes = await db.collection('users').add({ data: newUser });
      return { code: 0, data: { _id: addRes._id, ...newUser } };
    }
    return { code: 0, data: res.data[0] };
  } catch (err) {
    console.error('login error:', err);
    return { code: -1, msg: '登录失败：' + err.message };
  }
}

// 更新个人资料：最低补全 = 昵称 + 校区 + 联系方式
async function updateProfile(params, openid) {
  try {
    const res = await db.collection('users').where({ _openid: openid }).get();
    if (res.data.length === 0) return { code: -1, msg: '用户未注册' };

    const cur = res.data[0];
    const next = {
      nickName: params.nickName !== undefined ? params.nickName : cur.nickName,
      avatarUrl: params.avatarUrl !== undefined ? params.avatarUrl : cur.avatarUrl,
      campus: params.campus !== undefined ? params.campus : cur.campus,
      contact: params.contact !== undefined ? params.contact : cur.contact,
      college: params.college !== undefined ? params.college : cur.college,
      major: params.major !== undefined ? params.major : cur.major,
      updatedAt: db.serverDate()
    };
    next.profileComplete = !!(next.nickName && next.campus && next.contact);

    await db.collection('users').doc(cur._id).update({ data: next });
    return { code: 0, data: { ...cur, ...next } };
  } catch (err) {
    console.error('updateProfile error:', err);
    return { code: -1, msg: '保存失败：' + err.message };
  }
}
