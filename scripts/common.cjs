'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const MANIFEST = 'vaulten-history-manifest.json';
const MAX_MANIFEST_BYTES = 256000;
const MAX_SHARD_BYTES = 450000;
const MAX_RAW_BYTES = 3 * 1024 * 1024;
const MAX_BASE64_CHARS = 400000;
const CATEGORIES = [1,2,3,68,71,80,92];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isHash = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const assert = (ok, message) => { if (!ok) throw new Error(message); };

function baseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('HISTORY_BASE_URL must be an HTTPS URL.'); }
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    !url.search && !url.hash && url.pathname === '/', 'HISTORY_BASE_URL must be a credential-free HTTPS origin.');
  assert(!/^(localhost|127\.|0\.|\[)/i.test(url.hostname), 'A public HTTPS data origin is required.');
  return url;
}
function parseManifest(bytes) {
  assert(bytes.length > 0 && bytes.length <= MAX_MANIFEST_BYTES, 'Manifest size is invalid.');
  let value; try { value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { throw new Error('Invalid manifest JSON or UTF-8.'); }
  assert(value.schemaVersion === 1 && value.currency === 'USD' && value.metric === 'marketPrice', 'Unsupported manifest schema, currency or metric.');
  assert(Array.isArray(value.shards) && value.shards.length > 0 && value.shards.length <= 1000, 'Invalid shard list.');
  assert(Array.isArray(value.days) && value.days.length === 30, 'Invalid history window.');
  let last = '';
  for (const day of value.days) {
    assert(typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      Number.isFinite(Date.parse(day + 'T00:00:00Z')) &&
      new Date(day + 'T00:00:00Z').toISOString().slice(0,10) === day &&
      day<=new Date().toISOString().slice(0,10) &&
      (!last || Date.parse(day)-Date.parse(last)===86400000), 'Invalid or nonconsecutive source dates.');
    last = day;
  }
  assert(typeof value.sourceLastUpdated === 'string' && Number.isFinite(Date.parse(value.sourceLastUpdated)),
    'Missing upstream update date.');
  const sourceTime=Date.parse(value.sourceLastUpdated);
  assert(sourceTime<=Date.now()+300000 && new Date(sourceTime).toISOString().slice(0,10)===value.days.at(-1),
    'Future source timestamp or source date inconsistent with history.');
  assert(Number.isSafeInteger(value.recordCount)&&value.recordCount>0,'Invalid dataset count.');
  const names = new Set(), buckets = new Set();
  for (const s of value.shards) {
    assert(Number.isSafeInteger(s.bucket) && s.bucket >= 0 && !buckets.has(s.bucket), 'Invalid or duplicate shard bucket.');
    assert(isHash(s.sha256) && isHash(s.rawSha256), 'Missing exact shard hashes.');
    const expected = 'vaulten-history-' + s.bucket + '-' + s.sha256.slice(0,16) + '.json';
    assert(s.name === expected && !names.has(s.name), 'Invalid, duplicated or non-immutable shard name.');
    assert(Number.isSafeInteger(s.bytes) && s.bytes > 0 && s.bytes <= MAX_SHARD_BYTES, 'Invalid shard byte count.');
    assert(Number.isSafeInteger(s.rawBytes) && s.rawBytes > 0 && s.rawBytes <= MAX_RAW_BYTES, 'Invalid raw byte count.');
    assert(Number.isSafeInteger(s.gzipBytes) && s.gzipBytes > 0 && s.gzipBytes <= MAX_SHARD_BYTES, 'Invalid gzip byte count.');
    assert(Number.isSafeInteger(s.recordCount) && s.recordCount >= 0, 'Invalid record count.');
    assert(Array.isArray(s.categoryIds) && s.categoryIds.length > 0 &&
      new Set(s.categoryIds).size===s.categoryIds.length && s.categoryIds.every(n=>CATEGORIES.includes(n)),
      'Invalid category list.');
    buckets.add(s.bucket); names.add(s.name);
  }
  assert(value.shards.reduce((n,s)=>n+s.recordCount,0)===value.recordCount,'Manifest record total mismatch.');
  return value;
}
function validateShard(bytes, meta, manifest) {
  assert(bytes.length === meta.bytes && sha256(bytes) === meta.sha256, 'Published shard SHA-256/size mismatch: ' + meta.name);
  let wrapper; try { wrapper = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { throw new Error('Invalid shard wrapper.'); }
  assert(wrapper.schemaVersion === 1 && wrapper.encoding === 'gzip-base64' && typeof wrapper.data === 'string' &&
    wrapper.data.length<=MAX_BASE64_CHARS &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(wrapper.data) && wrapper.data.length % 4 === 0, 'Invalid compressed wrapper.');
  const compressed = Buffer.from(wrapper.data, 'base64');
  assert(compressed.length === meta.gzipBytes, 'Gzip byte count mismatch.');
  let raw; try { raw = zlib.gunzipSync(compressed,{maxOutputLength:MAX_RAW_BYTES}); } catch { throw new Error('Invalid or oversized compressed shard.'); }
  assert(raw.length === meta.rawBytes && sha256(raw) === meta.rawSha256, 'Raw shard SHA-256/size mismatch.');
  let data; try { data = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)); } catch { throw new Error('Invalid raw shard JSON.'); }
  assert(data.schemaVersion === 1 && data.currency==='USD' && data.metric==='marketPrice' &&
    data.rows && typeof data.rows === 'object' && !Array.isArray(data.rows), 'Invalid raw shard structure.');
  assert(Array.isArray(data.days)&&data.days.length===30,'Invalid shard dates.');
  if(manifest)assert(JSON.stringify(data.days)===JSON.stringify(manifest.days),'Shard dates differ from manifest.');
  assert(Object.keys(data.rows).length === meta.recordCount, 'Record count mismatch.');
  const categories=new Set();
  for(const [key,row] of Object.entries(data.rows)) {
    const match=/^([1-9]\d*)\|([^|]+)$/.exec(key);
    assert(match&&Number.isSafeInteger(Number(match[1]))&&Math.floor(Number(match[1])/5000)===meta.bucket&&
      match[2].trim()===match[2],'Invalid product/printing identity or bucket.');
    assert(row&&CATEGORIES.includes(row.categoryId)&&Number.isSafeInteger(row.groupId)&&row.groupId>0,
      'Invalid row category/group.');
    assert(Array.isArray(row.prices)&&row.prices.length===30&&
      row.prices.every(v=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>0),'Invalid raw price series.');
    categories.add(row.categoryId);
  }
  const sorted=a=>JSON.stringify([...a].sort((x,y)=>x-y));
  assert(Array.isArray(data.categoryIds)&&new Set(data.categoryIds).size===data.categoryIds.length&&
    sorted(categories)===sorted(meta.categoryIds)&&sorted(categories)===sorted(data.categoryIds),'Shard category declarations differ from actual rows.');
  return data;
}
async function readLimited(response, maxBytes) {
  assert(response.ok, 'Public data HTTP status ' + response.status + '.');
  const declared = response.headers.get('content-length');
  if (declared) assert(Number(declared) <= maxBytes, 'Response is too large.');
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) { throw new Error('Response exceeded size limit.'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function fetchBytes(url, maxBytes, fetchImpl=fetch, requireCors=false) {
  const response = await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(30000),
    headers:{'User-Agent':'VaultenTCGHistoryBuild/1.0 (+https://vaultentcg.com)','Cache-Control':'no-cache'}});
  if(requireCors)assert(response.headers.get('access-control-allow-origin')==='*','Public response is missing the required CORS header.');
  return readLimited(response,maxBytes);
}
async function loadLocal(directory) {
  const bytes = await fs.readFile(path.join(directory,MANIFEST));
  const manifest = parseManifest(bytes);
  for (const shard of manifest.shards) validateShard(await fs.readFile(path.join(directory,shard.name)),shard,manifest);
  return {bytes,manifest};
}
async function published(base, {fetchImpl=fetch, directory, expectedBytes, query='',requireCors=false}={}) {
  const origin = baseUrl(base);
  const manifestUrl = new URL(MANIFEST,origin); if(query) manifestUrl.searchParams.set('verify',query);
  const bytes = await fetchBytes(manifestUrl,MAX_MANIFEST_BYTES,fetchImpl,requireCors);
  const manifest = parseManifest(bytes);
  if (expectedBytes) assert(bytes.equals(expectedBytes),'Published manifest differs from the complete staged build.');
  if (directory) { await fs.mkdir(directory,{recursive:true}); }
  // Four concurrent static-origin reads, bounded independently of source API limits.
  let next = 0;
  await Promise.all(Array.from({length:Math.min(4,manifest.shards.length)},async()=>{
    while (next < manifest.shards.length) {
      const meta = manifest.shards[next++];
      const body = await fetchBytes(new URL(meta.name,origin),MAX_SHARD_BYTES,fetchImpl,requireCors);
      validateShard(body,meta,manifest);
      if (directory) await fs.writeFile(path.join(directory,meta.name),body);
    }
  }));
  // A complete manifest is persisted only after every file was validated.
  if (directory) await fs.writeFile(path.join(directory,MANIFEST),bytes);
  return {bytes,manifest};
}
async function output(values) {
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT,Object.entries(values).map(([k,v])=>k+'='+v+'\n').join(''));
}
module.exports={MANIFEST,sha256,assert,baseUrl,parseManifest,validateShard,loadLocal,published,fetchBytes,output};

