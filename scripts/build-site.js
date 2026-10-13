import fs from 'node:fs';
import path from 'node:path';
import {build} from 'esbuild';
const root=process.cwd(),site=path.join(root,'sites','market-compass');
fs.mkdirSync(path.join(site,'worker'),{recursive:true});
const input=path.join(root,'.cache','worker-entry.js');
fs.mkdirSync(path.dirname(input),{recursive:true});
fs.writeFileSync(input,`import {handleRequest} from '../server/webHandler.js';
import snapshot from '../data/snapshot.json';
import replay from '../data/replays/default.json';
import html from '../public/index.html';
import css from '../public/styles.css';
import js from '../public/app.js';
export default {async fetch(request,env){try{return await handleRequest(request,env,snapshot,{'/index.html':{body:html,type:'text/html; charset=utf-8'},'/styles.css':{body:css,type:'text/css; charset=utf-8'},'/app.js':{body:js,type:'text/javascript; charset=utf-8'}},replay);}catch{return new Response(JSON.stringify({message:'服务处理失败，未生成结论'}),{status:500,headers:{'content-type':'application/json'}});}}};`);
await build({entryPoints:[input],outfile:path.join(site,'worker','index.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',loader:{'.html':'text','.css':'text'},plugins:[{name:'browser-script-as-text',setup(b){b.onLoad({filter:/public[\\/]app\.js$/},args=>({contents:'export default '+JSON.stringify(fs.readFileSync(args.path,'utf8')),loader:'js'}));}}],minify:false});
const dist=path.join(site,'dist');
fs.mkdirSync(path.join(dist,'server'),{recursive:true});fs.mkdirSync(path.join(dist,'.openai'),{recursive:true});
fs.copyFileSync(path.join(site,'worker','index.js'),path.join(dist,'server','index.js'));
fs.copyFileSync(path.join(site,'.openai','hosting.json'),path.join(dist,'.openai','hosting.json'));
// Keep the complete sanitized source reproducible in the hosted repository.
for(const name of ['server','public','data','docs','test','scripts']){
  fs.cpSync(path.join(root,name),path.join(site,'source',name),{recursive:true});
}
for(const name of ['package.json','package-lock.json','README.md','.env.example','.gitignore','LICENSE','NOTICE','01_AI驱动的股票市场大势研判.md'])fs.copyFileSync(path.join(root,name),path.join(site,'source',name));
fs.mkdirSync(path.join(site,'source','sites','market-compass','.openai'),{recursive:true});
fs.copyFileSync(path.join(site,'.openai','hosting.json'),path.join(site,'source','sites','market-compass','.openai','hosting.json'));
console.log('Built Sites Worker: '+(fs.statSync(path.join(dist,'server','index.js')).size/1024).toFixed(0)+' KB; sanitized source included.');
