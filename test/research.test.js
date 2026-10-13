import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {computeResearch,complianceBoundary,normalizeInput,makePlan,runResearch,validateRecord} from '../server/research.js';
import {handleRequest} from '../server/webHandler.js';
import {collectBundle} from '../server/researchProvider.js';
const snapshot=JSON.parse(fs.readFileSync(new URL('../data/snapshot.json',import.meta.url)));
const now=Date.parse('2026-10-13T22:00:00+08:00');
const input={index:'000001.SH',days:20,mode:'SNAPSHOT',question:'指数结构与参与度是否一致？'};
const clone=()=>structuredClone(snapshot);
const compute=(b=snapshot,i=input)=>computeResearch(b,normalizeInput(i),{now});
test('真实快照结构、区间端点与七维证据可复算',()=>{
  const r=compute();assert.equal(r.dimensions.length,7);
  const e=r.evidence.find(e=>e.id==='price.return');
  const [a,b]=e.rawInputs;assert.equal(e.value,Number(((b.close_price/a.close_price-1)*100).toFixed(2)));
  for(const e of r.evidence){assert.ok(e.requestId);assert.ok(e.endpoint.startsWith('/api/'));assert.ok(e.fields.length);assert.ok(e.rawInputs);assert.ok(Number.isFinite(e.dataTime));assert.ok(Number.isFinite(e.fetchedAt));assert.ok(e.caliber);}
  for(const c of r.claims)for(const id of c.evidenceIds)assert.ok(r.evidence.some(e=>e.id===id));
});
test('更换指数与区间实际改变计算',()=>{
  const a=compute(),b=compute(snapshot,{...input,index:'000300.SH',days:60});
  assert.notEqual(a.evidence[0].value,b.evidence[0].value);assert.equal(b.chart.length,61);assert.equal(a.chart.length,21);
});
test('历史不足不伪造均线或相对基准收益',()=>{
  const b=clone();b.histories[input.index].raw.item=b.histories[input.index].raw.item.slice(-5);
  const r=compute(b);assert.equal(r.dimensions[0].status,'PARTIAL');assert.equal(r.meta.confidence,'低');
  assert.ok(!r.evidence.some(e=>e.id==='price.ma20'));assert.ok(!r.evidence.some(e=>e.id==='price.return'));
  assert.ok(r.research.industry.rows.length);assert.ok(r.research.industry.rows.every(x=>x.relative===null));
});
test('历史来源时点缺失或过期不产生正常事实',()=>{
  for(const dataTime of [null,snapshot.asOf-86400000]){const b=clone();b.histories[input.index].dataTime=dataTime;assert.throws(()=>compute(b),/没有可用/);}
  const b=clone();b.histories['000016.SH'].dataTime=null;b.industry[0].record.dataTime=null;
  const r=compute(b);assert.ok(!r.evidence.some(e=>e.id==='style.000016.SH'));assert.ok(!r.research.industry.rows.some(x=>x.name===b.industry[0].name));
});
test('个股缺失不填零、不把部分集合当作全市场',()=>{
  const b=clone();b.breadth.stocks=b.breadth.stocks.slice(0,1);
  const d=compute(b).dimensions.find(d=>d.key==='breadth');assert.equal(d.status,'MISSING');assert.equal(d.evidenceIds.length,0);assert.equal(d.state,'暂不判断');
});
test('成分来源失败时不接受残余集合',()=>{
  const b=clone();b.breadth.members.pop();assert.equal(compute(b).dimensions.find(d=>d.key==='breadth').status,'MISSING');
});
test('来源过期时停止宽度正常归纳',()=>{
  const b=clone();for(const r of b.breadth.stocks)r.dataTime=b.asOf-86400000;
  const d=compute(b).dimensions.find(d=>d.key==='breadth');assert.equal(d.status,'STALE');assert.equal(d.state,'暂不判断');
});
test('两个行情响应冲突时不确认正常结构、不生成切换规则',()=>{
  const b=clone();b.snapshot.raw.item.find(x=>x.thscode===input.index).last_price+=100;
  const r=compute(b);assert.equal(r.dimensions[0].status,'CONFLICT');assert.equal(r.meta.confidence,'低');assert.equal(r.conditions.filter(x=>x.dimension==='structure').length,0);assert.match(r.contradiction.title,/冲突/);
});
test('无数据时不产生完整核心研判',()=>{
  const b=clone();b.histories[input.index].raw.item=[];assert.throws(()=>compute(b),/没有可用/);
});
test('情绪分页缺失不产生正常情绪结论',()=>{
  const b=clone();b.pools.up.complete=false;const d=compute(b).dimensions.find(d=>d.key==='sentiment');assert.equal(d.status,'PARTIAL');assert.equal(d.state,'证据不完整');
  const empty=clone();for(const p of Object.values(empty.pools)){p.total=0;p.records[0].raw.item=[];p.records[0].raw.pagination.total=0;}const observed=compute(empty).dimensions.find(d=>d.key==='sentiment');assert.equal(observed.status,'OK');assert.equal(observed.state,'没有有效封板样本');
});
test('未接入估值与事件不生成伪造事实',()=>{
  for(const key of ['valuation','events']){const d=compute().dimensions.find(d=>d.key===key);assert.equal(d.status,'MISSING');assert.equal(d.evidenceIds.length,0);}
});
test('确定性状态与切换条件使用同一分类规则',()=>{
  const r=compute();for(const key of ['structure','breadth','style','liquidity']){const met=r.conditions.filter(c=>c.dimension===key&&c.met);assert.equal(met.length,1);assert.equal(met[0].target,r.dimensions.find(d=>d.key===key).state);}
});
test('历史阶段只使用当时可得的数据',()=>{
  const r=compute();assert.equal(r.research.stage.rows.length,2);
  for(const row of r.research.stage.rows){const e=r.evidence.find(e=>e.id===row.evidenceIds[0]);assert.ok(e.rawInputs.every(x=>x.date_ms<=e.dataTime));assert.ok(e.dataTime<r.meta.asOf);}
});
test('四个二级研究都有实际结果和证据',()=>{
  const r=compute();for(const key of ['style','industry','risk','stage']){assert.ok(r.research[key].rows.length);for(const row of r.research[key].rows)for(const id of row.evidenceIds)assert.ok(r.evidence.some(e=>e.id===id));}
});
test('非交易日、盘中未完成日线有明确状态',()=>{
  const r=computeResearch(snapshot,normalizeInput(input),{now:Date.parse('2026-10-11T22:00:00+08:00')});assert.equal(r.meta.isTradingDay,false);assert.ok(r.notes.some(x=>x.includes('交易日历')));
  const intraday=computeResearch(snapshot,normalizeInput(input),{now:Date.parse('2026-10-13T10:00:00+08:00')});assert.ok(intraday.meta.asOf<snapshot.asOf);assert.notEqual(intraday.dimensions.find(d=>d.key==='breadth').status,'OK');
  const expired=computeResearch(snapshot,normalizeInput(input),{now:Date.parse('2026-10-19T22:00:00+08:00')});assert.equal(expired.meta.isTradingDay,null);assert.equal(expired.meta.confidence,'低');assert.ok(expired.notes.some(x=>x.includes('未覆盖今日')));
});
test('预测和买卖仓位请求被边界拦截',()=>{
  for(const q of ['预测明日涨跌','明天会涨还是跌','给我推荐仓位','建议买入什么股票','该不该买','该不该卖','现在抄底吗','Should I buy now?','Will the index rise tomorrow?','Predict next week returns','Guaranteed profits','portfolio allocation'])assert.ok(complianceBoundary(q),q);
  assert.equal(complianceBoundary(input.question),null);
});
test('输入不能调用非白名单指数与区间',()=>{
  assert.throws(()=>normalizeInput({...input,index:'evil'}));assert.throws(()=>normalizeInput({...input,days:999}));
});
test('模型未接通时明确规则计划，仍有任务来源',async()=>{
  const p=await makePlan(input,{});assert.equal(p.ai.status,'RULE');assert.equal(p.tasks.length,7);assert.ok(p.tasks.every(t=>t.source));assert.ok(p.signature);
});
test('LIVE失败明确切换真实快照，模型失败不伪装实时结果',async()=>{
  const r=await runResearch({...input,mode:'LIVE'},{},snapshot,{fetcher:async()=>{throw new Error('模拟网络中断');}});
  assert.equal(r.meta.mode,'SNAPSHOT');assert.equal(r.meta.failure.requested,'LIVE');assert.equal(r.meta.asOf,snapshot.asOf);assert.equal(r.ai.status,'RULE');assert.match(r.ai.reason,/未配置/);
});
test('模型引用不存在证据时拒绝解释',async()=>{
  const fake=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({answer:'有效回答',mainTension:{title:'虚假结论',detail:'无依据',evidenceIds:['fake','missing']},limitations:[],followups:[]})}}]}),{status:200});
  const r=await runResearch(input,{DEEPSEEK_API_KEY:'test-only'},snapshot,{fetcher:fake});assert.equal(r.ai.status,'RULE');assert.match(r.ai.reason,/校验/);assert.equal(r.aiTension,undefined);
});
test('模型解释中的英文交易建议被拒绝',async()=>{
  const plan=await makePlan(input,{});
  const fake=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({answer:'You should buy now',answerEvidenceIds:['price.close'],mainTension:{title:'证据不足',detail:'需继续核验',evidenceIds:['price.close','price.return']},limitations:[],followups:[]})}}]}),{status:200});
  const r=await runResearch(input,{DEEPSEEK_API_KEY:'test-only'},snapshot,{fetcher:fake});
  assert.equal(r.ai.status,'RULE');assert.ok(!r.answer.text.includes('buy now'));
});
test('篡改计划不能诱导执行任意工具',async()=>{
  const p=await makePlan(input,{});p.tasks[0].tool='arbitrary-url';const r=await runResearch(input,{},snapshot,{plan:p});assert.ok(r.plan.tasks.every(t=>t.tool!=='arbitrary-url'));
});
test('数据响应缺少时点时不采信',()=>{const r=structuredClone(snapshot.breadth.stocks[0]);r.dataTime=null;assert.equal(validateRecord(r,snapshot.asOf).status,'MISSING');});
test('公共API回放明确标记、拒绝非法请求',async()=>{
  const replay=JSON.parse(fs.readFileSync(new URL('../data/replays/default.json',import.meta.url)));
  const r=await handleRequest(new Request('http://test/api/replay'),{},snapshot,{},replay);const body=await r.json();assert.equal(body.ai.status,'REPLAY');assert.equal(body.meta.mode,'SNAPSHOT');
  const older={...replay,meta:{...replay.meta,asOf:replay.meta.asOf-86400000}};
  const oldResponse=await handleRequest(new Request('http://test/api/replay'),{},snapshot,{},older);const oldBody=await oldResponse.json();assert.equal(oldBody.meta.asOf,older.meta.asOf);assert.equal(oldBody.meta.confidence,'低');
  const bad=await handleRequest(new Request('http://test/api/research',{method:'POST',body:'invalid'}),{},snapshot,{},replay);assert.equal(bad.status,400);
});
test('取数阶段日历失败时停止，不能回退服务器时间',async()=>{
  await assert.rejects(()=>collectBundle('test-only',{fetcher:async()=>new Response(JSON.stringify({code:0,data:{timestamp:Date.now(),item:[]}}))}),/交易日历失败/);
});
