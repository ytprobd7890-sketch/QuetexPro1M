import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    // Prevent path traversal outside the project root
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let target = filePath;
    const info = await stat(target).catch(() => null);
    if (info && info.isDirectory()) target = path.join(target, 'index.html');

    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  } catch {
    // SPA-style fallback so deep links still render the terminal
    try {
      const body = await readFile(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Quetex Pro 1M running → http://${HOST}:${PORT}`);
});
