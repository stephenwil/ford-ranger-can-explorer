# Ranger CAN Explorer

An interactive 3D explorer of the in-vehicle networks of a **Ford Ranger Wildtrak, PX2/PX3 generation (2016 facelift to 2022)**.
It shows how the modules (ECUs) exchange information over CAN, with protocol mechanics modelled on **ISO 11898**,
plus a note on how the **2022+ next-generation Ranger** differs.

It is a companion to the Typhoon avionics data-bus explorer and follows the same layout: a 3D model on the left and tabbed
panels on the right.

> **Fidelity.** Ford's CAN databases (DBC files) are proprietary. In this app, every **message ID, signal layout, scaling,
> transmit rate, gateway route, bus assignment and terminator location is ILLUSTRATIVE**: plausible, invented for
> teaching, and **not** usable on a real truck. The **protocol mechanics** are what is meant to be accurate: frame format,
> bit stuffing, CRC-15, arbitration, ACK, error frames, TEC/REC fault confinement, ISO-TP, OBD-II and UDS. Only public
> sources were used. See the *About* tab and `docs/TECHNICAL_MANUAL.md` §1.

## Run it

It is a static page: one HTML file plus a vendored copy of three.js. Serve the folder and open `index.html`:

```bash
python3 -m http.server 8431 --bind 0.0.0.0
# then open http://<host>:8431/
```

No build step, no network access needed at runtime.

## What's in it

| Area | What you get |
|---|---|
| **3D view** | Stylised double-cab Wildtrak (x-ray body, sports bar, tray) with 16 modules at plausible locations: PCM, TCM (in the 6R80/10R80 valve body), ABS/ESC, RCM, PSCM (EPAS), 4×4 module, GWM, IPMA camera, CCM radar, IPC, SYNC 3 APIM, ACM, BCM, HVAC, PAM, trailer module and the DLC. HS-CAN1/2/3 and MS-CAN are drawn as coloured trunks with 120 Ω terminators at both ends; LIN sub-buses are dashed; RF links (TPMS, key fob) are dotted. Lamps, wheels, steering, airbags and trailer react to the simulation. |
| **CAN engine** | Event-driven simulation in true bus time: 11-bit base frames with the real bit sequence, stuff bits and CRC-15; bitwise wired-AND arbitration with automatic retransmission; ACK; error frames; TEC/REC; error-active, passive and bus-off with recovery; mailbox overwrite; 500 / 125 kbit/s timing. |
| **Traffic** | About 25 periodic messages (engine RPM, wheel speeds, vehicle speed and ESC status, steering angle, gear, 4×4 mode, crash status, doors and locks, lights, TPMS, battery, climate, park-sensor distances, ACC and lane keeping, power mode), plus gateway forwarding, LIN schedules and event frames (PATS). |
| **Animation** | *Real time*: the buses run at full rate (about 1,800 frames/s in total) and a sample of frames is animated, slowed down; gatewayed copies chain on. *Slow-mo ÷200 … ÷20000*: every frame is animated in true order, one per bus at a time. Pause and *Step frame* are available. |
| **Cluster** | The instrument cluster draws **only what the IPC has received over HS-CAN3**, with per-message ages, STALE flags and lamp-on-loss behaviour. A freshness table lists every input. |
| **Driving** | Ignition, start (with PATS), PRND, pedals, steering, auto-drive, 4×4 selector, e-locker, lights, indicators, climate, ACC with a lead vehicle, rear obstacle, tyre pressure, doors, fob lock/unlock/remote start, trailer and seat belt. |
| **Log** | Every frame with its true timestamp (s), bus, ID, sender (or `GW←bus`), data, total bits (stuff bits in brackets) and µs on the wire. Filter by bus, ID, errors or gateway copies. |
| **Decoder** | Any frame, bit by bit, with the fields coloured and the stuff bits marked. Field table, CRC value, bit counts and timing, and signal decoding with checksum verification. |
| **Arbitration** | A bit-by-bit table of real contested arbitrations, plus a "start together" race you can play in slow motion. |
| **Wire & errors** | A CAN-H/CAN-L/differential scope of the latest frame (or error frame) on each bus, showing termination and short-circuit effects, a termination schematic with the ohmmeter reading at the DLC, and a live TEC/REC table. |
| **Diagnostics** | A scan tool on the DLC (HS-CAN1 on pins 6/14, MS-CAN on pins 3/11): OBD-II modes 01/03/09 on 0x7DF, and UDS 10/3E/22/19/14 to any module. Modules on HS-CAN2/3 are reached through the gateway. ISO-TP SF/FF/FC/CF with selectable BS and STmin, a full frame transcript, and a network scan. |
| **Faults** | Short CAN-H to ground or to CAN-L, remove terminator A or B, EMI burst, power off any module, a corrupt or valid-frame babbler, LF wheel-speed sensor open, crash, gateway failure, slow puncture, repair all. |
| **Scenarios** | 13 narrated walkthroughs: the networks tour, frame anatomy, arbitration, silent module (U-codes), wheel-speed sensor, CAN-H short, missing terminator, babbling node, gateway failure, crash, keyless entry and remote start, OBD/UDS over ISO-TP, 4×4 shifting. |

## Tests

```bash
node tests/core_test.mjs                 # 50 checks of the simulation core (runs the code embedded in index.html)
PLAYWRIGHT=/path/to/node_modules/playwright-core node tests/ui_smoke.mjs http://127.0.0.1:8431/index.html /tmp/shots
```

`core_test.mjs` cross-checks CRC-15 against an independent polynomial-division implementation. It also checks
stuffing and de-stuffing over random frames; frame timing at both bit rates; message periods; arbitration order; bus-off under
a CAN-H short and recovery afterwards; terminator faults; both kinds of babbler; U-codes after gateway and module loss;
ISO-TP multi-frame with flow control; UDS through the gateway; crash propagation; and sleep, wake and remote start.
`ui_smoke.mjs` loads the page headless, opens every tab, drives the diagnostics, faults and slow-mo, runs all 13 scenarios
step by step, and fails on any console or page error.

## Files

```
index.html               the whole app (HTML + CSS + JS; the simulation core sits between CORE-BEGIN/CORE-END markers)
vendor/                  three.js r170 module build + OrbitControls (MIT)
docs/TECHNICAL_MANUAL.md architecture, CAN concepts, the model, and its limits
tests/                   core_test.mjs (Node), ui_smoke.mjs (Playwright)
```
