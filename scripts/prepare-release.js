import fs from 'node:fs';
import path from 'node:path';
const target=path.resolve('.cache/github-release');
fs.mkdirSync(target,{recursive:true});
for(const dir of ['api','server','public','data','test','scripts'])fs.cpSync(dir,path.join(target,dir),{recursive:true});
fs.mkdirSync(path.join(target,'docs'),{recursive:true});
for(const file of fs.readdirSync('docs').filter(x=>x.endsWith('.md')))fs.copyFileSync(path.join('docs',file),path.join(target,'docs',file));
for(const file of ['README.md','LICENSE','NOTICE','.env.example','.gitignore','.vercelignore','vercel.json','package.json','package-lock.json','01_AI驱动的股票市场大势研判.md'])fs.copyFileSync(file,path.join(target,file));
const deployment=path.join(target,'sites','market-compass');fs.mkdirSync(path.join(deployment,'.openai'),{recursive:true});fs.mkdirSync(path.join(deployment,'worker'),{recursive:true});fs.mkdirSync(path.join(deployment,'scripts'),{recursive:true});
for(const file of ['.openai/hosting.json','worker/index.js','scripts/build.mjs','scripts/validate-artifact.mjs','package.json','.gitignore'])fs.copyFileSync(path.join('sites','market-compass',file),path.join(deployment,file));
// Generated Worker is ignored by source repo and reproducible via npm run build.
const candidates=[];
function scan(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name==='.git'||e.name==='node_modules')continue;const p=path.join(dir,e.name);if(e.isDirectory())scan(p);else{candidates.push(p);if(e.name==='.env'||e.name.endsWith('.log'))throw new Error('Forbidden release file: '+e.name);if(/sk-[a-zA-Z0-9_-]{20,}/.test(fs.readFileSync(p,'utf8')))throw new Error('Credential detected in release file');}}}
scan(target);
console.log(JSON.stringify({releaseDirectory:target,files:candidates.length,totalBytes:candidates.reduce((n,p)=>n+fs.statSync(p).size,0),secretMatches:0}));
