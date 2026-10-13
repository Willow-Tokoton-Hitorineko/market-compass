/**
 * build-static.js — 生成「零服务器」静态版
 *
 * 用途：把产品构建为一份可脱离后端独立运行的静态站点（dist/）：
 *   - 复用与线上完全相同的研判引擎（server/），在构建时以 SAMPLE 模式预生成
 *     /api/meta、/api/assessment、/api/research/* 的响应，写入 dist/static-data.js；
 *   - index.html / styles.css / app.js 原样拷贝，index.html 注入 static-data.js；
 *   - 产物既可用浏览器直接打开（file://），也可拖到任意静态托管（Netlify / GitHub Pages / Vercel）。
 *
 * 说明：静态版固定使用内置「构造样本」（页面持续标注非实时）。
 *       真实扶摇实时数据（LIVE）需 API Key，只能由 Node 服务端调用，故不进入静态产物——
 *       这是刻意的安全边界：密钥绝不下发到浏览器。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config, { ROOT } from '../server/config.js';
import DataLayer from '../server/dataLayer.js';
import { runAssessment, researchIndustry, researchStage } from '../server/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_DIR = path.join(ROOT, 'dist');

const DIMENSIONS = [
  { key: 'priceStructure', name: '行情结构' },
  { key: 'breadth', name: '市场宽度' },
  { key: 'styleRotation', name: '风格轮动' },
  { key: 'valuation', name: '估值' },
  { key: 'liquidity', name: '流动性' },
  { key: 'sentiment', name: '情绪' },
  { key: 'events', name: '重要事件' },
];

function copy(src, dest) {
  fs.copyFileSync(src, dest);
}

async function main() {
  // 强制以构造样本构建，确保可离线复现
  process.env.DATA_MODE = 'SAMPLE';
  process.env.SIMULATE_FAILURE = '0';

  const dl = new DataLayer();

  console.log('· 正在生成静态快照（SAMPLE 模式）…');
  const snapshot = {
    '/api/meta': {
      mode: dl.describe(),
      compliance: config.compliance,
      dimensions: DIMENSIONS,
    },
    '/api/assessment': await runAssessment(dl),
    '/api/research/industry': await researchIndustry(dl),
    '/api/research/stage?days=60': await researchStage(dl, { lookbackDays: 60 }),
  };

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1) 内置数据快照
  const banner =
    '/* 本文件由 scripts/build-static.js 自动生成，请勿手动修改。\n' +
    '   内容为 SAMPLE（构造样本）模式下的接口响应快照，不含任何真实市场数值或密钥。 */\n';
  fs.writeFileSync(
    path.join(OUT_DIR, 'static-data.js'),
    banner + 'window.__STATIC__ = ' + JSON.stringify(snapshot, null, 0) + ';\n',
    'utf8',
  );

  // 2) 静态资源
  copy(path.join(PUBLIC_DIR, 'styles.css'), path.join(OUT_DIR, 'styles.css'));
  copy(path.join(PUBLIC_DIR, 'app.js'), path.join(OUT_DIR, 'app.js'));

  // 3) index.html：在 app.js 之前注入 static-data.js
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  if (!html.includes('static-data.js')) {
    html = html.replace(
      /(\s*)<script src="app\.js"><\/script>/,
      '$1<script src="static-data.js"></script>$1<script src="app.js"></script>',
    );
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html, 'utf8');

  // 4) .nojekyll：避免 GitHub Pages 的 Jekyll 处理（产物为纯静态）
  fs.writeFileSync(path.join(OUT_DIR, '.nojekyll'), '', 'utf8');

  const size = (f) => (fs.statSync(path.join(OUT_DIR, f)).size / 1024).toFixed(1) + ' KB';
  console.log('');
  console.log('  静态版构建完成 → ' + path.relative(ROOT, OUT_DIR) + '/');
  console.log('  ----------------------------------------');
  console.log('  index.html     ' + size('index.html'));
  console.log('  styles.css     ' + size('styles.css'));
  console.log('  app.js         ' + size('app.js'));
  console.log('  static-data.js ' + size('static-data.js'));
  console.log('  ----------------------------------------');
  console.log('  本地预览：直接双击 dist/index.html，或 npx serve dist');
  console.log('  在线托管：把 dist/ 整个目录拖到 Netlify Drop，或推送后由 GitHub Pages 托管');
  console.log('');
}

main().catch((err) => {
  console.error('构建失败：', err);
  process.exit(1);
});
