import fs from 'node:fs';
import './capture-config.js';
import {makePlan,runResearch} from '../server/research.js';
const input={index:'000001.SH',days:20,question:'指数的价格结构与市场参与度是否一致？哪些证据会改变判断？',mode:'SNAPSHOT'};
const plan=await makePlan(input,process.env);
const r=await runResearch(input,process.env,JSON.parse(fs.readFileSync('data/snapshot.json')),{plan});
if(r.ai.status!=='LIVE')throw new Error('回放只能保存真实模型结果：'+r.ai.reason);
fs.writeFileSync('data/replays/default.json',JSON.stringify(r));
console.log(JSON.stringify({status:r.ai.status,model:r.ai.model,requestId:r.ai.requestId,planRequestId:r.ai.plan.requestId,asOf:r.meta.asOf,confidence:r.meta.confidence}));
