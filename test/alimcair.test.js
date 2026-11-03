'use strict';
const assert = require('assert/strict');
const { test } = require('node:test');
const c = require('../alimcair');
const now = new Date('2026-11-04T10:00:00.000+07:00');
const ready = new Date(+now-3600000), pending = new Date(+ready+1);
function at(i) { return {settled:false,createdAt:new Date('2026-11-01'),completedAt:i}; }
function matches(d,f) {
 return Object.entries(f).every(([k,v])=>{
  if(k==='$and')return v.every(x=>matches(d,x));
  if(k==='$or')return v.some(x=>matches(d,x));
  const value=d[k];
  if(v===null)return value==null;
  if(v && typeof v==='object' && !(v instanceof Date))return Object.entries(v).every(([op,a])=>value!=null && ({'$lte':()=>value<=a,'$lt':()=>value<a,'$gte':()=>value>=a,'$gt':()=>value>a}[op])());
  return value===v;
 });
};

test('setiap hari, termasuk Minggu dan lintas tengah malam, siap tepat +1 jam',()=>{
 for(let day=1;day<=7;day++){const p=new Date('2026-11-0'+day+'T23:30:00+07:00');assert.equal(+c.cairAt(p),+p+3600000);}
});
test('batas satu jam inklusif dan kelompok siap/tertunda saling melengkapi',()=>{
 const cutoff=c.cairCutoff(now); assert.equal(+cutoff,+ready);
 assert.equal(matches(at(ready),c.cairMatch(cutoff)),true);
 assert.equal(matches(at(ready),c.tertundaMatch(cutoff)),false);
 assert.equal(matches(at(pending),c.cairMatch(cutoff)),false);
 assert.equal(matches(at(pending),c.tertundaMatch(cutoff)),true);
 assert.equal(c.statusOf(at(ready),now).ready,true);
 assert.equal(c.statusOf(at(pending),now).ready,false);
});
test('catatan lama memakai createdAt; dana settled tidak ikut lagi',()=>{
 assert.ok(matches({settled:false,createdAt:ready},c.cairMatch(ready)));
 assert.ok(!matches({settled:true,createdAt:ready},c.cairMatch(ready)));
});
test('form masa depan tidak dapat mempercepat pencairan dan snapshot tetap membatasi reset',()=>{
 const f=c.resetFilter('2026-11-04T08:00:00+07:00','2099-01-01',now);
 assert.ok(!matches({...at(ready),createdAt:new Date('2026-11-04T08:00:00.001+07:00')},f));
 assert.ok(!matches({...at(pending),createdAt:new Date('2026-11-01')},f));
 assert.ok(matches({...at(ready),createdAt:new Date('2026-11-01')},f));
});
test('cutoff tombol lama tetap tidak diperluas',()=>{
 assert.equal(+c.clampCutoff(new Date(+ready-60000),now),+ready-60000);
 assert.equal(+c.clampCutoff(null,now),+ready);
});
test('ringkasan dan reset paralel menjaga jumlah/nominal tepat satu kali',async()=>{
 const docs=[{...at(ready),orderId:'ALIM-1',amount:2000},{...at(pending),orderId:'WEBALIM-X',amount:3000},{...at(ready),orderId:'WEBALIM-Y',amount:4000,settled:true}];
 const model={
  aggregate:async pipeline=>{const ds=docs.filter(d=>matches(d,pipeline[0].$match));return ds.length?[{total:ds.reduce((a,d)=>a+d.amount,0),count:ds.length,latest:new Date(Math.max(...ds.map(d=>+d.createdAt)))}]:[];},
  find:f=>({lean:async()=>docs.filter(d=>matches(d,f))}),
  updateMany:async(f,u)=>{const ds=docs.filter(d=>matches(d,f));ds.forEach(d=>Object.assign(d,u.$set));return{modifiedCount:ds.length};}
 };
 const sourceTotals=async f=>{const ds=docs.filter(d=>matches(d,f));return{tele:{total:ds.filter(d=>d.orderId.startsWith('ALIM-')).reduce((a,d)=>a+d.amount,0),count:ds.filter(d=>d.orderId.startsWith('ALIM-')).length},web:{total:0,count:0}};};
 const sum=await c.summarize(model,sourceTotals,now);
 assert.equal(sum.total,5000);assert.equal(sum.cair.total,2000);assert.equal(sum.tertunda.total,3000);
 const f=c.resetFilter(now,ready,now);const results=await Promise.all([c.settle(model,f),c.settle(model,f)]);
 assert.equal(results.reduce((a,d)=>a+d.count,0),1);assert.equal(results.reduce((a,d)=>a+d.total,0),2000);
 assert.equal(docs[1].settled,false);
});

