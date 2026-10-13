import fs from 'node:fs';
fs.mkdirSync('dist/server',{recursive:true});fs.mkdirSync('dist/.openai',{recursive:true});
fs.copyFileSync('worker/index.js','dist/server/index.js');fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
console.log('Built Worker deployment files');
