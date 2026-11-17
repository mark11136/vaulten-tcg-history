'use strict';
// Synthetic fixtures only. All fetches are intercepted; these tests never contact Cloudflare or TCGCSV.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const sync=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const zlib=require('node:zlib');
const {MANIFEST,sha256,baseUrl,parseManifest,validateShard,loadLocal,published}=require('../scripts/common.cjs');
const {source}=require('../scripts/source.cjs');
const {stage}=require('../scripts/build.cjs');
const {verify}=require('../scripts/verify-live.cjs');
const {validate}=require('../scripts/validate.cjs');
const {checkpoint}=require('../scripts/cache-checkpoint.cjs');
const BASE='https://synthetic-vaulten.pages.dev';
const date='2026-11-15';
function fixture(price=10) {
  const days=Array.from({length:30},(_,i)=>new Date(Date.parse(date+'T00:00:00Z')-(29-i)*86400000).toISOString().slice(0,10));
  const data={schemaVersion:1,currency:'USD',metric:'marketPrice',days,categoryIds:[3],rows:{'123|Holofoil':{categoryId:3,groupId:42,prices:days.map(()=>price)}}};
  const raw=Buffer.from(JSON.stringify(data)), gzip=zlib.gzipSync(raw);
  const body=Buffer.from(JSON.stringify({schemaVersion:1,encoding:'gzip-base64',data:gzip.toString('base64')}));
  const hash=sha256(body), name='vaulten-history-0-'+hash.slice(0,16)+'.json';
  const meta={bucket:0,name,sha256:hash,rawSha256:sha256(raw),bytes:body.length,rawBytes:raw.length,gzipBytes:gzip.length,categoryIds:[3],recordCount:1};
  const manifest={schemaVersion:1,source:'Synthetic fixture, never production',currency:'USD',metric:'marketPrice',sourceLastUpdated:date+'T20:00:00Z',days,recordCount:1,shards:[meta]};
  return {manifest,bytes:Buffer.from(JSON.stringify(manifest)),body,meta};
}
async function dir(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vaulten-cloud-test-'));
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()),'vaulten-cloud-test-')));await fs.rm(root,{recursive:true,force:true});});
  return root;
}
async function writeData(directory,f=fixture()) {
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,MANIFEST),f.bytes);
  await fs.writeFile(path.join(directory,f.meta.name),f.body);
}
function transport(f,{status=200,corrupt=false,counts=[],cors=true}={}) {
  return async input=>{
    const url=new URL(input);counts.push(url.pathname);
    assert.equal(url.origin,BASE);
    if(status!==200)return new Response('',{status});
    const headers=cors?{'Access-Control-Allow-Origin':'*'}:{};
    if(url.pathname==='/'+MANIFEST)return new Response(f.bytes,{headers});
    if(url.pathname==='/'+f.meta.name)return new Response(corrupt?Buffer.from('bad'):f.body,{headers});
    return new Response('',{status:404});
  };
}
test('HTTPS origin validation rejects credentials, non-HTTPS, path and query',()=>{
  for(const value of ['http://example.com','https://user:secret@example.com','https://example.com/sub','https://example.com/?key=secret','https://localhost','file:///tmp'])assert.throws(()=>baseUrl(value));
  assert.equal(baseUrl(BASE).origin,BASE);
});
test('manifest requires immutable exact hashed name and safe unique bucket',()=>{
  const f=fixture();assert.equal(parseManifest(f.bytes).shards[0].name,f.meta.name);
  for(const mutate of [
    x=>x.shards[0].name='../secret',
    x=>x.shards[0].name='vaulten-history-0-deadbeefdeadbeef.json',
    x=>x.shards.push(x.shards[0]),
    x=>x.shards[0].bytes=100*1024*1024,
    x=>x.shards[0].rawSha256=null,
    x=>x.days[0]='2026-02-30'
  ]) {const m=structuredClone(f.manifest);mutate(m);assert.throws(()=>parseManifest(Buffer.from(JSON.stringify(m))));}
});
test('both published and inflated hashes plus record count are enforced',()=>{
  const f=fixture();assert.equal(validateShard(f.body,f.meta).rows['123|Holofoil'].prices[0],10);
  assert.throws(()=>validateShard(Buffer.from('corrupt'),f.meta));
  assert.throws(()=>validateShard(f.body,{...f.meta,rawSha256:'a'.repeat(64)}));
  assert.throws(()=>validateShard(f.body,{...f.meta,recordCount:2}));
});
test('frontend manifest limits reject incomplete windows, gaps, future or mismatched source day',()=>{
  for(const mutate of [
    m=>m.days.pop(),
    m=>m.days[1]=m.days[2],
    m=>m.sourceLastUpdated='2099-11-15T20:00:00Z',
    m=>m.sourceLastUpdated='2026-11-14T20:00:00Z',
    m=>m.metric='askingPrice',
    m=>m.shards[0].rawBytes=3*1024*1024+1,
    m=>m.padding='x'.repeat(256000)
  ]) {const m=structuredClone(fixture().manifest);mutate(m);assert.throws(()=>parseManifest(Buffer.from(JSON.stringify(m))));}
});
test('valid SHA hashes do not excuse wrong dates, market, identity, categories or zero prices',()=>{
  const f=fixture();
  for(const mutate of [
    d=>d.days[0]='2026-10-18',
    d=>d.currency='EUR',
    d=>d.metric='lowPrice',
    d=>d.rows['123|Holofoil'].prices[0]=0,
    d=>d.rows['123|Holofoil'].groupId=0,
    d=>d.rows['123|Holofoil'].categoryId=71,
    d=>d.categoryIds=[3,71],
    d=>{d.rows['9999|Holofoil']=d.rows['123|Holofoil'];delete d.rows['123|Holofoil'];}
  ]) {
    const raw=JSON.parse(zlib.gunzipSync(Buffer.from(JSON.parse(f.body).data,'base64')));mutate(raw);
    const bytes=Buffer.from(JSON.stringify(raw)),gzip=zlib.gzipSync(bytes);
    const body=Buffer.from(JSON.stringify({schemaVersion:1,encoding:'gzip-base64',data:gzip.toString('base64')}));
    const meta={...f.meta,sha256:sha256(body),bytes:body.length,rawSha256:sha256(bytes),rawBytes:bytes.length,gzipBytes:gzip.length};
    assert.throws(()=>validateShard(body,meta,f.manifest));
  }
});
test('frontend base64 envelope length cap applies before inflation',()=>{
  const f=fixture(),body=Buffer.from(JSON.stringify({schemaVersion:1,encoding:'gzip-base64',data:'A'.repeat(400004)}));
  assert.throws(()=>validateShard(body,{...f.meta,sha256:sha256(body),bytes:body.length},f.manifest),/wrapper/);
});
test('public manifest and every shard are fetched and verified',async t=>{
  const root=await dir(t), f=fixture(),counts=[];
  const out=await published(BASE,{directory:root,fetchImpl:transport(f,{counts})});
  assert.equal(out.manifest.recordCount,1);assert.equal(counts.length,2);assert.deepEqual((await loadLocal(root)).bytes,f.bytes);
});
test('bad public shard never persists a complete manifest',async t=>{
  const root=await dir(t),f=fixture();
  await assert.rejects(published(BASE,{directory:root,fetchImpl:transport(f,{corrupt:true})}));
  assert.equal(await fs.stat(path.join(root,MANIFEST)).catch(()=>null),null);
});
test('public manifest must equal the exact intended deployment',async()=>{
  const a=fixture(),b=fixture(20);
  await assert.rejects(published(BASE,{fetchImpl:transport(a),expectedBytes:b.bytes}),/differs/);
});
test('first seed bootstrap requires explicit manual event and no previous audit',async t=>{
  const root=await dir(t);await writeData(path.join(root,'seed'));
  await assert.rejects(source({root,base:BASE,bootstrap:true,event:'schedule'}),/manual/);
  await fs.mkdir(path.join(root,'data'));await fs.writeFile(path.join(root,'data','latest-manifest.json'),'{}');
  await assert.rejects(source({root,base:BASE,bootstrap:true,event:'workflow_dispatch'}),/already records/);
});
test('valid bootstrap verifies seed without any remote read',async t=>{
  const root=await dir(t);await writeData(path.join(root,'seed'));let fetched=false;
  const out=await source({root,base:BASE,bootstrap:true,event:'workflow_dispatch',fetchImpl:async()=>{fetched=true;throw Error('No network');}});
  assert.equal(out.kind,'seed');assert.equal(fetched,false);await loadLocal(path.join(root,'.work','input'));
});
test('normal origin failure never falls back to the seed',async t=>{
  const root=await dir(t),f=fixture();await writeData(path.join(root,'seed'));
  await assert.rejects(source({root,base:BASE,fetchImpl:transport(f,{status:503})}),/503/);
  assert.equal(await fs.stat(path.join(root,'.work','input',MANIFEST)).catch(()=>null),null);
});
test('normal publication older than committed audit fails closed',async t=>{
  const root=await dir(t),f=fixture();await fs.mkdir(path.join(root,'data'));
  await fs.writeFile(path.join(root,'data','latest-manifest.json'),JSON.stringify({sourceLastUpdated:'2026-11-16T20:00:00Z'}));
  await assert.rejects(source({root,base:BASE,fetchImpl:transport(f)}),/older/);
});
async function setupStage(t,kind='published') {
  const root=await dir(t),f=fixture();await writeData(path.join(root,'.work','input'),f);
  await fs.writeFile(path.join(root,'.work','source.json'),JSON.stringify({kind}));
  await fs.mkdir(path.join(root,'static'));await fs.writeFile(path.join(root,'static','_headers'),'/*\n Access-Control-Allow-Origin: *\n');
  return {root,f};
}
test('unchanged upstream does not deploy or create public output',async t=>{
  const {root}=await setupStage(t);const out=await stage({root,run:()=>({status:0})});
  assert.equal(out.changed,false);assert.equal(await fs.stat(path.join(root,'public')).catch(()=>null),null);
});
test('first bootstrap can publish verified seed on a successful unchanged source check',async t=>{
  const {root}=await setupStage(t,'seed');const out=await stage({root,run:()=>({status:0})});
  assert.equal(out.changed,true);assert.equal(out.bootstrap,true);assert.equal((await validate(path.join(root,'public'))).valid,true);
});
test('source update failure cannot make a deployable output',async t=>{
  const {root}=await setupStage(t);await assert.rejects(stage({root,run:()=>({status:1})}),/failed/);
  assert.equal(await fs.stat(path.join(root,'public')).catch(()=>null),null);
});
test('failed collection still retains its actual marker for a later fuller cache checkpoint',async t=>{
  const {root}=await setupStage(t);
  await assert.rejects(stage({root,run:()=>({status:1,stdout:JSON.stringify({status:'source_checked',sourceLastUpdated:'2026-11-16T20:05:58Z'})+'\n'})}));
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'.work','source-marker.json'))).sourceLastUpdated,'2026-11-16T20:05:58Z');
});
test('cache checkpoint keeps request ledger and two generations, excludes sibling lock',async t=>{
  const root=await dir(t),cache=path.join(root,'.work','archive-cache');await fs.mkdir(cache,{recursive:true});
  await fs.writeFile(path.join(cache,'request-ledger.json'),'[1,2]');
  const generations=['20261114T200558000Z','20261115T200558000Z','20261116T200558000Z'];
  for(const g of generations)await fs.mkdir(path.join(cache,g));
  await fs.writeFile(cache+'.run.lock','synthetic');
  await fs.writeFile(path.join(root,'.work','source-marker.json'),JSON.stringify({sourceLastUpdated:'2026-11-16T20:05:58Z'}));
  const out=await checkpoint(root);
  assert.equal(out.marker,'20261116T200558000Z');assert.equal(out.present,true);
  assert.deepEqual(out.retainedGenerations,generations.slice(1).reverse());
  assert.equal(await fs.stat(path.join(cache,generations[0])).catch(()=>null),null);
  assert.equal(await fs.readFile(path.join(cache,'request-ledger.json'),'utf8'),'[1,2]');
  assert.equal(await fs.readFile(cache+'.run.lock','utf8'),'synthetic');
});
test('changed generation retains previous immutable shard for cached manifests',async t=>{
  const {root,f}=await setupStage(t);const next=fixture(99);
  const out=await stage({root,run:()=>{
    sync.mkdirSync(path.join(root,'public'));
    sync.writeFileSync(path.join(root,'public',MANIFEST),next.bytes);
    sync.writeFileSync(path.join(root,'public',next.meta.name),next.body);
    return {status:0};
  }});
  assert.equal(out.changed,true);assert.deepEqual(await fs.readFile(path.join(root,'public',f.meta.name)),f.body);
  await validate(path.join(root,'public'));
});
test('failed live verification leaves the old meaningful audit intact',async t=>{
  const root=await dir(t);await writeData(path.join(root,'public'),fixture(99));await fs.mkdir(path.join(root,'data'));
  await fs.writeFile(path.join(root,'data','latest-manifest.json'),'old-snapshot');
  await assert.rejects(verify({root,base:BASE,fetchImpl:transport(fixture()),retries:1,delay:0}),/verification failed/);
  assert.equal(await fs.readFile(path.join(root,'data','latest-manifest.json'),'utf8'),'old-snapshot');
});
test('successful live verification records exact source manifest without timestamp-only churn',async t=>{
  const root=await dir(t),f=fixture();await writeData(path.join(root,'public'),f);
  const out=await verify({root,base:BASE,fetchImpl:transport(f),retries:1});
  assert.equal(out.verified,true);assert.deepEqual(await fs.readFile(path.join(root,'data','latest-manifest.json')),f.bytes);
});
test('byte-correct publication without cross-origin access cannot be recorded as successful',async t=>{
  const root=await dir(t),f=fixture();await writeData(path.join(root,'public'),f);
  await assert.rejects(verify({root,base:BASE,fetchImpl:transport(f,{cors:false}),retries:1}),/verification failed/);
  assert.equal(await fs.stat(path.join(root,'data','latest-manifest.json')).catch(()=>null),null);
});
test('public output rejects stray environment or secret files',async t=>{
  const root=await dir(t);await writeData(root);await fs.writeFile(path.join(root,'.env'),'SYNTHETIC=not-a-secret');
  await assert.rejects(validate(root),/Unexpected/);
});
test('workflow is pinned, manual/scheduled only, and scopes secrets to deploy',async()=>{
  const y=await fs.readFile(path.join(__dirname,'..','.github','workflows','daily-history.yml'),'utf8');
  assert.match(y,/cron: '17 8 \* \* \*'/);assert.match(y,/workflow_dispatch:/);assert.doesNotMatch(y,/\n  push:/);
  assert.match(y,/cancel-in-progress: false/);assert.match(y,/permissions: \{\}/);assert.match(y,/contents: write/);
  for(const line of y.split('\n').filter(x=>x.includes('uses:')))assert.match(line,/@[a-f0-9]{40}(?:\s|$)/);
  assert.ok(y.indexOf('node scripts/verify-live.cjs')<y.indexOf('git add -- data/latest-manifest.json'));
  assert.equal((y.match(/secrets\.CF_API_TOKEN/g)||[]).length,1);assert.doesNotMatch(y,/SHOPIFY|printenv|set -x/);
  const pkg=JSON.parse(await fs.readFile(path.join(__dirname,'..','package.json')));
  assert.equal(pkg.devDependencies.wrangler,'4.163.0');
});

