'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {assert,baseUrl,loadLocal,published,output,MANIFEST} = require('./common.cjs');

async function source({root=process.cwd(),base=process.env.HISTORY_BASE_URL,bootstrap=false,event=process.env.GITHUB_EVENT_NAME,fetchImpl}={}) {
  baseUrl(base);
  const directory=path.join(root,'.work','input');
  assert(!await fs.stat(directory).catch(()=>null),'Input staging directory already exists; use a fresh run directory.');
  let result, kind;
  if (bootstrap) {
    assert(event==='workflow_dispatch','Seed bootstrap is allowed only in an explicit manual workflow run.');
    assert(!await fs.stat(path.join(root,'data','latest-manifest.json')).catch(()=>null),'Bootstrap refused: this repository already records a published data generation.');
    result=await loadLocal(path.join(root,'seed')); kind='seed';
    await fs.mkdir(directory,{recursive:true});
    for(const s of result.manifest.shards) await fs.copyFile(path.join(root,'seed',s.name),path.join(directory,s.name));
    await fs.writeFile(path.join(directory,MANIFEST),result.bytes);
  } else {
    // Never fall back to an old seed on a network, integrity or upstream-host failure.
    result=await published(base,{directory,fetchImpl}); kind='published';
    const audit=await fs.readFile(path.join(root,'data','latest-manifest.json')).catch(()=>null);
    if(audit) {
      const previous=JSON.parse(audit);
      assert(Date.parse(result.manifest.sourceLastUpdated)>=Date.parse(previous.sourceLastUpdated),
        'Public data is older than the recorded successful deployment.');
    }
  }
  await fs.writeFile(path.join(root,'.work','source.json'),JSON.stringify({kind,sourceLastUpdated:result.manifest.sourceLastUpdated},null,2)+'\n');
  return {kind,shards:result.manifest.shards.length,sourceLastUpdated:result.manifest.sourceLastUpdated};
}
if(require.main===module) source({bootstrap:process.env.BOOTSTRAP==='true'}).then(async x=>{
  await output({source:x.kind});console.log(JSON.stringify(x));
}).catch(()=>{console.error('Input acquisition failed; no deployment attempted. Check origin, bootstrap setting and data integrity.');process.exitCode=1;});
module.exports={source};

