'use strict';

async function checkProductionBranch({
  accountId=process.env.CLOUDFLARE_ACCOUNT_ID,
  token=process.env.CLOUDFLARE_API_TOKEN,
  project=process.env.CF_PAGES_PROJECT,
  branch=process.env.CF_PAGES_BRANCH,
  fetchImpl=fetch
}={}) {
  if(typeof accountId!=='string'||!/^[a-f0-9]{32}$/i.test(accountId))
    throw new Error('Cloudflare account ID is not configured correctly.');
  if(typeof token!=='string'||!token.trim()||token!==token.trim())
    throw new Error('Cloudflare API token is not configured correctly.');
  if(typeof project!=='string'||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project))
    throw new Error('Cloudflare Pages project is not configured correctly.');
  if(typeof branch!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(branch))
    throw new Error('Cloudflare Pages target branch is not configured correctly.');
  let response;
  try {
    response=await fetchImpl('https://api.cloudflare.com/client/v4/accounts/'+accountId+'/pages/projects/'+project,{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:'Bearer '+token,Accept:'application/json'}
    });
  } catch {
    throw new Error('Cloudflare project check could not reach the API; deployment stopped.');
  }
  if(!response.ok) {
    const status=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:'error';
    throw new Error('Cloudflare project check failed (HTTP '+status+'); deployment stopped.');
  }
  let data;
  try { data=await response.json(); }
  catch { throw new Error('Cloudflare project check returned invalid JSON; deployment stopped.'); }
  if(data?.success!==true||!data.result||typeof data.result!=='object'||Array.isArray(data.result))
    throw new Error('Cloudflare project check did not return a successful project response; deployment stopped.');
  if(data.result.name!==project)
    throw new Error('Cloudflare returned a different project; deployment stopped.');
  const actual=data.result.production_branch;
  if(typeof actual!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}$/.test(actual))
    throw new Error('Cloudflare project has no valid production branch; deployment stopped.');
  if(actual!==branch)
    throw new Error('Cloudflare production branch mismatch: actual '+JSON.stringify(actual)+', expected '+JSON.stringify(branch)+'. Deployment stopped.');
  return {project,productionBranch:actual};
}

if(require.main===module)checkProductionBranch().then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={checkProductionBranch};
