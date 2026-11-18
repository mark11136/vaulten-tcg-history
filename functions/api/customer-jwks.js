// Public verification keys only. This endpoint never receives or exchanges customer tokens.
const UPSTREAM = 'https://account.vaultentcg.com/authentication/.well-known/jwks.json';
const MAX_BYTES = 64000;
const CACHE_SECONDS = 300;
const CACHE_URL = 'https://vaulten-tcg-history.pages.dev/api/customer-jwks';
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, OPTIONS','X-Content-Type-Options':'nosniff'};

function json(value,status=200,cache=false) {
  return new Response(JSON.stringify(value),{status,headers:{...CORS,'Content-Type':'application/json; charset=utf-8','Cache-Control':cache?'public, max-age='+CACHE_SECONDS:'no-store'}});
}
function publicKeys(value) {
  if(!value || typeof value!=='object' || !Array.isArray(value.keys) || value.keys.length<1 || value.keys.length>20)throw Error('Invalid public keys');
  for(const key of value.keys)if(!key || typeof key!=='object' || Array.isArray(key) || ['d','p','q','dp','dq','qi','oth','k'].some(name=>Object.hasOwn(key,name)))throw Error('Invalid public key');
  // Shopify publishes other signing algorithms alongside the RS256 ID-token key.
  // Only the algorithm advertised for ID tokens is exposed by this endpoint.
  const candidates=value.keys.filter(key=>key.kty==='RSA' && (key.alg==null || key.alg==='RS256') && (key.use==null || key.use==='sig'));
  if(!candidates.length)throw Error('RS256 keys unavailable');
  const ids=new Set();
  const keys=candidates.map(key=>{
    if(!key || typeof key!=='object' || Array.isArray(key) || key.kty!=='RSA' ||
      key.alg!=null && key.alg!=='RS256' || key.use!=null && key.use!=='sig' ||
      typeof key.kid!=='string' || !key.kid || key.kid.length>200 || /[\u0000-\u0020\u007f]/.test(key.kid) || ids.has(key.kid) ||
      ['d','p','q','dp','dq','qi','oth','k'].some(name=>Object.hasOwn(key,name)) ||
      typeof key.n!=='string' || !/^[A-Za-z0-9_-]{342,1366}$/.test(key.n) ||
      typeof key.e!=='string' || !/^[A-Za-z0-9_-]{1,16}$/.test(key.e))throw Error('Invalid public key');
    const modulus=atob(key.n.replace(/-/g,'+').replace(/_/g,'/')),exponent=atob(key.e.replace(/-/g,'+').replace(/_/g,'/'));
    if(modulus.length<256 || modulus.length>1024 || modulus.charCodeAt(0)<128 || exponent.length<1 || exponent.length>8 || exponent.charCodeAt(exponent.length-1)%2!==1)throw Error('Invalid RSA parameters');
    let e=0n;for(const ch of exponent)e=(e<<8n)|BigInt(ch.charCodeAt(0));if(e<3n)throw Error('Invalid RSA exponent');
    ids.add(key.kid);
    return {kty:'RSA',kid:key.kid,use:'sig',alg:'RS256',n:key.n,e:key.e};
  });
  return {keys};
}
async function boundedJson(response) {
  if(!response.ok || !String(response.headers.get('content-type')).toLowerCase().startsWith('application/json') || Number(response.headers.get('content-length'))>MAX_BYTES)throw Error('Keys unavailable');
  const reader=response.body?.getReader();if(!reader)throw Error('Keys unavailable');
  const chunks=[];let size=0;
  try{
    while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>MAX_BYTES)throw Error('Keys too large');chunks.push(next.value);}
    const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createHandler(deps={}) {
  const fetcher=deps.fetch || globalThis.fetch,cache=deps.cache===undefined?globalThis.caches?.default:deps.cache;
  const timeout=deps.setTimeout || setTimeout,clear=deps.clearTimeout || clearTimeout;
  return async function(context) {
    const request=context.request,url=new URL(request.url);
    if(url.search)return json({error:'Unexpected query parameters'},400);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...CORS,'Access-Control-Max-Age':'300','Cache-Control':'public, max-age=300'}});
    if(request.method!=='GET')return new Response(null,{status:405,headers:{...CORS,Allow:'GET, OPTIONS','Cache-Control':'no-store'}});
    const cacheKey=new Request(CACHE_URL,{method:'GET'});
    if(cache){try{const hit=await cache.match(cacheKey);if(hit)return hit;}catch(_){}}
    const controller=new AbortController(),timer=timeout(()=>controller.abort(),10000);
    try{
      const upstream=await fetcher(UPSTREAM,{method:'GET',headers:{Accept:'application/json'},credentials:'omit',redirect:'error',signal:controller.signal});
      const normalized=publicKeys(await boundedJson(upstream)),answer=json(normalized,200,true);
      if(cache){const saving=cache.put(cacheKey,answer.clone()).catch(()=>{});if(context.waitUntil)context.waitUntil(saving);else await saving;}
      return answer;
    }catch(_){return json({error:'Verification keys temporarily unavailable'},502);}
    finally{clear(timer);}
  };
}
export const onRequest=createHandler();
export {publicKeys,MAX_BYTES};
