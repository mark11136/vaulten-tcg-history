'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {MANIFEST,sha256,published,loadLocal}=require('./common.cjs');
async function verify({root=process.cwd(),base=process.env.HISTORY_BASE_URL,fetchImpl,retries=6,delay=10000}={}) {
  const expected=await loadLocal(path.join(root,'public'));
  let result;
  for(let i=0;i<retries;i++) {
    try { result=await published(base,{fetchImpl,expectedBytes:expected.bytes,query:sha256(expected.bytes)+'-'+i,requireCors:true});break; }
    catch { if(i===retries-1)throw new Error('Live publication verification failed; the repository audit was not updated. Inspect the Cloudflare deployment before retrying.');await new Promise(r=>setTimeout(r,delay)); }
  }
  await fs.mkdir(path.join(root,'data'),{recursive:true});
  // Meaningful source-data audit, only after the complete live data generation passed.
  await fs.writeFile(path.join(root,'data','latest-manifest.json'),result.bytes);
  return {verified:true,manifestSha256:sha256(result.bytes),sourceLastUpdated:result.manifest.sourceLastUpdated,shards:result.manifest.shards.length};
}
if(require.main===module)verify().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={verify};

