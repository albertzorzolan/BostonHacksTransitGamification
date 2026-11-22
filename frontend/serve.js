// Tiny static server for running the frontend on its own (no build step).
//   PORT=5173 API_BASE=http://localhost:3000 node serve.js
// API_BASE overrides config.js so the page talks to a backend on another port.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

http
  .createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/config.js') {
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache' });
      return res.end(`window.EGG_API_BASE = ${JSON.stringify(API_BASE)};\n`);
    }
    const file = path.resolve(ROOT, pathname === '/' ? 'index.html' : pathname.slice(1));
    const ext = path.extname(file);
    if (!file.startsWith(ROOT + path.sep) || !MIME[ext] || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`Frontend on http://localhost:${PORT} (API: ${API_BASE})`));
