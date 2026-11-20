'use strict';
const { assert, hash, permit, text } = require('./core');
const { activeRows } = require('./booklists');

const DAY = 86400000;
const tradeTypes = ['定价','竞价'];
const stages = ['view','request','response','accept','lockCancel','sold'];
const dayFor = now => new Date(now + 8*3600000).toISOString().slice(0,10);

async function increment(s, tx, event, group) {
  const day=dayFor(s.now());
  const key=hash(JSON.stringify([day,event,group]));
  const current=await tx.get('operationMetrics',key);
  await tx.put('operationMetrics',key,{day,event,group,count:(current?.count || 0)+1});
}

async function trade(s, tx, event, mode) {
  if (tradeTypes.includes(mode)) await increment(s,tx,event,mode);
}

async function search(s, p, found) {
  if (Number(p.skip)>0 || !(p.keyword || p.college || p.isbn || p.course)) return;
  const college=text(p.college,100);
  // Group by a configured college to avoid persisting arbitrary user search terms.
  const config=await s.setting('public');
  const group=config.content.colleges.some(row=>row.code===college && row.active)?college:'';
  await s.store.transaction(async tx=>{
    await increment(s,tx,'bookSearch',group);
    if (!found) await increment(s,tx,'bookSearchEmpty',group);
  });
}

async function pageAll(store, table, filter, fields) {
  const all=[];
  for (let skip=0;;skip+=100) {
    const rows=await store.find(table,filter,{sort:'_id',asc:true,skip,limit:100,fields});
    all.push(...rows);
    if (rows.length<100) return all;
  }
}

function bookKey(row) {
  const isbn=String(row.isbn || '').toUpperCase().replace(/[-\s]/g,'');
  if (isbn) return 'isbn:'+isbn;
  return 'title:'+String(row.title || '').trim().toLowerCase()+':'+String(row.edition || '').trim().toLowerCase();
}

async function adminStatistics(s, actor, p) {
  permit(actor,'read');
  const days=Number(p.days || 30);
  assert([7,30,90].includes(days),'INVALID_INPUT','请选择 7、30 或 90 天');
  const since=dayFor(s.now()-(days-1)*DAY);
  const end=dayFor(s.now());
  const [metrics,booklists,goods,config] = await Promise.all([
    pageAll(s.store,'operationMetrics',{day:{$gte:since,$lte:end}}),
    s.store.get('settings','booklists'),
    pageAll(s.store,'goods',{cat:'book',status:'on',enforcement:{$ne:'removed'},$or:[
      {moderationStatus:'approved'},{moderationStatus:{$exists:false}}
    ]}, { isbn:true,title:true,edition:true,college:true }),
    s.setting('public')
  ]);
  const counts=new Map();
  for (const metric of metrics) {
    const key=JSON.stringify([metric.event,metric.group]);
    counts.set(key,(counts.get(key) || 0)+metric.count);
  }
  const count=(event,group)=>counts.get(JSON.stringify([event,group])) || 0;
  const funnel=tradeTypes.map(mode=>({mode,...Object.fromEntries(stages.map(stage=>[stage,count(stage,mode)]))}));
  const active=activeRows(booklists?.content || [],s.now());
  const marketKeys=new Set(goods.flatMap(row=>[bookKey(row), bookKey({...row,isbn:''})]));
  const collegeNames=new Set([...config.content.colleges.filter(row=>row.active).map(row=>row.code),...active.map(row=>row.college)]);
  const colleges=Array.from(collegeNames).map(college=>{
    const materials=active.filter(row=>row.college===college);
    const matched=materials.filter(row=>marketKeys.has(bookKey(row))).length;
    const listed=goods.filter(row=>row.college===college).length;
    const searches=count('bookSearch',college);
    const empty=count('bookSearchEmpty',college);
    return {college,materials:materials.length,matched,listed,gap:materials.length-matched,searches,empty};
  });
  await s.store.transaction(tx=>s.audit(tx,actor,'query.statistics','operations',null,{since,end}));
  return {since,end,funnel,colleges,searches:metrics.filter(row=>row.event==='bookSearch').reduce((sum,row)=>sum+row.count,0),
    emptySearches:metrics.filter(row=>row.event==='bookSearchEmpty').reduce((sum,row)=>sum+row.count,0)};
}

module.exports = { adminStatistics, trade, search };
