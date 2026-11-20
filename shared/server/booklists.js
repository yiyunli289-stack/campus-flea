'use strict';
const { assert, confirm, id, permit, text } = require('./core');

const fields = {
  school: 100, campus: 80, college: 100, major: 100, grade: 40, term: 60, course: 100,
  courseType: 50, materialType: 30, title: 120, isbn: 20, author: 100, publisher: 100,
  edition: 50, note: 200, source: 120, verifiedOn: 10, expiresOn: 10
};
const required = new Set(['school','campus','college','major','grade','term','course','materialType','title','source','verifiedOn']);
const empty = { version: '', content: [] };
const materials = ['必修教材','推荐教材','参考书'];

function normalize(row, key) {
  const result = { _id: key, active: row.active !== false };
  for (const [field, size] of Object.entries(fields)) result[field] = text(row[field], size, required.has(field));
  result.isbn = result.isbn.replace(/[-\s]/g, '').toUpperCase();
  assert(!result.isbn || /^(?:\d{9}[\dX]|\d{13})$/.test(result.isbn), 'INVALID_INPUT', 'ISBN 须为10位或13位');
  assert(materials.includes(result.materialType), 'INVALID_INPUT', '请选择教材类别');
  for (const field of ['verifiedOn','expiresOn']) {
    const value = result[field];
    const date = new Date(value + 'T00:00:00Z');
    assert(!value || /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(+date) && date.toISOString().slice(0,10)===value,
      'INVALID_INPUT', '日期须为有效的 YYYY-MM-DD');
  }
  assert(!result.expiresOn || result.expiresOn >= result.verifiedOn, 'INVALID_INPUT', '停用日期不得早于核验日期');
  return result;
}

function rowKey(row) {
  return JSON.stringify([row.school,row.campus,row.college,row.major,row.grade,row.term,row.course,row.isbn || row.title,row.edition]
    .map(value => value.toLowerCase()));
}

function checkRows(input, current, editId) {
  assert(Array.isArray(input) && input.length > 0 && input.length <= 100, 'INVALID_INPUT', '每次导入1至100条');
  const rows = [], errors = [];
  const seen = new Set(current.filter(row=>row._id!==editId).map(rowKey));
  input.forEach((row, index) => {
    try {
      assert(row && typeof row==='object' && !Array.isArray(row),'INVALID_INPUT','条目格式无效');
      const candidate=normalize(row,editId || id());
      const key=rowKey(candidate);
      assert(!seen.has(key),'DUPLICATE_ITEM','同一课程场景已存在该教材和版次');
      seen.add(key); rows.push(candidate);
    } catch (error) {
      if (!error.code) throw error;
      errors.push({ row:index+1, message:error.message });
    }
  });
  return { rows, errors };
}

async function currentSettings(store) {
  const published = await store.get('settings','booklists') || empty;
  const draft = await store.get('settings','booklists-draft');
  return { published, draft:draft?.content ? draft : null };
}

async function adminList(s, actor, p) {
  permit(actor,'configure');
  const { published, draft } = await currentSettings(s.store);
  const versions = await s.store.find('configVersions',{kind:'booklists'},{sort:'publishedAt',limit:50});
  const page = Math.max(1, Math.min(10000, Math.floor(Number(p.page) || 1)));
  const feedback = await s.store.find('booklistFeedback',{}, {sort:'createdAt',limit:20,skip:(page-1)*20});
  const feedbackTotal = await s.store.count('booklistFeedback');
  await s.store.transaction(tx=>s.audit(tx,actor,'query.booklists','booklists',null,{published:published.version,page}));
  return {
    rows:(draft || published).content, revision:(draft || published).version,
    hasDraft:!!draft, publishedVersion:published.version,
    versions:versions.map(({_id,publishedAt,createdBy,content})=>({_id,publishedAt,createdBy,count:content.length})),
    feedback:feedback.map(({reporterId,...row})=>row), feedbackTotal
  };
}

