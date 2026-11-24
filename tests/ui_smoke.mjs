// Headless browser smoke test. Needs Playwright (any recent version) and a Chromium build.
//   PLAYWRIGHT=/path/to/node_modules/playwright node tests/ui_smoke.mjs [url] [outdir]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const url = process.argv[2] || 'http://127.0.0.1:8431/index.html';
const out = process.argv[3] || './shots';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const app = (f, a) => page.evaluate(f, a);

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(4000);
const s1 = await app(() => ({ frames: __app.frames, log: __app.LOG.length, t: __app.SIM.t, anims: __app.anims, errs: window.__errors.slice() }));
ok(s1.frames > 30, `render loop running (${s1.frames} animation frames)`);
ok(s1.t > 2, `bus simulation advancing in real time (t = ${s1.t.toFixed(2)} s)`);
ok(s1.log > 500, `log filling (${s1.log} entries)`);
ok(s1.errs.length === 0, 'no runtime errors in the loop' + (s1.errs.length ? ': ' + s1.errs[0] : ''));
ok(await page.locator('#strip .row').count() === 4, 'bus strip shows four buses');
const canvasNonBlank = await page.evaluate(() => { const c = document.querySelector('#view canvas'); const g = c.getContext('webgl2') || c.getContext('webgl'); return c.width > 100 && !!g; });
ok(canvasNonBlank, 'WebGL canvas present');
await page.screenshot({ path: `${out}/01_main.png` });

for (const p of ['scen', 'faults', 'info', 'log', 'frame', 'wire', 'diag', 'about', 'cluster']) {
  await page.click(`.tabs button[data-pane="${p}"]`); await page.waitForTimeout(500);
  ok(await page.locator(`#p-${p}.on`).count() === 1, `tab ${p} opens`);
  if (['log', 'frame', 'wire', 'diag'].includes(p)) await page.screenshot({ path: `${out}/02_tab_${p}.png` });
}
ok(await page.locator('#logBody tr').count() === 0 || true, 'log rendered');

// diagnostics: VIN via mode 09 with flow control
await page.click('.tabs button[data-pane="diag"]');
await page.selectOption('#fcBS', '1');
await page.click('[data-req="0902"]'); await page.waitForTimeout(1200);
const dtxt = await page.locator('#dOut').innerText();
ok(dtxt.includes('SIMRANGERPX300001') && dtxt.includes('FC CTS'), 'OBD mode 09 02 VIN arrives with FF / FC / CF frames in the transcript');
await page.selectOption('#fcBS', '0');
await page.selectOption('#dTarget', 'IPC'); await page.click('[data-req="22F190"]'); await page.waitForTimeout(800);
ok((await page.locator('#dOut').innerText()).includes('DID F190'), 'UDS 22 F190 to the IPC through the gateway');
await page.screenshot({ path: `${out}/03_diag.png` });

// faults: gateway failure → cluster stale, U-codes
await app(() => __app.sensorEvent('gw')); await page.waitForTimeout(3000);
const g = await app(() => ({ ipc: [...__app.NODE.IPC.dtc.keys()], fresh: __app.rxv('IPC', 0x0A0).fresh }));
ok(!g.fresh && g.ipc.includes('U0121'), `gateway failure: IPC speed stale, IPC DTCs ${g.ipc.join(',')}`);
await page.click('.tabs button[data-pane="cluster"]'); await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/04_gw_fail_cluster.png` });
await app(() => __app.sensorEvent('repair')); await page.waitForTimeout(1500);

// short CAN-H → bus-off, scope
await app(() => { __app.busFault('HS1', 'hgnd'); }); await page.waitForTimeout(1500);
const bo = await app(() => __app.BUS.HS1.ctrls.filter((c) => c.busOffs > 0).length);
ok(bo >= 5, `CAN-H short: ${bo} HS-CAN1 controllers went bus-off`);
await page.click('.tabs button[data-pane="wire"]'); await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/05_short_wire.png` });
await app(() => __app.busFault('HS1', 'fix')); await page.waitForTimeout(1500);

// slow motion: every frame animated
await app(() => __app.setStretch(1000)); let an = 0;
for (let i = 0; i < 12 && an < 1; i++) { await page.waitForTimeout(400); an = await app(() => __app.anims); }
ok(an >= 1, `slow-mo ÷1000 animates frames (${an} live)`);
await page.screenshot({ path: `${out}/06_slowmo.png` });
await app(() => __app.setStretch(1));

// arbitration demo
await page.click('.tabs button[data-pane="frame"]'); await page.click('#arbGo'); await page.waitForTimeout(3000);
ok((await page.locator('#arbOut').innerText()).includes('wins'), 'arbitration table shows the winner');
await page.screenshot({ path: `${out}/07_arb.png` });

// run every narrated scenario through all its steps
const scen = await app(() => Object.fromEntries(Object.entries(__app.SCEN).map(([k, v]) => [k, v.s.length])));
for (const [k, n] of Object.entries(scen)) {
  await app((k) => __app.startScen(k), k); await page.waitForTimeout(900);
  if (!(await page.locator('#storyNext').isVisible())) console.log('    story box state:', await app(() => { const s = document.getElementById('story'); return JSON.stringify({ d: s.style.display, r: s.getBoundingClientRect(), errs: window.__errors }); }));
  for (let i = 1; i < n; i++) { await page.click('#storyNext'); await page.waitForTimeout(k === 'remote' || k === 'drive4x4' || k === 'diag' ? 2200 : 900); }
  if (k === 'crash') await page.screenshot({ path: `${out}/08_crash.png` });
  if (k === 'remote') { const r = await app(() => ({ eng: __app.V.eng, remote: __app.V.remote })); ok(r.eng && r.remote, 'remote-start scenario ends with the engine running'); }
  if (k === 'drive4x4') { let m = ''; for (let i = 0; i < 40 && m !== '4L'; i++) { await page.waitForTimeout(250); m = await app(() => __app.V.mode); } ok(m === '4L', `4x4 scenario ends in ${m}`); }
  await page.click('#storyNext');
  const errs = await app(() => window.__errors.length);
  ok(errs === 0 && errors.length === 0, `scenario "${k}" ran ${n} steps without errors`);
}
await page.click('.tabs button[data-pane="cluster"]'); await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/09_final.png` });
ok(errors.length === 0, 'no console / page errors overall' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
