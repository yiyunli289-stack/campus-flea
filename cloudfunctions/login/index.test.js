const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadLoginFunction({ users, goods, openid = 'user-1' }) {
  const db = {
    serverDate: () => 'SERVER_DATE',
    collection(name) {
      const rows = name === 'users' ? users : goods;
      return {
        where(query) {
          const matched = () => rows.filter((row) =>
            Object.entries(query).every(([key, value]) => row[key] === value)
          );
          return {
            async get() {
              return { data: matched().map((row) => ({ ...row })) };
            },
            async update({ data }) {
              const targets = matched();
              targets.forEach((row) => Object.assign(row, data));
              return { stats: { updated: targets.length } };
            }
          };
        },
        doc(id) {
          return {
            async update({ data }) {
              const row = rows.find((item) => item._id === id);
              if (!row) throw new Error(`document not found: ${id}`);
              Object.assign(row, data);
            }
          };
        }
      };
    }
  };

  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    database: () => db,
    getWXContext: () => ({ OPENID: openid })
  };

  const originalLoad = Module._load;
  Module._load = function mockWxServerSdk(request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve('./index');
  delete require.cache[modulePath];
  try {
    return require('./index').main;
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

test('updating a profile refreshes seller snapshots on every historical good', async () => {
  const users = [{
    _id: 'profile-1',
    _openid: 'user-1',
    nickName: '旧昵称',
    avatarUrl: 'old-avatar.png',
    campus: '江安校区',
    contact: '123',
    college: '旧学院',
    major: ''
  }];
  const goods = [
    { _id: 'good-on', sellerId: 'user-1', status: 'on', sellerName: '旧昵称' },
    { _id: 'good-sold', sellerId: 'user-1', status: 'sold', sellerName: '旧昵称' },
    { _id: 'other-good', sellerId: 'user-2', status: 'on', sellerName: '其他用户' }
  ];
  const main = loadLoginFunction({ users, goods });

  const result = await main({
    action: 'updateProfile',
    nickName: '新昵称',
    avatarUrl: 'new-avatar.png',
    college: '新学院'
  });

  assert.equal(result.code, 0);
  assert.equal(result.data.nickName, '新昵称');
  assert.equal(result.data.profileComplete, true);
  assert.deepEqual(
    goods.slice(0, 2).map(({ sellerName, sellerAvatar, sellerCollege }) => ({
      sellerName,
      sellerAvatar,
      sellerCollege
    })),
    [
      { sellerName: '新昵称', sellerAvatar: 'new-avatar.png', sellerCollege: '新学院' },
      { sellerName: '新昵称', sellerAvatar: 'new-avatar.png', sellerCollege: '新学院' }
    ]
  );
  assert.equal(goods[2].sellerName, '其他用户');
});

test('cleared display fields are also propagated to goods', async () => {
  const users = [{
    _id: 'profile-1',
    _openid: 'user-1',
    nickName: '昵称',
    avatarUrl: 'avatar.png',
    campus: '江安校区',
    contact: '123',
    college: '学院',
    major: ''
  }];
  const goods = [{
    _id: 'good-1',
    sellerId: 'user-1',
    sellerName: '昵称',
    sellerAvatar: 'avatar.png',
    sellerCollege: '学院'
  }];
  const main = loadLoginFunction({ users, goods });

  const result = await main({
    action: 'updateProfile',
    avatarUrl: '',
    college: ''
  });

  assert.equal(result.code, 0);
  assert.equal(goods[0].sellerName, '昵称');
  assert.equal(goods[0].sellerAvatar, '');
  assert.equal(goods[0].sellerCollege, '');
});
