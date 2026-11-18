'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {assert,MANIFEST,loadLocal,output}=require('./common.cjs');
async function stage({root=process.cwd(),run,redeploy=false,event=process.env.GITHUB_EVENT_NAME}={}) {
  const input=path.join(root,'.work','input'), destination=path.join(root,'public');
  const prior=await loadLocal(input);
  assert(!await fs.stat(destination).catch(()=>null),'Output directory must not already exist.');
  const kind=JSON.parse(await fs.readFile(path.join(root,'.work','source.json'),'utf8')).kind;
  const execute=run||((args)=>spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',maxBuffer:1024*1024}));
  if(redeploy) {
    assert(event==='workflow_dispatch','Redeployment is allowed only in an explicit manual workflow run.');
    assert(kind==='published','Redeployment requires the already verified published generation.');
  }
  const result=redeploy?{status:0,stdout:''}:execute([path.join(root,'scripts','incremental.cjs'),'--input-directory',input,'--output',destination,
    '--input-format','compressed','--cache-directory',path.join(root,'.work','archive-cache'),'--run']);
  // Preserve the observed source marker even if collection fails partway through.
  // This contains public timestamps only; child output is never blindly echoed.
  const checked=String(result.stdout||'').split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}})
    .find(row=>row?.status==='source_checked'&&Number.isFinite(Date.parse(row.sourceLastUpdated)));
  if(checked)await fs.writeFile(path.join(root,'.work','source-marker.json'),JSON.stringify({sourceLastUpdated:checked.sourceLastUpdated})+'\n');
  assert(result.status===0,'Incremental source update failed; no deployment will occur.');
  const hasManifest=!!await fs.stat(path.join(destination,MANIFEST)).catch(()=>null);
  if(!hasManifest && kind!=='seed' && !redeploy) return {changed:false,reason:'source-unchanged'};
  if(!hasManifest) {
    await fs.mkdir(destination,{recursive:true});
    for(const shard of prior.manifest.shards) await fs.copyFile(path.join(input,shard.name),path.join(destination,shard.name));
    await fs.writeFile(path.join(destination,MANIFEST),prior.bytes);
  }
  const next=await loadLocal(destination);
  assert(Date.parse(next.manifest.sourceLastUpdated)>=Date.parse(prior.manifest.sourceLastUpdated),'Source date moved backwards.');
  // Keep the preceding generation alive for clients holding the five-minute cached manifest.
  const currentNames=new Set(next.manifest.shards.map(x=>x.name));
  for(const shard of prior.manifest.shards) if(!currentNames.has(shard.name))
    await fs.copyFile(path.join(input,shard.name),path.join(destination,shard.name));
  await fs.copyFile(path.join(root,'static','_headers'),path.join(destination,'_headers'));
  return {changed:true,sourceLastUpdated:next.manifest.sourceLastUpdated,shards:next.manifest.shards.length,bootstrap:kind==='seed',redeploy};
}
if(require.main===module) stage({redeploy:process.env.REDEPLOY==='true'}).then(async x=>{
  await output({changed:String(x.changed)});console.log(JSON.stringify(x));
}).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={stage};

