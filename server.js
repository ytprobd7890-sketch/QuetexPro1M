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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    // Fallback for the Web Share Target when the service worker is not active yet
    // (first visit). The app then tells the user to upload instead.
    if (req.method === 'POST' && rel === '/share-target') {
      res.writeHead(303, { Location: '/?shared=1', 'Cache-Control': 'no-store' }).end();
      return;
    }

    // Path containment: resolve, then require the result to stay inside ROOT.
    // A plain startsWith() would also accept siblings like "<ROOT>-secret".
    const filePath = path.normalize(path.join(ROOT, rel));
    const relToRoot = path.relative(ROOT, filePath);
    const escapes = relToRoot.startsWith('..') || path.isAbsolute(relToRoot);
    const hidden = relToRoot.split(path.sep).some((seg) => seg.startsWith('.') || seg === 'node_modules');
    if (escapes || hidden) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
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
