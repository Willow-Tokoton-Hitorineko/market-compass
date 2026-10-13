import fs from 'node:fs';
import {handleRequest} from '../server/webHandler.js';
const snapshot=JSON.parse(fs.readFileSync(new URL('../data/snapshot.json',import.meta.url),'utf8'));
const replay=JSON.parse(fs.readFileSync(new URL('../data/replays/default.json',import.meta.url),'utf8'));
/** One Node Serverless Function, reusing the validated Worker/local handler. */
export default async function handler(req,res){
  try{
    const original=new URL(req.url,'https://market-compass.local');
    const route=String(req.query?.route||original.searchParams.get('route')||original.pathname.replace(/^\/api\//,''));
    const headers=new Headers();for(const [k,v]of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(','):v);
    let body;
    if(!['GET','HEAD'].includes(req.method)){
      if(req.body!==undefined)body=typeof req.body==='string'?req.body:JSON.stringify(req.body);
      else {const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16000){res.statusCode=413;res.end('Request too large');return;}chunks.push(chunk);}body=Buffer.concat(chunks).toString('utf8');}
    }
    const request=new Request('https://market-compass.local/api/'+route,{method:req.method,headers,...(body!==undefined?{body}:{})});
    const response=await handleRequest(request,process.env,snapshot,{},replay);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({message:'研究服务处理失败，未生成默认结论'}));}
}
