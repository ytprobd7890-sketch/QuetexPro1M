/**
 * PWA / share-target checks: manifest validity, icon files, service-worker
 * syntax and wiring. These are what make the mobile "Share → Quetex" flow work.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(root, p), 'utf8');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.log('  ✗ ' + l); } else console.log('  ✓ ' + l); };

console.log('\n=== 1. Manifest ===');
let manifest;
try {
  manifest = JSON.parse(read('manifest.webmanifest'));
  ok(true, 'manifest.webmanifest is valid JSON');
} catch (e) {
  ok(false, 'manifest parse: ' + e.message);
  process.exit(1);
}
ok(Boolean(manifest.name && manifest.short_name), `name "${manifest.short_name}"`);
ok(manifest.display === 'standalone', 'display = standalone (installs as an app)');
ok(/(^|\.\/)index|^(\.\/)?\?source=pwa$/.test(manifest.start_url) || manifest.start_url.endsWith('?source=pwa'), `start_url ${manifest.start_url}`);
ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, `${manifest.icons.length} icons declared`);
ok(manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'), '192 + 512 icon sizes');
ok(manifest.icons.some((i) => (i.purpose || '').includes('maskable')), 'maskable icon present');

console.log('\n=== 2. Share target ===');
const st = manifest.share_target;
ok(Boolean(st), 'share_target declared');
ok(/^\.?\/?share-target$/.test(st.action), `action ${st?.action} (relative → works under a sub-path)`);
ok(st.method === 'POST', 'method POST (required for files)');
ok(st.enctype === 'multipart/form-data', 'enctype multipart/form-data');
ok(Array.isArray(st.params?.files) && st.params.files[0].name === 'chart', 'accepts a file field named "chart"');
ok(st.params.files[0].accept.some((a) => a.includes('image/')), 'image types accepted');

console.log('\n=== 3. Icons on disk ===');
for (const icon of manifest.icons) {
  const p = icon.src.replace(/^\//, '');
  const exists = existsSync(path.join(root, p));
  if (!exists) { ok(false, `${p} missing`); continue; }
  const buf = readFileSync(path.join(root, p));
  const isPng = buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
  const size = icon.sizes.split('x')[0];
  // read IHDR width/height
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  ok(isPng && w === Number(size) && h === Number(size), `${p} is a valid ${w}×${h} PNG`);
}

console.log('\n=== 4. Service worker ===');
const sw = read('service-worker.js');
ok(sw.includes('SHARE_PATH') && sw.includes("url.pathname === SHARE_PATH"), 'handles POST /share-target');
ok(sw.includes("new URL('./', self.registration.scope)"), 'paths resolve against the SW scope (sub-path safe)');
ok(sw.includes("caches.open(SHARE_CACHE)"), 'stores the shared file in the Cache API');
ok(sw.includes('Response.redirect'), 'redirects back into the app');
ok(sw.includes("addEventListener('fetch'"), 'fetch handler installed');
ok(SHELL_OK(sw), 'shell precache list present');
try {
  execFileSync(process.execPath, ['--check', path.join(root, 'service-worker.js')]);
  ok(true, 'service-worker.js parses');
} catch (e) {
  ok(false, 'service-worker.js syntax: ' + String(e.message).slice(0, 120));
}

console.log('\n=== 5. Wiring ===');
const html = read('index.html');
ok(html.includes('rel="manifest"'), 'index.html links the manifest');
ok(html.includes('apple-touch-icon'), 'iOS home-screen icon declared');
ok(html.includes('capture="environment"'), 'camera input uses the rear camera');
ok(html.includes('id="install-app"'), 'install button present');
const app = read('js/app.js');
ok(app.includes('serviceWorker.register'), 'app registers the service worker');
const edge = read('js/edge.js');
ok(edge.includes("caches.open('qp1m-share')"), 'app reads the shared screenshot');
ok(edge.includes("addEventListener('paste'"), 'clipboard paste supported');
const server = read('server.js');
ok(server.includes('.webmanifest'), 'server serves the manifest MIME type');

console.log(`\n${fails === 0 ? '✅ PWA PASSED' : `❌ ${fails} PWA CHECK(S) FAILED`}\n`);
process.exit(fails === 0 ? 0 : 1);

function SHELL_OK(src) {
  // Paths are relative now (resolved against the SW scope), so match the quoted entry.
  const needed = ['index.html', 'js/app.js', 'js/edge.js', 'css/styles.css'];
  return needed.every((n) => src.includes(`'${n}'`));
}
