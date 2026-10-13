import {makePlan,runResearch,computeResearch,normalizeInput} from './research.js';
const quotas=new Map();
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});}
export async function handleRequest(request,env,snapshot,assets,replay){
  const url=new URL(request.url);
  if(url.pathname==='/api/health')return json({ok:true,snapshotAsOf:snapshot.asOf,aiConfigured:Boolean(env.DEEPSEEK_API_KEY)});
  if(url.pathname==='/api/replay'){
    if(!replay)return json({message:'研究回放未生成'},404);
    const currentMeta=computeResearch(snapshot,normalizeInput(replay.input)).meta;
    const replayStale=currentMeta.asOf!==replay.meta.asOf||currentMeta.freshness==='历史截至日';
    const replayMeta={...replay.meta,latestTradingDay:currentMeta.latestTradingDay,isTradingDay:currentMeta.isTradingDay,
      freshness:replayStale?'历史截至日':currentMeta.freshness,confidence:replayStale?'低':replay.meta.confidence,
      confidenceBasis:replayStale?[...replay.meta.confidenceBasis,'保存案例早于最新证据或日历覆盖已过期；回放不改写原始截至日。']:replay.meta.confidenceBasis,
      mode:'SNAPSHOT',replay:true,replayedAt:Date.now(),originalGeneratedAt:replay.meta.generatedAt};
    return json({...replay,meta:replayMeta,ai:{...replay.ai,status:'REPLAY',reason:'此结果是保存的真实模型调用回放，不是本次实时生成'},plan:{...replay.plan,ai:{...replay.plan.ai,status:'REPLAY'}}});
  }
  if(['/api/plan','/api/research'].includes(url.pathname)){
    if(request.method!=='POST')return json({message:'请使用POST提交研究输入'},405);
    const bytes=await request.text();if(bytes.length>16000)return json({message:'请求过长'},413);
    let body;try{body=JSON.parse(bytes);}catch{return json({message:'请求不是有效JSON'},400);}
    const ip=request.headers.get('cf-connecting-ip')||request.headers.get('x-forwarded-for')||'local';
    const now=Date.now(),hit=quotas.get(ip);
    if(hit&&now-hit.at<60000&&hit.n>=8)return json({message:'研究请求较频繁，请一分钟后重试；可使用案例回放。'},429);
    if(!hit||now-hit.at>=60000)quotas.set(ip,{at:now,n:1});else hit.n++;
    if(quotas.size>1000)for(const [k,v]of quotas)if(now-v.at>60000)quotas.delete(k);
    try{return json(url.pathname==='/api/plan'?await makePlan(body.input||body,env):await runResearch(body.input||body,env,snapshot,{plan:body.plan}));}
    catch(e){return json({message:e.message||'研究执行失败；未生成默认结论'},400);}
  }
  const path=url.pathname==='/'?'/index.html':url.pathname,file=assets[path];
  if(file)return new Response(file.body,{headers:{'content-type':file.type,'x-content-type-options':'nosniff','cache-control':'no-cache','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors *"}});
  return json({message:'资源不存在'},404);
}
