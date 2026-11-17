'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {loadLocal,assert}=require('./common.cjs');
async function validate(directory) {
  const result=await loadLocal(directory);
  const names=await fs.readdir(directory);
  assert(names.length<=20000,'Cloudflare static file count exceeded.');
  for(const name of names) {
    assert(name==='_headers'||name==='vaulten-history-manifest.json'||/^vaulten-history-\d+-[a-f0-9]{16}\.json$/.test(name),'Unexpected public output file.');
    const stat=await fs.stat(path.join(directory,name));assert(stat.isFile()&&stat.size<=25*1024*1024,'Invalid static asset.');
  }
  return {valid:true,files:names.length,shards:result.manifest.shards.length,sourceLastUpdated:result.manifest.sourceLastUpdated};
}
if(require.main===module) validate(process.argv[2]||'public').then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={validate};

