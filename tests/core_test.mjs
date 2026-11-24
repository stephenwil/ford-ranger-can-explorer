// Headless tests of the simulation core. Extracts the code between "CORE-BEGIN" and "CORE-END" from index.html
// (or the file given as argv[2]) and runs it in a Node VM. Usage: node tests/core_test.mjs [index.html]
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(process.argv[2] ?? path.join(here, '..', 'index.html'), 'utf8');
const a = src.indexOf('// ===== CORE-BEGIN'), b = src.indexOf('// ===== CORE-END');
if (a < 0 || b < 0) throw new Error('core markers not found');
const code = src.slice(a, b);
const ctx = vm.createContext({ console, Math, Map, Object, Array, String, Number, JSON, Infinity, parseInt });
vm.runInContext(code + `\n;globalThis.__C = { SIM, BUS, NODE, V, LOG, MSGS, CORE, TOOL, frameBits, crc15, coreInit, runUntil, txq, encode, decode, rxv, busLoad, toolRequest, decodeDiag, setIgn, fob, triggerCrash, repairAll, babbleLoop, crankEngine, dtcBytes, dtcFromBytes, linPid, linChecksum, listeners, HEX, hexs };`, ctx);
const C = ctx.__C;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };
const section = (s) => console.log('\n' + s);

// ── independent CRC-15 by polynomial long division (MSB first), to cross-check the shift-register implementation
function crcDiv(bits) {
  const poly = [1, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]; // x^15+x^14+x^10+x^8+x^7+x^4+x^3+1
  const r = [...bits, ...new Array(15).fill(0)];
  for (let i = 0; i < bits.length; i++) if (r[i]) for (let j = 0; j < 16; j++) r[i + j] ^= poly[j];
  return parseInt(r.slice(bits.length).join(''), 2);
}
function unstuffedHeader(id, data) {
  const b = [0]; for (let i = 10; i >= 0; i--) b.push((id >> i) & 1); b.push(0, 0, 0);
  for (let i = 3; i >= 0; i--) b.push((data.length >> i) & 1);
  for (const x of data) for (let i = 7; i >= 0; i--) b.push((x >> i) & 1);
  return b;
}
function maxRun(bits) { let m = 0, r = 0, l = -1; for (const x of bits) { r = x === l ? r + 1 : 1; l = x; m = Math.max(m, r); } return m; }

section('Frame format, CRC-15 and bit stuffing');
{
  let crcOk = true, stuffOk = true, destuffOk = true;
  const R = (n) => Math.floor(Math.random() * n);
  for (let k = 0; k < 400; k++) {
    const id = R(0x800); const data = Array.from({ length: R(9) }, () => R(256));
    if (k === 0) { data.length = 8; data.fill(0); }
    if (k === 1) { data.length = 8; data.fill(255); }
    const fb = C.frameBits(id, data);
    const hdr = unstuffedHeader(id, data);
    if (crcDiv(hdr) !== fb.crc) crcOk = false;
    const stuffedPart = fb.bits.filter((x) => ['SOF', 'ID', 'RTR', 'IDE', 'r0', 'DLC', 'DATA', 'CRC'].includes(x.f));
    if (maxRun(stuffedPart.map((x) => x.v)) > 5) stuffOk = false;
    // de-stuff and compare
    const d = []; let run = 0, last = -1, skip = false;
    for (const x of stuffedPart) { if (skip) { skip = false; if (x.v === last) destuffOk = false; last = x.v; run = 1; continue; } d.push(x.v); run = x.v === last ? run + 1 : 1; last = x.v; if (run === 5) skip = true; }
    const want = [...hdr]; for (let i = 14; i >= 0; i--) want.push((fb.crc >> i) & 1);
    if (d.join('') !== want.join('')) destuffOk = false;
    if (fb.nBits !== stuffedPart.length + 10) stuffOk = false;
  }
  ok(crcOk, 'CRC-15 matches an independent polynomial-division implementation (400 random frames)');
  ok(stuffOk, 'no run of more than 5 equal bits between SOF and the CRC; frame length = stuffed bits + 10');
  ok(destuffOk, 'de-stuffing recovers exactly SOF..DATA + CRC (stuff bits are always the complement)');
  const z = C.frameBits(0x000, [0, 0, 0, 0, 0, 0, 0, 0]);
  ok(z.nStuff >= 15, `all-zero 8-byte frame at ID 0x000 needs many stuff bits (${z.nStuff})`);
  const f8 = C.frameBits(0x0A0, [1, 2, 3, 4, 5, 6, 7, 8]);
  ok(f8.nBits >= 108 && f8.nBits <= 132, `8-byte base frame is 108 bits plus stuffing (got ${f8.nBits}, ${f8.nStuff} stuff)`);
  ok(C.linPid(0x3c) === 0x3c && C.linPid(0x3d) === 0x7d, 'LIN protected identifiers: 0x3C → 0x3C, 0x3D → 0x7D (ISO 17987 parity)');
  ok(C.dtcFromBytes(...C.dtcBytes('U0121')) === 'U0121' && C.hexs(C.dtcBytes('U0100')) === 'C1 00', 'DTC encoding: U0100 = 0xC100 (SAE J2012 two-byte form)');
}