async function adminAction(s, actor, p) {
  permit(actor,'configure');
  if (p.op==='booklist.preview') {
    const { published, draft } = await currentSettings(s.store);
    const { rows,errors } = checkRows(p.rows,(draft || published).content);
    return { valid:rows.length,errors,revision:(draft || published).version };
  }
  const allowed=['booklist.save','booklist.import','booklist.publish','booklist.rollback','booklist.feedback'];
  assert(allowed.includes(p.op),'NOT_FOUND','未知书单操作',404);
  const reason=confirm(p);
  const version=id();
  return s.store.transaction(async tx=>{
    const { published, draft } = await currentSettings(tx);
    const current=draft || published;
    assert(p.revision===current.version,'STALE_CONFIG','书单已有其他变更，请刷新页面',409);
    if (p.op==='booklist.publish' || p.op==='booklist.rollback') {
      const source=p.op==='booklist.publish'?draft:await tx.get('configVersions',p.id);
      assert(source && (p.op==='booklist.publish' || source.kind==='booklists'),'INVALID_STATE','没有可发布的书单版本');
      const next={ version, content:source.content, publishedAt:s.now(), createdBy:actor._id };
      await tx.put('settings','booklists',next);
      await tx.put('settings','booklists-draft',{version,content:null});
      await tx.put('configVersions',version,{...next,kind:'booklists',state:'published',createdAt:s.now()});
      await s.audit(tx,actor,p.op,version,{version:published.version},{count:next.content.length,source:p.id || draft?.version},reason);
      return { revision:version };
    }

    let rows = current.content;
    if (p.op==='booklist.feedback') {
      const feedback=await tx.get('booklistFeedback',p.id);
      assert(feedback?.state==='pending','INVALID_STATE','反馈不存在或已处理',409);
      assert(['approved','rejected'].includes(p.decision),'INVALID_INPUT','请选择处理结果');
      if (p.decision==='approved') {
        const index=published.content.findIndex(row=>row._id===feedback.itemId);
        assert(!draft && index>=0,'STALE_CONFIG','条目已变更或存在未发布草稿，请先核对并处理草稿',409);
        const unchanged=Object.entries(feedback.previous || {}).every(([key,value])=>published.content[index][key]===value);
        assert(feedback.version===published.version || (feedback.previous && unchanged),
          'STALE_CONFIG','纠错字段已发生变化，请核对后在书单中手动修正',409);
        const corrected=normalize({...published.content[index],...feedback.changes},feedback.itemId);
        assert(!published.content.some((row,i)=>i!==index && rowKey(row)===rowKey(corrected)),'DUPLICATE_ITEM','纠正后与已有条目冲突');
        rows=published.content.map((row,i)=>i===index?{...corrected,maintainer:actor.username}:row);
        const next={version,content:rows,publishedAt:s.now(),createdBy:actor._id};
        await tx.put('settings','booklists',next);
        await tx.put('configVersions',version,{...next,kind:'booklists',state:'published',createdAt:s.now()});
      }
      await tx.put('booklistFeedback',feedback._id,{...feedback,state:p.decision,reason,resolvedAt:s.now(),resolvedBy:actor._id});
      await s.notify(tx,feedback.reporterId,'booklist.feedback',feedback._id,p.decision==='approved'?'书单纠错已通过并发布':'书单纠错已核查：'+reason);
      await s.audit(tx,actor,p.op,p.id,{state:'pending'},{state:p.decision},reason);
      return {revision:p.decision==='approved'?version:current.version};
    }

    const editId=p.op==='booklist.save'?p.id:undefined;
    if (editId) assert(rows.some(row=>row._id===editId),'NOT_FOUND','书单条目不存在',404);
    const checked=checkRows(p.op==='booklist.save'?[p.row]:p.rows,rows,editId);
    assert(!checked.errors.length,'INVALID_INPUT',checked.errors[0] ?
      `第 ${checked.errors[0].row} 条：${checked.errors[0].message}` : '条目校验失败');
    const nextRows=rows.filter(row=>row._id!==editId).concat(checked.rows.map(row=>({...row,maintainer:actor.username})));
    assert(nextRows.length<=1000 && Buffer.byteLength(JSON.stringify(nextRows))<=650_000,'INVALID_INPUT','当前书单版本容量已满（最多1000条）');
    await tx.put('settings','booklists-draft',{version,content:nextRows});
    await s.audit(tx,actor,p.op,editId || version,null,{count:checked.rows.length,version},reason);
    return { revision:version };
  });
}

function activeRows(content, now) {
  const day = new Date(now + 8*3600000).toISOString().slice(0,10);
  return content.filter(row=>row.active && (!row.expiresOn || row.expiresOn >= day));
}

async function publicList(s, p) {
  const published=await s.store.get('settings','booklists') || empty;
  const filters=['school','campus','college','major','grade','term','course'];
  const labels={school:'学校',campus:'校区',college:'学院',major:'专业',grade:'年级',term:'学期',course:'课程'};
  const selection=Object.fromEntries(filters.map(key=>[key,text(p[key],100)]));
  const query=text(p.keyword,100).toLowerCase();
  const matching=activeRows(published.content,s.now()).filter(row=>
    (!selection.college || row.college===selection.college) &&
    (!query || ['college','major','course','title','isbn'].some(key=>row[key].toLowerCase().includes(query))));
  const rows=matching.filter(row=>filters.every(key=>!selection[key] || row[key]===selection[key]));
  const choices=filters.filter(key=>key!=='college').map(key=>{
    const upstream=filters.slice(0,filters.indexOf(key));
    const options=matching.filter(row=>upstream.every(field=>!selection[field] || row[field]===selection[field]));
    const values=['全部',...Array.from(new Set(options.map(row=>row[key]))).sort()];
    return {key,label:labels[key],values,index:Math.max(0,values.indexOf(selection[key]))};
  });
  const offset=Math.max(0,Math.floor(Number(p.offset) || 0));
  return { version:published.version, total:rows.length, filters:choices,
    rows:rows.slice(offset,offset+50).map(({maintainer,...row})=>row) };
}

async function submitFeedback(s, p, openid) {
  await s.user(openid,'profile',s.store,false);
  await s.rate(openid,'booklist-feedback',5,3600000);
  const published=await s.store.get('settings','booklists') || empty;
  const entry=activeRows(published.content,s.now()).find(row=>row._id===p.itemId);
  assert(entry && p.version===published.version,'STALE_CONFIG','请刷新书单后提交');
  const field=text(p.field,30,true);
  assert(['title','isbn','author','publisher','edition','note'].includes(field),'INVALID_INPUT','不支持此纠错字段');
  const value=text(p.value,fields[field],field==='title');
  const corrected=normalize({...entry,[field]:value},entry._id);
  assert(corrected[field]!==entry[field],'INVALID_INPUT','请填写不同的修正内容');
  const note=text(p.note,300,true);
  const key=id();
  await s.store.transaction(tx=>tx.put('booklistFeedback',key,{
    itemId:entry._id,title:entry.title,version:published.version,reporterId:openid,
    previous:{[field]:entry[field]},changes:{[field]:corrected[field]},note,state:'pending',createdAt:s.now()
  }));
  return {_id:key};
}

module.exports = { adminList, adminAction, publicList, submitFeedback, activeRows };
