/**
 * DOM smoke test — boots the real index.html + app.js inside jsdom with a
 * stubbed canvas/ResizeObserver, then asserts the UI actually populated.
 * Run: node tests/ui.mjs
 */

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const errors = [];
const dom = new JSDOM(readFileSync(path.join(root, 'index.html'), 'utf8'), {
  url: 'http://localhost:8080/',
  pretendToBeVisual: true
});

const { window } = dom;
const { document } = window;

// ---- shims -------------------------------------------------------------
const gradient = { addColorStop() {} };
const ctx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'measureText') return () => ({ width: 42 });
    if (prop === 'createLinearGradient') return () => gradient;
    if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
    if (prop === 'canvas') return { width: 900, height: 500 };
    if (prop === 'font' || prop === 'fillStyle' || prop === 'strokeStyle' ||
        prop === 'lineWidth' || prop === 'textAlign' || prop === 'textBaseline' ||
        prop === 'globalAlpha' || prop === 'lineJoin') return '';
    return () => {};
  },
  set() { return true; }
});

window.HTMLCanvasElement.prototype.getContext = () => ctx;
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { width: 900, height: 500, top: 0, left: 0, right: 900, bottom: 500, x: 0, y: 0 };
};
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));

globalThis.window = window;
globalThis.document = document;
globalThis.ResizeObserver = window.ResizeObserver;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
globalThis.fetch = () => Promise.reject(new Error('offline in test'));

window.addEventListener('error', (e) => errors.push(String(e.message)));
process.on('unhandledRejection', (e) => errors.push(String(e)));

// ---- boot --------------------------------------------------------------
await import(path.join(root, 'js/app.js'));
document.dispatchEvent(new window.Event('DOMContentLoaded'));
await new Promise((r) => setTimeout(r, 400));

let fails = 0;
const ok = (cond, label) => {
  if (!cond) { fails++; console.log(`  ✗ ${label}`); } else console.log(`  ✓ ${label}`);
};

console.log('\n=== UI boot ===');
ok(errors.length === 0, `no runtime errors (${errors.length})${errors.length ? ' → ' + errors.join(' | ') : ''}`);
ok(document.getElementById('pair-title').textContent.includes('BTC'), 'pair title rendered');
ok(/[0-9]/.test(document.getElementById('last-price').textContent), 'last price rendered');
ok(['LONG BIAS', 'SHORT BIAS', 'NO TRADE'].includes(document.getElementById('bias').textContent), `bias = ${document.getElementById('bias').textContent}`);
ok(document.querySelectorAll('#checklist li').length === 8, 'checklist has 8 items');
ok(document.querySelectorAll('#components .comp').length === 5, 'confluence breakdown has 5 components');
ok(document.querySelectorAll('#kpi-grid .kpi').length === 12, '12 KPI cards');
ok(document.querySelectorAll('#trades-table tbody tr').length >= 1, 'trade log populated');
ok(document.querySelectorAll('#pb-strategies .pb-card').length === 6, 'playbook renders 6 strategies');
ok(document.getElementById('regime-chips').children.length === 4, '4 regime chips');
ok(document.getElementById('status-text').textContent.length > 4, `status: ${document.getElementById('status-text').textContent}`);

console.log('\n=== 1M Edge tab ===');
ok(document.getElementById('tab-edge').classList.contains('active'), 'edge tab is the default view');
ok(['UP ▲', 'DOWN ▼'].includes(document.getElementById('pred-side').textContent), `prediction side: ${document.getElementById('pred-side').textContent}`);
ok(/\d/.test(document.getElementById('pred-prob').textContent), `probability: ${document.getElementById('pred-prob').textContent}`);
ok(document.querySelectorAll('#features .feat').length > 0, 'feature contributions rendered');
ok(document.getElementById('edge-ev').textContent.includes('Breakeven'), 'expectancy box rendered');
ok(document.getElementById('session-stats').textContent.includes('Hit rate'), 'session record rendered');
ok(document.getElementById('edge-source').textContent.length > 0, `source badge: ${document.getElementById('edge-source').textContent}`);

// stake change re-renders expectancy
const stake = document.getElementById('stake-input');
stake.value = '50';
stake.dispatchEvent(new window.Event('input'));
await new Promise((r) => setTimeout(r, 60));
ok(document.getElementById('edge-ev').textContent.includes('50'), 'stake flows into expectancy');

// log a call
document.getElementById('log-call').dispatchEvent(new window.Event('click'));
await new Promise((r) => setTimeout(r, 60));
ok(document.getElementById('session-stats').textContent.includes('Logged calls 1'), 'call logged to session');

console.log('\n=== Interactions ===');
// switch timeframe
const tf = document.getElementById('tf-select');
tf.value = '1h';
tf.dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 300));
ok(document.getElementById('pair-meta').textContent.includes('1h'), 'timeframe switch reloads data');

// switch strategy
const strat = document.getElementById('strategy-select');
strat.value = 'donchian-break';
strat.dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 300));
ok(document.getElementById('params').children.length >= 2, 'strategy params rendered');
ok(document.querySelectorAll('#kpi-grid .kpi').length === 12, 'KPIs refresh on strategy change');

// adjust risk input
const risk = document.getElementById('risk-input');
risk.value = '0.5';
risk.dispatchEvent(new window.Event('input'));
await new Promise((r) => setTimeout(r, 60));
ok(document.getElementById('size-risk').textContent.includes('0.5%'), 'position sizing reacts to risk input');

// tab switch
document.querySelector('.tab[data-tab="playbook"]').dispatchEvent(new window.Event('click'));
await new Promise((r) => setTimeout(r, 60));
ok(document.getElementById('tab-playbook').classList.contains('active'), 'tab switching works');

// overlay toggle
document.querySelector('[data-ov="bb"]').dispatchEvent(new window.Event('click'));
await new Promise((r) => setTimeout(r, 60));
ok(document.querySelector('[data-ov="bb"]').classList.contains('on'), 'overlay toggle works');

console.log(`\n${fails === 0 ? '✅ UI SMOKE PASSED' : `❌ ${fails} UI CHECK(S) FAILED`}\n`);
process.exit(fails === 0 ? 0 : 1);