section('Normal operation (2 s of bus time)');
C.coreInit(1);
C.runUntil(2.0);
{
  const n = C.LOG.filter((e) => e.kind === 'data').length;
  ok(n > 1500, `frames transmitted: ${n}`);
  ok(C.LOG.filter((e) => e.kind === 'err').length === 0, 'no error frames on a healthy network');
  for (const b of Object.values(C.BUS)) { const L = C.busLoad(b, 1); ok(L > 0.05 && L < 0.6, `${b.name} load ${(L * 100).toFixed(1)} %`); }
  const ipc = C.rxv('IPC', 0x0A0); ok(ipc.fresh, 'IPC receives ABS_Status on HS-CAN3 through the gateway');
  ok(C.rxv('BCM', 0x110).fresh, 'BCM receives TCM_Gear on MS-CAN through the gateway');
  ok(C.rxv('PCM', 0x0C8).fresh, 'PCM receives the radar ACC frame from HS-CAN2 through the gateway');
  const allDtc = Object.values(C.NODE).flatMap((x) => [...x.dtc.keys()]);
  ok(allDtc.length === 0, 'no DTCs on a healthy network' + (allDtc.length ? ' (' + allDtc.join(',') + ')' : ''));
  const e = C.LOG.find((x) => x.kind === 'data' && x.id === 0x0A0);
  ok(Math.abs(e.us - e.nb * 2) < 1e-6, 'on-wire time = bits × 2 µs at 500 kbit/s');
  const m = C.LOG.find((x) => x.kind === 'data' && x.bus === 'MS');
  ok(Math.abs(m.us - m.nb * 8) < 1e-6, 'on-wire time = bits × 8 µs at 125 kbit/s');
  const fr = C.LOG.filter((x) => x.kind === 'data' && x.bus === 'HS1' && x.id === 0x0A0 && !x.routed);
  const dts = fr.slice(1).map((x, i) => x.t - fr[i].t); const mean = dts.reduce((p, q) => p + q, 0) / dts.length;
  ok(Math.abs(mean - 0.02) < 0.0005, `ABS_Status period ≈ 20 ms (mean ${(mean * 1000).toFixed(3)} ms)`);
  ok(C.LOG.some((x) => x.kind === 'lin'), 'LIN frames are scheduled by their masters');
}

section('Arbitration');
{
  C.coreInit(2); C.runUntil(0.3);
  const bus = C.BUS.HS1; const tEnd = bus.cur ? bus.cur.t1 : C.SIM.t; C.runUntil(tEnd + 1e-7);
  // queue three frames while the bus is mid-frame so they meet at the next idle
  const hold = C.frameBits(0x7ff, [0, 0, 0, 0, 0, 0, 0, 0]);
  C.txq(C.NODE.GWM.ctrls.HS1, { id: 0x7f0, data: [0, 0, 0, 0, 0, 0, 0, 0] });
  C.runUntil(C.SIM.t + 2e-6);
  C.txq(C.NODE.PCM.ctrls.HS1, { id: 0x0F1, data: [1] }); C.txq(C.NODE.PSCM.ctrls.HS1, { id: 0x0B1, data: [2] }); C.txq(C.NODE.ABS.ctrls.HS1, { id: 0x0A1, data: [3] });
  C.runUntil(C.SIM.t + 0.003);
  const arbs = C.BUS.HS1.arbs.filter((x) => x.list.some((y) => y.id === 0x0A1));
  ok(arbs.length && arbs[0].winner === 'ABS', `lowest ID (0x0A1 from ABS) wins the bitwise arbitration (${arbs.length ? arbs[0].list.map((x) => x.node + ':' + C.HEX(x.id, 3)).join(' vs ') : 'none'})`);
  const order = C.LOG.filter((x) => x.kind === 'data' && [0x0A1, 0x0B1, 0x0F1].includes(x.id)).map((x) => x.id);
  ok(order.join() === [0x0A1, 0x0B1, 0x0F1].join(), 'losers retransmit automatically, in ID order');
}

