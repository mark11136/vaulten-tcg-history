'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {checkProductionBranch}=require('../scripts/check-production-branch.cjs');
const settings={accountId:'a'.repeat(32),token:'synthetic-test-token-not-a-secret',project:'synthetic-vaulten',branch:'main'};
const success=()=>({success:true,result:{name:settings.project,production_branch:'main',deployment_configs:{production:{env_vars:{SYNTHETIC:{value:'do-not-log-metadata'}}}}}});
const reply=value=>async()=>new Response(JSON.stringify(value));

test('production guard uses the official read-only endpoint and returns only safe project and branch fields',async()=>{
  let calls=0;
  const result=await checkProductionBranch({...settings,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/'+settings.accountId+'/pages/projects/'+settings.project);
    assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+settings.token);
    assert.equal(options.headers.Accept,'application/json');assert.equal(options.body,undefined);
    return new Response(JSON.stringify(success()));
  }});
  assert.equal(calls,1);assert.deepEqual(result,{project:settings.project,productionBranch:'main'});
  assert.doesNotMatch(JSON.stringify(result),/do-not-log|synthetic-test-token|env_vars/);
});
test('production branch mismatch reports actual and wanted branch without returning project metadata',async()=>{
  const data=success();data.result.production_branch='production';
  await assert.rejects(checkProductionBranch({...settings,fetchImpl:reply(data)}),error=>{
    assert.match(error.message,/actual "production", expected "main"/);assert.doesNotMatch(error.message,/do-not-log|synthetic-test-token|env_vars/);return true;
  });
});
test('HTTP error stops deployment without reading or logging the response body',async()=>{
  let read=false;
  await assert.rejects(checkProductionBranch({...settings,fetchImpl:async()=>({ok:false,status:403,json:async()=>{read=true;throw Error('do-not-log-metadata')}})}),/HTTP 403/);
  assert.equal(read,false);
});
test('malformed JSON and unsuccessful API result fail closed with safe messages',async()=>{
  await assert.rejects(checkProductionBranch({...settings,fetchImpl:async()=>new Response('{ invalid do-not-log-metadata')}),error=>{
    assert.match(error.message,/invalid JSON/);assert.doesNotMatch(error.message,/do-not-log/);return true;
  });
  await assert.rejects(checkProductionBranch({...settings,fetchImpl:reply({success:false,errors:[{message:'do-not-log-metadata'}]})}),error=>{
    assert.match(error.message,/successful project response/);assert.doesNotMatch(error.message,/do-not-log/);return true;
  });
});
test('wrong project, missing production branch and unsafe branch text stop deployment',async()=>{
  for(const mutation of [d=>d.result.name='another-project',d=>delete d.result.production_branch,d=>d.result.production_branch='main\nunsafe-log-text']){
    const data=success();mutation(data);
    await assert.rejects(checkProductionBranch({...settings,fetchImpl:reply(data)}),error=>{assert.doesNotMatch(error.message,/unsafe-log-text/);return true;});
  }
});
test('network errors never echo credential-bearing exception text',async()=>{
  await assert.rejects(checkProductionBranch({...settings,fetchImpl:async()=>{throw Error('Bearer '+settings.token+' do-not-log-metadata')}}),error=>{
    assert.match(error.message,/could not reach/);assert.doesNotMatch(error.message,/synthetic-test-token|do-not-log|Bearer/);return true;
  });
});
test('invalid local configuration is rejected before any request',async()=>{
  for(const change of [{accountId:''},{token:''},{token:' token '},{project:'../other'},{branch:''}]){
    let called=false;await assert.rejects(checkProductionBranch({...settings,...change,fetchImpl:async()=>{called=true;return new Response(JSON.stringify(success()))}}));assert.equal(called,false);
  }
});
test('production guard runs immediately before Wrangler inside the existing secret-scoped deployment step',async()=>{
  const workflow=await fs.readFile(path.join(__dirname,'../.github/workflows/daily-history.yml'),'utf8');
  const deploy=workflow.slice(workflow.indexOf('      - name: Publish the complete static generation'),workflow.indexOf('      - name: Verify the actual public manifest'));
  assert.match(deploy,/node scripts\/check-production-branch\.cjs\n\s+npx --no-install wrangler pages deploy/);
  assert.equal((workflow.match(/secrets\.CF_API_TOKEN/g)||[]).length,1);
  assert.match(deploy,/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CF_API_TOKEN \}\}/);
});
