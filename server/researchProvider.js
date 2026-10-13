/** Portable data adapter. No secrets or Node APIs in this module. */
export const INDEXES = [
  {code:'000001.SH',name:'上证综指'}, {code:'000300.SH',name:'沪深300'},
  {code:'000852.SH',name:'中证1000'}, {code:'000016.SH',name:'上证50'},
  {code:'399006.SZ',name:'创业板指'},
];
export const DAY = 86400000;
export const shDate = ms => new Date(ms).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
export async function requestData(key, endpoint, query={}, fetcher=fetch) {
  if(!key) throw new Error('扶摇服务端凭据未配置');
  const url=new URL('https://fuyao.aicubes.cn'+endpoint);
  for(const [k,v] of Object.entries(query)) url.searchParams.set(k,Array.isArray(v)?v.join(','):String(v));
  const res=await fetcher(url,{headers:{'X-api-key':key,accept:'application/json'},signal:AbortSignal.timeout(12000)});
  if(!res.ok) throw new Error('扶摇 HTTP '+res.status);
  const body=await res.json();
  if(body.code!==0 || !body.data || !Array.isArray(body.data.item)) throw new Error('扶摇业务失败 '+(body.code??'响应结构不符'));
  return {endpoint,query,requestId:body.request_id,dataTime:body.data.timestamp,fetchedAt:Date.now(),raw:body.data};
}
export async function collectBundle(key,{fetcher=fetch,includeIndustry=true,primaryIndex=null,taskOrder=['structure','breadth','style','liquidity','sentiment']}={}) {
  const errors=[];
  const call=async (endpoint,query={})=>{try{return await requestData(key,endpoint,query,fetcher);}catch(e){errors.push({endpoint,query,reason:e.message});return null;}};
  const calendar=await call('/api/a-share/calendar/trading-days');
  if(!calendar?.raw.item.length) throw new Error('交易日历失败，无法建立可信时点');
  const today=shDate(Date.now());
  const days=calendar.raw.item.filter(x=>shDate(x.date_ms)<=today).sort((a,b)=>a.date_ms-b.date_ms);
  const asOf=days.at(-1)?.date_ms;
  if(!asOf) throw new Error('未返回可用交易日');
  const histories={},members=[],stocks=[],pools={},executedTasks=[];
  let codes=[],snapshot=null;
  const history=async code=>{
    if(!(code in histories))histories[code]=await call('/api/a-share-index/prices/historical',{thscode:code,interval:'1d',start:asOf-420*DAY,end:asOf+DAY-1});
  };
  const tools={
    structure:async()=>{
      for(const code of primaryIndex?[primaryIndex]:INDEXES.map(x=>x.code))await history(code);
      snapshot=await call('/api/a-share-index/prices/snapshot',{thscodes:primaryIndex?[primaryIndex]:INDEXES.map(x=>x.code)});
    },
    style:async()=>{for(const code of ['000016.SH','000852.SH','399006.SZ'])await history(code);},
    liquidity:async()=>history(primaryIndex||'000001.SH'),
    breadth:async()=>{
      for(const code of ['000300.SH','000905.SH','000852.SH']){
        const r=await call('/api/a-share-index/constituents/ths-stock-list',{thscode:code});if(r)members.push(r);
      }
      codes=[...new Set(members.flatMap(r=>r.raw.item.map(x=>x.thscode)))];
      for(let i=0;i<codes.length;i+=200){const r=await call('/api/a-share/prices/snapshot',{thscodes:codes.slice(i,i+200)});if(r)stocks.push(r);}
    },
    sentiment:async()=>{for(const type of ['up','down','break']){
    const endpoint='/api/a-share/special-data/limit-'+type+'-pool';
    const first=await call(endpoint,{date_ms:asOf,page:1,size:200});
    if(!first){pools[type]=null;continue;}
    const records=[first];
    const pages=first.raw.pagination?.pages??1;
    for(let page=2;page<=Math.min(pages,10);page++){
      const r=await call(endpoint,{date_ms:asOf,page,size:200});if(r) records.push(r);
    }
    pools[type]={records,total:first.raw.pagination?.total??first.raw.item.length,complete:records.length===pages};
    }},
  };
  for(const key of [...new Set(taskOrder)])if(tools[key]){await tools[key]();executedTasks.push(key);}
  if(!histories[primaryIndex||'000001.SH']?.raw.item.length)throw new Error('所选指数核心历史取数失败');
  let industry=[];
  if(includeIndustry){
    const catalog=await call('/api/a-share-index/catalog/ths-index-list',{tag:'industry'});
    // Explicit cross-industry observation set; never a whole-industry ranking.
    const names=['银行','证券','半导体','软件开发','电力','化学制药','汽车整车','白酒'];
    const selected=names.map(name=>(catalog?.raw.item??[]).find(x=>x.name===name)).filter(Boolean);
    for(const name of names)if(!selected.some(x=>x.name===name))errors.push({endpoint:'/api/a-share-index/catalog/ths-index-list',query:{name},reason:'指定行业样本未返回'});
    for(const x of selected){
      const r=await call('/api/a-share-index/prices/historical',{thscode:x.thscode,interval:'1d',start:asOf-220*DAY,end:asOf+DAY-1});
      if(r) industry.push({code:x.thscode,name:x.name,record:r});
    }
  }
  return {schemaVersion:1,capturedAt:Date.now(),asOf,calendar,histories,snapshot,executedTasks,
    breadth:{members,stocks,expected:codes.length,expectedGroups:3},pools,industry,errors,
    source:'扶摇金融数据 API',limitations:['宽度采用沪深300、中证500、中证1000当前成分股并集，不代表全部A股；仅描述截至日横截面。','估值接口仅支持个股，未提供指数估值。','资讯事件接口仅供同花顺AI客户端，当前公开Web未接入。']};
}
