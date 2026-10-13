import {handleRequest} from '../../server/webHandler.js';
import snapshot from '../../data/snapshot.json' with {type:'json'};
import replay from '../../data/replays/default.json' with {type:'json'};

export default async function handler(request,context){
  try{
    const url=new URL(request.url);
    url.pathname=url.pathname.replace(/^\/\.netlify\/functions\/research\/?/,'/api/');
    const headers=new Headers(request.headers);
    if(context?.ip)headers.set('cf-connecting-ip',context.ip);
    return await handleRequest(new Request(url,new Request(request,{headers})),process.env,snapshot,{},replay);
  }catch{return Response.json({message:'研究服务处理失败，未生成默认结论'},{status:500});}
}