section('Fault: CAN-H shorted to ground on HS-CAN1');
{
  C.coreInit(3); C.runUntil(1.5); C.BUS.HS1.f.hgnd = true; C.runUntil(2.2);
  const hs = C.BUS.HS1.ctrls.filter((c) => !c.node.tool);
  ok(hs.every((c) => c.busOffs > 0), 'every HS-CAN1 transmitter went bus-off at least once: ' + hs.map((c) => c.node.k + ':' + c.busOffs).join(' '));
  ok(C.LOG.filter((e) => e.kind === 'err' && e.bus === 'HS1').length >= 32, 'repeated bit errors on SOF');
  C.runUntil(3.5);
  ok(C.NODE.IPC.dtc.has('U0121') && C.NODE.IPC.dtc.has('U0100'), 'IPC (HS-CAN3) logs U0100 and U0121: PCM and ABS frames stop arriving');
  ok(C.BUS.MS.ctrls.every((c) => c.state !== 'busoff'), 'MS-CAN unaffected');
  C.BUS.HS1.f.hgnd = false; C.runUntil(6);
  ok(C.rxv('IPC', 0x0A0).fresh, 'after the short is removed the nodes recover from bus-off and traffic resumes');
}

section('Fault: terminators');
{
  C.coreInit(4); C.BUS.HS1.f.termA = false; C.runUntil(3);
  const e1 = C.LOG.filter((e) => e.kind === 'err' && e.bus === 'HS1').length, d1 = C.LOG.filter((e) => e.kind === 'data' && e.bus === 'HS1').length;
  ok(e1 > 0 && e1 / d1 < 0.1, `one terminator missing: occasional errors (${e1} errors / ${d1} frames), bus keeps working`);
  C.coreInit(4); C.BUS.HS1.f.termA = false; C.BUS.HS1.f.termB = false; C.runUntil(2);
  ok(C.BUS.HS1.ctrls.some((c) => c.busOffs > 0), 'both terminators missing: error storm drives nodes bus-off');
}

section('Babbling node');
{
  C.coreInit(5); C.runUntil(1); C.NODE.TRM.babble = 'bad'; C.babbleLoop(C.NODE.TRM); C.runUntil(3);
  const trm = C.NODE.TRM.ctrls.MS;
  ok(trm.busOffs >= 1, `corrupt babbler TRM driven bus-off ${trm.busOffs} time(s) by its own TEC`);
  ok(C.BUS.MS.ctrls.filter((c) => c.node.k !== 'TRM').every((c) => c.busOffs === 0), 'no other MS-CAN node went bus-off');
  C.coreInit(5); C.runUntil(1); C.NODE.TRM.babble = 'good'; C.babbleLoop(C.NODE.TRM); C.runUntil(2.5);
  ok(C.busLoad(C.BUS.MS, 0.5) > 0.97, 'valid-frame babbler at ID 0x010 takes ~100 % of MS-CAN');
  ok(!C.rxv('IPC', 0x3B0).fresh, 'BCM frames (higher IDs) starve: IPC loses door status');
  ok(C.NODE.TRM.ctrls.MS.busOffs === 0, 'fault confinement does not stop a babbler that sends valid frames');
}

