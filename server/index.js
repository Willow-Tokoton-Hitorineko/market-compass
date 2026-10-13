/**
 * index.js — HTTP 服务入口
 *
 * 零依赖：仅使用 Node 内置 http / fs，避免安装依赖带来的不确定性。
 * 路由：
 *   GET  /                         → 前端 SPA
 *   GET  /api/meta                 → 模式与合规元信息
 *   GET  /api/health               → 健康检查
 *   GET  /api/assessment           → 完整七维研判（主链路）
 *   GET  /api/research/industry    → 继续研究：行业轮动
 *   GET  /api/research/stage       → 继续研究：历史阶段对比
 *
 * 异常处理原则：任何异常都返回结构化错误，绝不返回伪造数据。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config, { ROOT } from './config.js';
import DataLayer from './dataLayer.js';
import { runAssessment, researchIndustry, researchStage } from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

// 单例数据层（进程级缓存）
const dl = new DataLayer();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.replace(/\.\.+/g, ''); // 防目录穿越
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const q = Object.fromEntries(url.searchParams.entries());

  if (route === '/api/health') {
    return sendJson(res, 200, { ok: true, mode: dl.describe().mode, ts: Date.now() });
  }
  if (route === '/api/meta') {
    return sendJson(res, 200, {
      mode: dl.describe(),
      compliance: config.compliance,
      dimensions: [
        { key: 'priceStructure', name: '行情结构' },
        { key: 'breadth', name: '市场宽度' },
        { key: 'styleRotation', name: '风格轮动' },
        { key: 'valuation', name: '估值' },
        { key: 'liquidity', name: '流动性' },
        { key: 'sentiment', name: '情绪' },
        { key: 'events', name: '重要事件' },
      ],
    });
  }
  if (route === '/api/assessment') {
    const result = await runAssessment(dl);
    return sendJson(res, 200, result);
  }
  if (route === '/api/research/industry') {
    const result = await researchIndustry(dl);
    return sendJson(res, 200, result);
  }
  if (route === '/api/research/stage') {
    const days = Math.max(5, Math.min(250, Number(q.days) || 60));
    const result = await researchStage(dl, { lookbackDays: days });
    return sendJson(res, 200, result);
  }
  return sendJson(res, 404, { error: 'not_found', message: `未知接口：${route}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('x-content-type-options', 'nosniff');

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      // 顶层兜底：明确告知失败，绝不用推测数据补全
      sendJson(res, 500, {
        error: 'internal_error',
        message: '服务端处理失败，请稍后重试。',
        detail: String(err?.message || err),
      });
    }
    return;
  }
  serveStatic(req, res, url.pathname);
});

const meta = dl.describe();

if (process.argv.includes('--print-mode')) {
  console.log(JSON.stringify(meta, null, 2));
  process.exit(0);
}

server.listen(config.port, () => {
  const mode = meta.mode;
  console.log('');
  console.log('  大势罗盘 · Market Compass');
  console.log('  ----------------------------------------');
  console.log(`  服务地址 : http://localhost:${config.port}`);
  console.log(`  数据模式 : ${mode}${meta.degraded ? '（已降级）' : ''}`);
  if (meta.degraded) console.log(`  降级原因 : ${meta.reason}`);
  if (mode === 'SAMPLE') console.log('  提示     : 当前为构造样本数据，页面会持续标注"非实时"。');
  if (mode === 'LIVE') console.log(`  数据源   : ${meta.baseUrl}`);
  if (config.simulateFailure) console.log('  故障演练 : SIMULATE_FAILURE=1 已开启');
  console.log('  ----------------------------------------');
  console.log('');
});

export { server, dl };
