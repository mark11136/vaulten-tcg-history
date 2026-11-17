'use strict';
// Node 22+. Public data preparation only: no Shopify, deployment or scheduling.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const CATEGORIES={1:'mtg',2:'yugioh',3:'pokemon',68:'onepiece',71:'lorcana',80:'dragonball',92:'cyberpunk'};
const CATEGORY_IDS=Object.keys(CATEGORIES).map(Number),MAX_RAW=3*1024*1024,MAX_BASE64=400000;
const digest=(b,algorithm='sha256')=>crypto.createHash(algorithm).update(b).digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function isoDay(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw Error('Invalid date: '+value);return value;}
function rollingDays(end){const n=Date.parse(isoDay(end)+'T00:00:00Z');return Array.from({length:30},(_,i)=>new Date(n-(29-i)*86400000).toISOString().slice(0,10));}
function strictPrice(v){if(v==null||v===0||typeof v==='number'&&v<0)return null;if(typeof v!=='number'||!Number.isFinite(v))throw Error('Non-numeric or non-finite source price');return v;}
function atomicJson(filename,value){fs.mkdirSync(path.dirname(filename),{recursive:true});const temporary=filename+'.tmp-'+process.pid;fs.writeFileSync(temporary,JSON.stringify(value));fs.renameSync(temporary,filename);}
function safeFile(directory,name){if(typeof name!=='string'||!/^vaulten-history-\d+(?:-[a-f0-9]{16,64})?\.json$/.test(name))throw Error('Unsafe shard filename');return path.join(directory,name);}
function decodeShard(buffer,format='compressed'){
 const json=JSON.parse(buffer);let raw=buffer;
 if(json.encoding==='gzip-base64'){
  if(json.schemaVersion!==1||typeof json.data!=='string'||json.data.length>MAX_BASE64||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(json.data))throw Error('Invalid compressed envelope');
  raw=zlib.gunzipSync(Buffer.from(json.data,'base64'),{maxOutputLength:MAX_RAW});
 }else if(format!=='raw')throw Error('Raw input requires --input-format raw');
 if(raw.length>MAX_RAW)throw Error('Inflated shard exceeds frontend size limit');
 return {raw,data:JSON.parse(raw),publishedSha256:digest(buffer),rawSha256:digest(raw)};
}
function loadDataset(directory,manifestFile,format='compressed'){
 const manifest=JSON.parse(fs.readFileSync(manifestFile||path.join(directory,'vaulten-history-manifest.json'),'utf8'));
 if(manifest.schemaVersion!==1||manifest.currency!=='USD'||manifest.metric!=='marketPrice'||!Number.isFinite(Date.parse(manifest.sourceLastUpdated))||!Array.isArray(manifest.shards)||!Array.isArray(manifest.days)||manifest.days.length!==30)throw Error('Invalid input manifest');
 manifest.days.forEach((day,i)=>{isoDay(day);if(i&&Date.parse(day)-Date.parse(manifest.days[i-1])!==86400000)throw Error('Input dates not continuous');});
 const rows=new Map(),hashKinds=new Set(),buckets=new Set();
 for(const meta of manifest.shards){
  if(!Number.isSafeInteger(meta.bucket)||meta.bucket<0||buckets.has(meta.bucket))throw Error('Invalid or duplicate bucket');buckets.add(meta.bucket);
  const bytes=fs.readFileSync(safeFile(directory,meta.name)),decoded=decodeShard(bytes,format);
  if(meta.sha256===decoded.publishedSha256)hashKinds.add('published');else if(meta.sha256===decoded.rawSha256)hashKinds.add('legacy-raw');else throw Error('Input integrity mismatch: '+meta.name);
  if(meta.rawSha256&&meta.rawSha256!==decoded.rawSha256)throw Error('Raw integrity mismatch: '+meta.name);
  const shard=decoded.data;if(shard.schemaVersion!==1||shard.currency!=='USD'||shard.metric!=='marketPrice'||JSON.stringify(shard.days)!==JSON.stringify(manifest.days)||!shard.rows||typeof shard.rows!=='object')throw Error('Invalid shard contract');
  if(Object.keys(shard.rows).length!==meta.recordCount)throw Error('Record count mismatch');
  for(const[key,row]of Object.entries(shard.rows)){
   const m=/^(\d+)\|(.+)$/.exec(key);if(!m||!Number.isSafeInteger(Number(m[1]))||Number(m[1])<=0||Math.floor(Number(m[1])/5000)!==meta.bucket||!CATEGORY_IDS.includes(row.categoryId)||!Number.isSafeInteger(row.groupId)||!Array.isArray(row.prices)||row.prices.length!==30||rows.has(key))throw Error('Invalid row identity');
   if(row.prices.some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<=0)))throw Error('Invalid saved price');
   rows.set(key,{categoryId:row.categoryId,groupId:row.groupId,prices:[...row.prices]});
  }
 }
 if(rows.size!==manifest.recordCount)throw Error('Dataset count mismatch');
 const observed=manifest.observedDates||manifest.days;observed.forEach(isoDay);
 return {manifest,rows,hashKinds:[...hashKinds],observedDates:new Set(observed)};
}
function validateDay(snapshot){
 isoDay(snapshot.date);if(snapshot.complete!==true||!['daily','archive'].includes(snapshot.kind)||!Array.isArray(snapshot.entries))throw Error('Incomplete/untrusted day snapshot');
 if(JSON.stringify([...snapshot.categoryIds].sort((a,b)=>a-b))!==JSON.stringify(CATEGORY_IDS))throw Error('Incomplete category coverage');
 if(snapshot.kind==='daily'){
  const before=Date.parse(snapshot.sourceMarker),after=Date.parse(snapshot.markerAfter);if(!Number.isFinite(before)||before!==after||new Date(before).toISOString().slice(0,10)!==snapshot.date)throw Error('Mixed daily source publication');
 }else if(!/^[a-f0-9]{64}$/.test(snapshot.archiveSha256||''))throw Error('Archive provenance hash required');
 const unique=new Map();let normalizedMissing=0;
 for(const entry of snapshot.entries){
  if(!Number.isSafeInteger(entry.productId)||entry.productId<=0||typeof entry.subTypeName!=='string'||!entry.subTypeName||entry.subTypeName.trim()!==entry.subTypeName||entry.subTypeName.includes('|')||!CATEGORY_IDS.includes(entry.categoryId)||!Number.isSafeInteger(entry.groupId)||entry.groupId<=0)throw Error('Invalid source identity');
  const key=entry.productId+'|'+entry.subTypeName,value=strictPrice(entry.marketPrice),candidate={categoryId:entry.categoryId,groupId:entry.groupId,value};
  if(unique.has(key)){const prior=unique.get(key);if(prior.categoryId!==candidate.categoryId||prior.groupId!==candidate.groupId||prior.value!==candidate.value)throw Error('Conflicting product/category/group/price: '+key);continue;}
  if(value===null)normalizedMissing++;unique.set(key,candidate);
 }
 return {snapshot,unique,normalizedMissing};
}
function mergeSnapshots(previous,snapshots,now=new Date()){
 const validated=snapshots.map(validateDay).sort((a,b)=>a.snapshot.date.localeCompare(b.snapshot.date));
 const sourceDates=new Set();for(const x of validated){if(sourceDates.has(x.snapshot.date))throw Error('Duplicate snapshot date');sourceDates.add(x.snapshot.date);if(x.snapshot.date>now.toISOString().slice(0,10))throw Error('Future snapshot');}
 const end=[previous.manifest.days.at(-1),...validated.map(x=>x.snapshot.date)].sort().at(-1),days=rollingDays(end),index=new Map(days.map((d,i)=>[d,i])),oldIndex=new Map(previous.manifest.days.map((d,i)=>[d,i])),rows=new Map();
 for(const[key,row]of previous.rows)rows.set(key,{categoryId:row.categoryId,groupId:row.groupId,prices:days.map(d=>oldIndex.has(d)?row.prices[oldIndex.get(d)]:null)});
 const metadataDates=new Map([...rows.keys()].map(key=>[key,previous.manifest.days.at(-1)]));
 const observed=new Set([...previous.observedDates].filter(d=>index.has(d)));let sourceLastUpdated=previous.manifest.sourceLastUpdated;
 const applied=[];
 for(const{snapshot,unique,normalizedMissing}of validated){
  if(!index.has(snapshot.date))continue;const i=index.get(snapshot.date);
  for(const row of rows.values())row.prices[i]=null;
  for(const[key,item]of unique){
   let row=rows.get(key);if(!row){row={categoryId:item.categoryId,groupId:item.groupId,prices:days.map(()=>null)};rows.set(key,row);metadataDates.set(key,snapshot.date);}
   if(row.categoryId!==item.categoryId)throw Error('Cross-game product collision: '+key);
   if(snapshot.date>=metadataDates.get(key)){row.groupId=item.groupId;metadataDates.set(key,snapshot.date);}
   row.prices[i]=item.value;
  }
  observed.add(snapshot.date);if(snapshot.sourceMarker&&Date.parse(snapshot.sourceMarker)>Date.parse(sourceLastUpdated))sourceLastUpdated=snapshot.sourceMarker;
  applied.push({date:snapshot.date,kind:snapshot.kind,records:unique.size,missingPrices:normalizedMissing,archiveSha256:snapshot.archiveSha256||null});
 }
 return {rows,manifest:{...previous.manifest,days,sourceLastUpdated,observedDates:[...observed].sort(),gapDates:days.filter(d=>!observed.has(d)),categoryGames:CATEGORIES,recordCount:rows.size},applied};
}
function encodeDataset(dataset,now=new Date()){
 const buckets=new Map();for(const[key,row]of dataset.rows){const n=Math.floor(Number(key.split('|')[0])/5000);if(!buckets.has(n))buckets.set(n,[]);buckets.get(n).push([key,row]);}
 const files=new Map(),shards=[];
 for(const[bucket,entries]of [...buckets].sort((a,b)=>a[0]-b[0])){
  entries.sort((a,b)=>Number(a[0].split('|')[0])-Number(b[0].split('|')[0])||(a[0]<b[0]?-1:a[0]>b[0]?1:0));
  const categoryIds=[...new Set(entries.map(x=>x[1].categoryId))].sort((a,b)=>a-b),raw=Buffer.from(JSON.stringify({schemaVersion:1,source:'TCGCSV / TCGplayer',currency:'USD',metric:'marketPrice',days:dataset.manifest.days,categoryIds,rows:Object.fromEntries(entries)}));
  if(raw.length>MAX_RAW)throw Error('Shard exceeds frontend inflated limit: '+bucket);
  const gzip=zlib.gzipSync(raw,{level:9}),data=gzip.toString('base64');if(data.length>MAX_BASE64)throw Error('Shard exceeds frontend base64 limit: '+bucket);
  const bytes=Buffer.from(JSON.stringify({schemaVersion:1,encoding:'gzip-base64',data})),sha256=digest(bytes),name=`vaulten-history-${bucket}-${sha256.slice(0,16)}.json`;
  files.set(name,bytes);shards.push({bucket,name,sha256,rawSha256:digest(raw),md5:digest(bytes,'md5'),bytes:bytes.length,rawBytes:raw.length,gzipBytes:gzip.length,categoryIds,recordCount:entries.length});
 }
 const manifest={...dataset.manifest,schemaVersion:1,source:'TCGCSV / TCGplayer',currency:'USD',metric:'marketPrice',builtAt:now.toISOString(),bucketSize:5000,keyFormat:'productId|subTypeName',shards};
 files.set('vaulten-history-manifest.json',Buffer.from(JSON.stringify(manifest)));return {files,manifest};
}
function writeOutput(encoded,output,input){
 if(path.resolve(output)===path.resolve(input))throw Error('Output must differ from baseline');
 if(fs.existsSync(path.join(output,'vaulten-history-manifest.json')))throw Error('Output already has a committed manifest');
 fs.mkdirSync(output,{recursive:true});for(const[name,bytes]of encoded.files)if(name!=='vaulten-history-manifest.json')fs.writeFileSync(path.join(output,name),bytes,{flag:'wx'});
 fs.writeFileSync(path.join(output,'vaulten-history-manifest.json'),encoded.files.get('vaulten-history-manifest.json'),{flag:'wx'});
}
function createFetcher(cacheDirectory,options={}){
 const clock=options.clock||(()=>Date.now()),fetchImpl=options.fetch||fetch,sleep=options.sleep||pause;
 fs.mkdirSync(cacheDirectory,{recursive:true});const budgetFile=path.join(cacheDirectory,'request-ledger.json');
 let ledger=fs.existsSync(budgetFile)?JSON.parse(fs.readFileSync(budgetFile,'utf8')):[];let lastStart=0,networkRequests=0,cacheHits=0;
 async function request(url){
  await sleep(Math.max(0,300-(clock()-lastStart)));lastStart=clock();ledger=ledger.filter(x=>x>clock()-86400000);if(ledger.length>=9500)throw Error('Persistent 24-hour request budget exhausted');ledger.push(clock());atomicJson(budgetFile,ledger);networkRequests++;
  return fetchImpl(url,{headers:{'User-Agent':'VaultenTCGPricewatch/2.0 (+https://www.vaultentcg.com)','Accept':'application/json, text/plain;q=0.9'},signal:AbortSignal.timeout(30000)});
 }
 async function marker(){const r=await request('https://tcgcsv.com/last-updated.txt');if(!r.ok)throw Error('Source marker HTTP '+r.status);const text=(await r.text()).trim(),time=Date.parse(text);if(!Number.isFinite(time)||time>clock()+300000)throw Error('Invalid/future publication marker');return text;}
 async function jsonOnce(url,stamp,name,missingAllowed=false){
  const directory=path.join(cacheDirectory,stamp),file=path.join(directory,name),metadataFile=file+'.meta.json';
  if(fs.existsSync(file)){if(!fs.existsSync(metadataFile))throw Error('Unverified cached source: '+name);const bytes=fs.readFileSync(file),meta=JSON.parse(fs.readFileSync(metadataFile,'utf8'));if(meta.url!==url||meta.sha256!==digest(bytes))throw Error('Cached source integrity mismatch');cacheHits++;return JSON.parse(bytes);}
  const r=await request(url);if(!r.ok&&!(missingAllowed&&r.status===404))throw Error(`No automatic retry: HTTP ${r.status} ${url}`);
  const json=r.status===404?{success:false,status:404,results:[]}:await r.json();if(!Array.isArray(json.results)||(r.status!==404&&json.success!==true))throw Error('Invalid source collection '+url);
  const bytes=Buffer.from(JSON.stringify(json));fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(file+'.tmp',bytes);atomicJson(metadataFile,{url,sha256:digest(bytes),bytes:bytes.length,status:r.status,lastModified:r.headers.get('last-modified'),fetchedAt:new Date(clock()).toISOString()});fs.renameSync(file+'.tmp',file);return json;
 }
 return {marker,jsonOnce,stats:()=>({networkRequests,cacheHits,rolling24hRequests:ledger.length})};
}
async function collectDaily(sourceMarker,fetcher,onProgress=()=>{}){
 const stamp=new Date(Date.parse(sourceMarker)).toISOString().replace(/[^0-9TZ]/g,''),date=new Date(Date.parse(sourceMarker)).toISOString().slice(0,10),entries=[],groupCounts={};let missingGroups=0;
 const plans=[];
 for(const categoryId of CATEGORY_IDS){
  const groups=await fetcher.jsonOnce(`https://tcgcsv.com/tcgplayer/${categoryId}/groups`,stamp,`groups-${categoryId}.json`),seen=new Set();groupCounts[categoryId]=0;
  if(!groups.results.length)throw Error('Unexpected empty category');
  for(const group of groups.results){
   if(!Number.isSafeInteger(group.groupId)||group.groupId<=0||seen.has(group.groupId)||group.categoryId!=null&&group.categoryId!==categoryId)throw Error('Invalid/duplicate group or category');seen.add(group.groupId);
  }
  plans.push({categoryId,groups:groups.results});
 }
 const totalGroups=plans.reduce((n,p)=>n+p.groups.length,0);let completedGroups=0;
 onProgress({status:'sync_plan',date,totalGroups,categoryGroups:Object.fromEntries(plans.map(p=>[p.categoryId,p.groups.length])),minimumSeconds:Math.ceil(totalGroups*.3)});
 for(const{categoryId,groups}of plans){
  for(const group of groups){
   const prices=await fetcher.jsonOnce(`https://tcgcsv.com/tcgplayer/${categoryId}/${group.groupId}/prices`,stamp,`prices-${categoryId}-${group.groupId}.json`,true);
   completedGroups++;if(completedGroups%100===0)onProgress({status:'sync_progress',completedGroups,totalGroups,...fetcher.stats()});
   if(prices.status===404){missingGroups++;continue;}groupCounts[categoryId]++;
   for(const price of prices.results)entries.push({productId:price.productId,subTypeName:price.subTypeName,marketPrice:price.marketPrice,categoryId,groupId:group.groupId});
  }
 }
 const markerAfter=await fetcher.marker();return {date,kind:'daily',complete:true,sourceMarker,markerAfter,categoryIds:CATEGORY_IDS,entries,groupCounts,missingGroups};
}
function readBackfills(directory,allowedDates){
 if(!directory)return [];return fs.readdirSync(directory).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().map(n=>({name:n,date:n.slice(0,10)})).filter(x=>allowedDates.includes(x.date)).map(x=>{const j=JSON.parse(fs.readFileSync(path.join(directory,x.name),'utf8'));if(j.date!==x.date||j.kind!=='archive')throw Error('Wrong backfill identity');validateDay(j);return j;});
}
function parseArgs(argv){const args={};for(let i=0;i<argv.length;i++){const a=argv[i];if(['--run','--export-seed','--help'].includes(a))args[a.slice(2)]=true;else if(['--input-directory','--manifest-file','--output','--input-format','--cache-directory','--backfill-directory'].includes(a)){if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error('Missing value '+a);args[a.slice(2)]=argv[++i];}else throw Error('Unknown argument '+a);}return args;}
async function main(argv=process.argv.slice(2)){
 const args=parseArgs(argv);if(args.help||!args.run&&!args['export-seed']){console.log('node incremental.cjs --input-directory DIR --output NEW_DIR [--manifest-file FILE] [--input-format compressed|raw] [--cache-directory DIR] [--backfill-directory DIR] --run|--export-seed');return;}
 if(args.run&&args['export-seed']||!args['input-directory']||!args.output||!['compressed','raw'].includes(args['input-format']||'compressed'))throw Error('Invalid CLI options');
 const input=path.resolve(args['input-directory']),output=path.resolve(args.output),previous=loadDataset(input,args['manifest-file'],args['input-format']||'compressed');
 const cache=path.resolve(args['cache-directory']||path.join(path.dirname(output),'.tcgcsv-cache'));if(cache===output||cache.startsWith(output+path.sep))throw Error('Cache must be outside public output');
 if(args['export-seed']){
  const dataset={...previous,manifest:{...previous.manifest,observedDates:[...previous.observedDates].sort(),gapDates:previous.manifest.days.filter(d=>!previous.observedDates.has(d))}},encoded=encodeDataset(dataset);writeOutput(encoded,output,input);
  console.log(JSON.stringify({status:'seed_exported',output,records:previous.rows.size,shards:encoded.manifest.shards.length,inputHashKinds:previous.hashKinds,networkRequests:0}));return;
 }
 fs.mkdirSync(cache,{recursive:true});const lock=cache+'.run.lock';let lockFd;
 try{lockFd=fs.openSync(lock,'wx');fs.writeFileSync(lockFd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));}catch(e){if(e.code==='EEXIST')throw Error('Another run or stale lock exists; inspect '+lock);throw e;}
 try{
  const fetcher=createFetcher(cache),marker=await fetcher.marker(),markerDate=new Date(Date.parse(marker)).toISOString().slice(0,10);
  console.log(JSON.stringify({status:'source_checked',sourceLastUpdated:marker,sourceUtc:new Date(Date.parse(marker)).toISOString(),baselineSourceLastUpdated:previous.manifest.sourceLastUpdated}));
  const end=[previous.manifest.days.at(-1),markerDate].sort().at(-1),missingDates=rollingDays(end).filter(d=>d<markerDate&&!previous.observedDates.has(d));
  const backfills=readBackfills(args['backfill-directory'],missingDates),newMarker=Date.parse(marker)>Date.parse(previous.manifest.sourceLastUpdated);
  if(!newMarker&&!backfills.length){console.log(JSON.stringify({status:'unchanged',sourceLastUpdated:marker,...fetcher.stats(),outputCreated:false}));return;}
  const snapshots=[...backfills];if(newMarker)snapshots.push(await collectDaily(marker,fetcher,x=>console.log(JSON.stringify(x))));
  const dataset=mergeSnapshots(previous,snapshots),encoded=encodeDataset(dataset);writeOutput(encoded,output,input);
  const report={status:'built_not_deployed',sourceLastUpdated:dataset.manifest.sourceLastUpdated,range:{start:dataset.manifest.days[0],end:dataset.manifest.days.at(-1)},gapDates:dataset.manifest.gapDates,backfillDates:backfills.map(x=>x.date),records:dataset.rows.size,shards:encoded.manifest.shards.length,bytes:[...encoded.files.values()].reduce((n,x)=>n+x.length,0),output,applied:dataset.applied,...fetcher.stats(),archiveDownloads:0,shopifyWrites:0};
  atomicJson(path.join(cache,'last-build-report.json'),report);console.log(JSON.stringify(report));
 }finally{fs.closeSync(lockFd);fs.unlinkSync(lock);}
}
module.exports={CATEGORIES,CATEGORY_IDS,MAX_RAW,MAX_BASE64,digest,isoDay,rollingDays,strictPrice,decodeShard,loadDataset,validateDay,mergeSnapshots,encodeDataset,writeOutput,createFetcher,collectDaily,readBackfills,parseArgs,main};
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({status:'failed',message:e.message,publicDeploymentUntouched:true}));process.exitCode=1;});
