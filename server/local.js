import http from 'node:http';
import fs from 'node:fs';
import './config.js';
import {handleRequest} from './webHandler.js';
const snapshot=JSON.parse(fs.readFileSync(new URL('../data/snapshot.json',import.meta.url)));
const replayPath=new URL('../data/replays/default.json',import.meta.url);
const replay=fs.existsSync(replayPath)?JSON.parse(fs.readFileSync(replayPath)):null;
const server=http.createServer(async(req,res)=>{
  try{
    const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>16000){res.writeHead(413);res.end('请求过长');return;}chunks.push(c);}
    const headers=new Headers();for(const [k,v]of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(','):v);
    const request=new Request('http://localhost:'+Number(process.env.PORT||8787)+req.url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
    const assets=Object.fromEntries([['/index.html','text/html; charset=utf-8'],['/app.js','text/javascript; charset=utf-8'],['/styles.css','text/css; charset=utf-8']].map(([path,type])=>[path,{type,body:fs.readFileSync(new URL('../public'+path,import.meta.url),'utf8')}]));
    const response=await handleRequest(request,process.env,snapshot,assets,replay);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({message:'服务处理失败，未生成结论'}));}
});
server.listen(Number(process.env.PORT||8787),'127.0.0.1',()=>console.log('大势罗盘 http://localhost:'+Number(process.env.PORT||8787)));
