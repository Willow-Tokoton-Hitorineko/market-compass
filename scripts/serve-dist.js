/**
 * serve-dist.js — 本地预览「静态版」产物（零依赖）
 *
 * 仅用于以 HTTP 方式预览 dist/（更接近真实静态托管的加载行为）。
 * 若只是随便看看，直接双击 dist/index.html 即可，无需本脚本。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 8788;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

if (!fs.existsSync(DIR)) {
  console.error('未找到 dist/，请先执行：npm run build');
  process.exit(1);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    rel = rel.replace(/\.\.+/g, '');
    const file = path.join(DIR, rel);
    if (!file.startsWith(DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  })
  .listen(PORT, () => {
    console.log('静态版预览： http://localhost:' + PORT);
    console.log('（提示：直接双击 dist/index.html 亦可，无需启动本服务）');
  });
