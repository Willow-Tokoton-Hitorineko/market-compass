import fs from 'node:fs';
import config from '../server/config.js';
import {collectBundle,shDate} from '../server/researchProvider.js';
const bundle=await collectBundle(config.fuyao.apiKey);
fs.mkdirSync('data',{recursive:true});
fs.writeFileSync('data/snapshot.json',JSON.stringify(bundle));
console.log(JSON.stringify({asOf:shDate(bundle.asOf),histories:Object.keys(bundle.histories),stocks:bundle.breadth.stocks.reduce((n,r)=>n+r.raw.item.length,0),expected:bundle.breadth.expected,pools:Object.fromEntries(Object.entries(bundle.pools).map(([k,v])=>[k,v?.total])),industry:bundle.industry.length,errors:bundle.errors},null,2));
