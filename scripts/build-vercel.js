import fs from 'node:fs';
for(const f of ['public/index.html','public/styles.css','public/app.js','data/snapshot.json','data/replays/default.json'])if(!fs.existsSync(f))throw new Error('Missing deployment input '+f);
console.log('Static frontend and Node Serverless API ready. Secrets are runtime environment only.');
