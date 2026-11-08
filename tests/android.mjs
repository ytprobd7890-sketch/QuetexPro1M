/**
 * Static consistency checks for the Android capture shell.
 * (No Android SDK here — this verifies the project wiring, not a build.)
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const A = (p) => path.join(root, 'android', p);
const read = (p) => readFileSync(A(p), 'utf8');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.log('  ✗ ' + l); } else console.log('  ✓ ' + l); };

console.log('\n=== Android project ===');
const required = [
  'settings.gradle.kts',
  'app/build.gradle.kts',
  'app/src/main/AndroidManifest.xml',
  'app/src/main/java/com/quetex/pro1m/MainActivity.kt',
  'app/src/main/java/com/quetex/pro1m/CaptureService.kt',
  'app/src/main/res/values/strings.xml',
  'app/src/main/res/values/themes.xml'
];
for (const f of required) ok(existsSync(A(f)), `${f} exists`);

const manifest = read('app/src/main/AndroidManifest.xml');
ok(manifest.includes('.MainActivity'), 'manifest declares MainActivity');
ok(manifest.includes('.CaptureService'), 'manifest declares CaptureService');
ok(manifest.includes('foregroundServiceType="mediaProjection"'), 'service typed mediaProjection (Android 14 requirement)');
ok(manifest.includes('FOREGROUND_SERVICE_MEDIA_PROJECTION'), 'FOREGROUND_SERVICE_MEDIA_PROJECTION permission');
ok(manifest.includes('android.permission.INTERNET'), 'INTERNET permission');

const gradle = read('app/build.gradle.kts');
ok(/compileSdk\s*=\s*34/.test(gradle), 'compileSdk 34');
ok(/minSdk\s*=\s*26/.test(gradle), 'minSdk 26 (ImageView/PixelFormat safe floor)');
ok(gradle.includes('buildConfigField("String", "APP_URL"'), 'APP_URL build config present');

const activity = read('app/src/main/java/com/quetex/pro1m/MainActivity.kt');
ok(activity.includes('createScreenCaptureIntent'), 'requests screen-capture consent');
ok(activity.includes('webView.evaluateJavascript') || activity.includes('MediaProjectionManager'), 'wired to MediaProjectionManager');
ok(activity.includes('SharedPreferences') || activity.includes('getSharedPreferences'), 'remembers the app URL');

const service = read('app/src/main/java/com/quetex/pro1m/CaptureService.kt');
ok(service.includes('FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION'), 'startForeground uses the mediaProjection type');
ok(service.includes('registerCallback'), 'MediaProjection.Callback registered before createVirtualDisplay');
ok(service.indexOf('projection?.registerCallback(projectionCallback, handler)') > -1 &&
   service.indexOf('projection?.registerCallback(projectionCallback, handler)') <
   service.indexOf('virtualDisplay = projection?.createVirtualDisplay'),
   'callback registered BEFORE createVirtualDisplay');
ok(service.includes('ImageReader.newInstance'), 'ImageReader created');
ok(service.includes('VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR'), 'virtual display mirrors the screen');
ok(service.includes('window.QP.onFrame'), 'frames are injected into the web app bridge');
ok(service.includes('Bitmap.CompressFormat.JPEG'), 'frames JPEG-compressed');
ok(service.includes('Base64.NO_WRAP'), 'frames base64 encoded');
ok(/INTERVAL_MS\s*=\s*6_000/.test(service), 'capture interval 6 s');

console.log('\n=== Resources ===');
const strings = read('app/src/main/res/values/strings.xml');
const used = [...activity.matchAll(/(?<!android\.)R\.string\.(\w+)/g),
              ...service.matchAll(/(?<!android\.)R\.string\.(\w+)/g)].map((m) => m[1]);
const missing = [...new Set(used)].filter((n) => !strings.includes(`name="${n}"`));
ok(missing.length === 0, `all R.string references defined${missing.length ? ' — missing: ' + missing.join(', ') : ''}`);

for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
  ok(existsSync(A(`app/src/main/res/mipmap-${d}/ic_launcher.png`)), `mipmap-${d}/ic_launcher.png`);
}

console.log('\n=== Bridge contract ===');
const edge = readFileSync(path.join(root, 'js/edge.js'), 'utf8');
ok(edge.includes('window.QP'), 'web app exposes window.QP');
ok(edge.includes('onFrame'), 'window.QP.onFrame exists');
ok(edge.includes('onNativeFrame') && edge.includes('img.src = dataUrl'),
   'accepts the data-URL frame the service sends');

console.log(`\n${fails === 0 ? '✅ ANDROID PASSED' : `❌ ${fails} ANDROID CHECK(S) FAILED`}\n`);
process.exit(fails === 0 ? 0 : 1);
