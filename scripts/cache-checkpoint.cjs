'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {output}=require('./common.cjs');
async function checkpoint(root=process.cwd()) {
  const directory=path.join(root,'.work','archive-cache');
  if(!await fs.stat(path.join(directory,'request-ledger.json')).catch(()=>null))return {present:false,marker:'none'};
  const marker=await fs.readFile(path.join(root,'.work','source-marker.json'),'utf8').then(JSON.parse).catch(()=>null);
  const stamp=marker&&Number.isFinite(Date.parse(marker.sourceLastUpdated))?
    new Date(marker.sourceLastUpdated).toISOString().replace(/[^0-9TZ]/g,''):'marker-unavailable';
  // Retain only two publication generations, plus the cross-generation request ledger.
  const generations=(await fs.readdir(directory,{withFileTypes:true}))
    .filter(x=>x.isDirectory()&&!x.isSymbolicLink()&&/^\d{8}T\d{9}Z$/.test(x.name)).map(x=>x.name).sort().reverse();
  for(const name of generations.slice(2)) {
    const target=path.resolve(directory,name),parent=path.resolve(directory)+path.sep;
    if(!target.startsWith(parent)||path.dirname(target)!==path.resolve(directory))throw new Error('Unsafe cache generation path.');
    await fs.rm(target,{recursive:true,force:true});
  }
  // The lock is a sibling of this directory and is deliberately excluded from cache.
  // The run suffix permits saving a fuller checkpoint after a partial failed run.
  return {present:true,marker:stamp,retainedGenerations:generations.slice(0,2)};
}
if(require.main===module)checkpoint().then(async x=>{await output({present:String(x.present),marker:x.marker});console.log(JSON.stringify(x));})
 .catch(()=>{console.error('Source cache checkpoint could not be prepared.');process.exitCode=1;});
module.exports={checkpoint};
