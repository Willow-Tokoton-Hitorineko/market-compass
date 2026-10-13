import fs from 'node:fs';
const file='data/snapshot.json',bundle=JSON.parse(fs.readFileSync(file));
fs.mkdirSync('.cache/raw',{recursive:true});fs.copyFileSync(file,'.cache/raw/snapshot-original.json');
// Retain exact analysis fields, timestamps and request IDs; exclude unused full quotes.
for(const r of bundle.breadth.stocks)r.raw.item=r.raw.item.map(x=>({thscode:x.thscode,price_change_ratio_pct:x.price_change_ratio_pct}));
for(const r of bundle.breadth.members)r.raw.item=r.raw.item.map(x=>({thscode:x.thscode}));
for(const p of Object.values(bundle.pools))if(p)for(const r of p.records)r.raw.item=r.raw.item.map(x=>({thscode:x.thscode,continue_day_cnt:x.continue_day_cnt??null}));
fs.writeFileSync(file,JSON.stringify(bundle));
console.log('Snapshot retains research fields only: '+fs.statSync(file).size+' bytes');
