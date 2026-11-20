'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');
const { adminList, evidence, adminAction } = require('../shared/server/governance');
const { adminStatistics } = require('../shared/server/statistics');
const { reportStateFilter } = require('../shared/server/service');

test('旧举报可以按状态与对象检索、核查并处置，无须先迁移', async () => {
  const { s, store, reviewer, readonly, listing } = await fixture();
  const targetId = await listing();
  await store.put('reports', 'legacy', {
    goodsId: targetId, goodsTitle: '历史商品', status: 'pending', reason: '核查', detail: '历史举报说明',
    reporterId: 'buyer', _openid: 'buyer', createdAt: s.now()
  });
  const list = await adminList(s, readonly, { entity: 'reports', state: 'pending', keyword: targetId, targetType: 'goods' });
  assert.equal(list.total, 1);
  assert.equal(list.list[0].targetId, targetId);
  assert.equal(list.list[0]._openid, undefined);
  assert.equal(list.list[0].detail, undefined);
  assert.equal(await store.count('reports', reportStateFilter('pending')), 1);
  const result = await evidence(s, reviewer, { entity: 'reports', id: 'legacy', reason: '核查历史记录' });
  assert.equal(result.reportDetail, '历史举报说明');
  assert.equal(result.ownerUserId, 'seller');
  await adminAction(s, reviewer, { op: 'govern', targetType: 'goods', targetId, caseId: 'legacy', action: 'remove',
    reason: '确认违规', confirm: true });
  assert.equal((await store.get('goods', targetId)).status, 'off');
  assert.equal((await store.get('reports', 'legacy')).state, 'resolved');
  assert.equal(await store.count('notifications', { ownerId: 'buyer', type: 'report.result' }), 1);
  assert.equal(await store.count('reports', reportStateFilter('pending')), 0);
});

test('书单冲突预览、草稿隔离、发布、纠错、统计与回滚', async () => {
  const { s, store, superAdmin, readonly } = await fixture();
  const book = { school:'四川大学',campus:'江安校区',college:'计算机学院',major:'计算机',grade:'大一',
    term:'2026秋',course:'数学',materialType:'必修教材',title:'学院数学',
    isbn:'9781234567897',source:'选课通知',verifiedOn:'2026-09-01',active:true };
  const confirm = { reason:'核对书单资料',confirm:true };
  const preview = await adminAction(s, superAdmin, { op:'booklist.preview',rows:[book,book] });
  assert.deepEqual(preview.errors.map(error=>error.row), [2]);
  const draft = await adminAction(s, superAdmin, { ...confirm,op:'booklist.import',rows:[book],revision:'' });
  assert.equal((await s.mini('config',{ action:'booklists' })).total, 0);
  await assert.rejects(adminAction(s, superAdmin, { ...confirm,op:'booklist.publish',revision:'' }), error=>error.code==='STALE_CONFIG');
  await assert.rejects(adminAction(s, readonly, { ...confirm,op:'booklist.publish',revision:draft.revision }), error=>error.code==='FORBIDDEN');
  const published = await adminAction(s, superAdmin, { ...confirm,op:'booklist.publish',revision:draft.revision });
  const result = await s.mini('config',{ action:'booklists',college:'计算机学院',keyword:'数学' });
  assert.equal(result.rows[0].title, book.title);
  assert.equal(result.rows[0].maintainer, undefined);
  const feedback = await s.mini('config',{ action:'booklist.feedback',itemId:result.rows[0]._id,version:published.revision,
    field:'title',value:'新版学院数学',note:'课程通知已更正' },'buyer');
  const corrected = await adminAction(s, superAdmin, { ...confirm,op:'booklist.feedback',id:feedback._id,
    revision:published.revision,decision:'approved' });
  assert.equal(await store.count('notifications',{ ownerId:'buyer',type:'booklist.feedback' }),1);
  assert.equal((await s.mini('config',{ action:'booklists' })).rows[0].title,'新版学院数学');
  await store.put('goods','book-example',{ title:book.title,isbn:book.isbn,cat:'book',status:'on',college:book.college });
  const stats = await adminStatistics(s, readonly, { days:7 });
  assert.deepEqual(stats.colleges.find(row=>row.college===book.college),{
    college:book.college,materials:1,matched:1,listed:1,gap:0,searches:0,empty:0
  });
  await adminAction(s, superAdmin, { ...confirm,op:'booklist.rollback',id:published.revision,revision:corrected.revision });
  assert.equal((await s.mini('config',{ action:'booklists' })).rows[0].title,book.title);
});
