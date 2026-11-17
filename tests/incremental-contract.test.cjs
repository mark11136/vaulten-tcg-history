'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const api=require('../scripts/incremental.cjs');
const {loadLocal}=require('../scripts/common.cjs');
function baseline() {
  const days=api.rollingDays('2026-11-15');
  return {manifest:{schemaVersion:1,source:'Explicit synthetic fixture',currency:'USD',metric:'marketPrice',days,sourceLastUpdated:'2026-11-15T20:06:00Z',recordCount:1,categoryGames:api.CATEGORIES},
    observedDates:new Set(days),rows:new Map([['728061|Holofoil',{categoryId:3,groupId:24831,prices:days.map(()=>300)}]])};
}
function daily(date='2026-11-16') {
  return {date,kind:'daily',complete:true,sourceMarker:date+'T20:06:00Z',markerAfter:date+'T20:06:00Z',categoryIds:api.CATEGORY_IDS,
    entries:[{productId:728061,subTypeName:'Holofoil',marketPrice:350,categoryId:3,groupId:24831}]};
}
test('incremental module keeps missing calendar day null and exact printing identity separate',()=>{
  const s=daily('2026-11-17');s.entries.push({...s.entries[0],subTypeName:'Normal',marketPrice:4});
  const result=api.mergeSnapshots(baseline(),[s],new Date('2026-11-18T07:00:00Z'));
  assert.deepEqual(result.rows.get('728061|Holofoil').prices.slice(-3),[300,null,350]);
  assert.deepEqual(result.manifest.gapDates,['2026-11-16']);
  assert.deepEqual(result.rows.get('728061|Normal').prices.slice(-3),[null,null,4]);
});
test('incremental module rejects mixed publication and incomplete category data',()=>{
  const s=daily();s.markerAfter='2026-11-16T20:07:00Z';assert.throws(()=>api.validateDay(s));
  const other=daily();other.categoryIds=[3];assert.throws(()=>api.validateDay(other));
});
test('incremental encoding is accepted by public sourcing hash contract',()=>{
  const result=api.mergeSnapshots(baseline(),[daily()],new Date('2026-11-17T07:00:00Z'));
  const out=api.encodeDataset(result,new Date('2026-11-17T07:00:00Z'));
  const {parseManifest,validateShard}=require('../scripts/common.cjs');
  const manifest=parseManifest(Buffer.from(JSON.stringify(out.manifest)));
  for(const meta of manifest.shards)validateShard(out.files.get(meta.name),meta);
});
test('bundled real seed passes both SHA checks and incremental dataset validation without network',async()=>{
  const directory=path.join(__dirname,'..','seed');
  const hashChecked=await loadLocal(directory),loaded=api.loadDataset(directory);
  assert.equal(hashChecked.manifest.shards.length,122);
  assert.equal(loaded.rows.size,hashChecked.manifest.recordCount);
  assert.equal(loaded.manifest.days.length,30);
});

