import {spawnSync} from 'node:child_process';
const r=spawnSync(process.execPath,['--test','test/run.test.js','test/research.test.js','test/requestGuard.test.js'],{stdio:'inherit',env:{...process.env,DATA_MODE:'SAMPLE',SIMULATE_FAILURE:'0',FUYAO_API_KEY:'',DEEPSEEK_API_KEY:''}});
process.exit(r.status??1);