section('Gateway failure, U-codes and diagnostics');
{
  C.coreInit(6); C.runUntil(1); C.NODE.GWM.alive = false; C.runUntil(3);
  ok(C.NODE.IPC.dtc.has('U0100') && C.NODE.IPC.dtc.has('U0121') && C.NODE.IPC.dtc.has('U0140'), 'IPC logs U0100, U0121, U0140 (PCM, ABS, BCM frames no longer forwarded)');
  ok(!C.NODE.PCM.dtc.has('U0121'), 'PCM (same bus as ABS) does not log U0121');
  let got = 'pending'; C.toolRequest('IPC', [0x19, 0x02, 0xff], (r) => (got = r)); C.runUntil(3.4);
  ok(got === null, 'scan tool cannot reach the IPC (HS-CAN3) with the gateway down');
  got = 'pending'; C.toolRequest('PCM', [0x22, 0xf1, 0x90], (r) => (got = r)); C.runUntil(3.7);
  ok(Array.isArray(got) && String.fromCharCode(...got.slice(3)) === 'SIMRANGERPX300001', 'PCM (HS-CAN1) still answers 22 F190 with the VIN (multi-frame)');
  C.NODE.GWM.alive = true; C.runUntil(4.5);
  got = 'pending'; C.toolRequest('IPC', [0x19, 0x02, 0xff], (r) => (got = r)); C.runUntil(4.8);
  ok(Array.isArray(got) && got[0] === 0x59 && C.decodeDiag([0x19], got, 0x728).includes('U0121'), 'after repair, UDS 19 02 through the gateway returns the IPC\'s stored U0121');
  got = 'pending'; C.TOOL.bs = 1; C.TOOL.st = 5; C.toolRequest('OBD', [0x09, 0x02], (r) => (got = r)); C.runUntil(5.2);
  const fcs = C.LOG.filter((e) => e.kind === 'data' && e.id === 0x7e0 && e.data[0] === 0x30 && e.t > 4.8).length;
  ok(Array.isArray(got) && got[0] === 0x49 && fcs === 2, `mode 09 02 VIN over 7DF/7E8 with BS=1 needs ${fcs} flow-control frames (FF + 2 CF)`);
  got = 'pending'; C.toolRequest('OBD', [0x01, 0x0c], (r) => (got = r)); C.runUntil(5.4);
  ok(Array.isArray(got) && got[0] === 0x41 && got[1] === 0x0c, 'mode 01 PID 0C answered by the PCM: ' + C.decodeDiag([1, 0x0c], got, 0x7e8));
}

section('Module silent / wheel-speed sensor');
{
  C.coreInit(7); C.runUntil(1); C.NODE.ABS.alive = false; C.runUntil(2.5);
  ok(['PCM', 'IPC', 'PSCM', 'TC4', 'BCM'].every((k) => C.NODE[k].dtc.has('U0121')), 'ABS silent: PCM, IPC, PSCM, 4×4 and BCM all log U0121');
  C.coreInit(8); C.V.sel = 'D'; C.V.autoSpd = 50; C.runUntil(8); C.V.wss[0] = false; C.runUntil(9);
  const s = C.rxv('IPC', 0x0A0).v;
  ok(C.NODE.ABS.dtc.has('C0035') && s.AbsFault && s.EscFault && s.WhlValid === 7, 'LF sensor open: C0035, ABS & ESC fault flags, FL marked invalid (WhlValid = 0111)');
  ok(s.VehSpeed > 30, `vehicle speed still reported from the other wheels (${s.VehSpeed.toFixed(1)} km/h)`);
}

section('Crash event and remote start');
{
  C.coreInit(9); C.runUntil(1); C.triggerCrash(); C.runUntil(6);
  ok(C.V.fuelCut && !C.V.eng, 'PCM cuts fuel on the crash frame');
  ok(C.NODE.BCM.st.crash && !C.V.locked, 'BCM (MS-CAN) unlocks on the gatewayed crash frame');
  ok(C.V.emerg !== 'idle', 'SYNC APIM (HS-CAN3) starts Emergency Assistance');
  C.coreInit(10); C.runUntil(0.5); C.setIgn('OFF'); C.runUntil(4);
  const quiet = C.LOG.filter((e) => e.kind === 'data' && e.t > 3).length;
  ok(quiet === 0, 'networks asleep with ignition off (no frames after 1.5 s)');
  C.fob('lock'); C.runUntil(4.3); C.fob('start'); C.runUntil(7);
  ok(C.V.eng && C.V.remote, 'remote start: wake, BCM checks gear P via the gateway, PATS handshake, engine runs');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
