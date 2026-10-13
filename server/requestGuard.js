// Instance-scoped protection; deliberately not described as a global billing cap.
export function createRequestGuard({maxCalls=80,maxConcurrent=2,ttl=120000,clock=Date.now}={}){
  const cache=new Map(),pending=new Map();let active=0,calls=0,day='';
  const error=message=>Object.assign(new Error(message),{status:429});
  return async function execute(key,task){
    const now=clock(),today=new Date(now).toISOString().slice(0,10);
    if(today!==day){day=today;calls=0;}
    const hit=cache.get(key);if(hit&&now-hit.at<ttl)return {value:structuredClone(hit.value),reused:true};
    if(pending.has(key))return {value:structuredClone(await pending.get(key)),reused:true};
    if(calls>=maxCalls)throw error('本服务实例今日在线研究额度已用完，请使用案例回放查看完整研究与证据。');
    if(active>=maxConcurrent)throw error('在线研究正在处理其他请求，请稍后重试；案例回放仍可使用。');
    calls++;active++;
    const work=Promise.resolve().then(task);pending.set(key,work);
    try{const value=await work;cache.set(key,{at:clock(),value:structuredClone(value)});if(cache.size>200)cache.delete(cache.keys().next().value);return {value,reused:false};}
    finally{active--;pending.delete(key);}
  };
}
