# Ranger CAN Explorer: technical manual

This manual explains the network architecture the explorer models, the CAN concepts it shows, and how the simulation
works. It also says plainly where the model departs from a real Ford Ranger.

Contents

1. Fidelity and sources
2. The vehicle and its networks
3. CAN in depth (ISO 11898)
4. The physical layer: CAN-H, CAN-L and termination
5. Fault confinement: error frames, TEC/REC, error states
6. The gateway
7. Message catalogue (illustrative)
8. LIN sub-buses and RF links
9. Diagnostics: OBD-II, UDS and ISO-TP
10. Faults and scenarios: what happens and why
11. The cluster: data received, staleness, lamp-on-loss
12. Next-generation Ranger (2022+)
13. How the simulation works
14. Limits of the model
15. Fuel level management

---

## 1. Fidelity and sources

**Proprietary, so illustrative.** Ford's network specifications and CAN databases (DBC files) are not public. So the
following are **invented for teaching**, chosen to be plausible:

- message identifiers, names, payload layouts, scaling and transmit periods;
- which module sits on which bus, and the gateway routing table;
- where the 120 Ω terminators are fitted;
- the immobiliser (PATS) message exchange and its "crypto";
- the alive-counter/checksum scheme on safety frames;
- the lost-communication codes marked `*` (U0256\*, U0257\*, U0313\*).

**Modelled to the standards** (the point of the tool):

| Topic | Standard |
|---|---|
| Classical base frame, bit stuffing, CRC-15, arbitration, ACK, error detection, fault confinement | ISO 11898-1 (Bosch CAN 2.0A) |
| High-speed physical layer: differential levels, 120 Ω termination, thresholds | ISO 11898-2 |
| Transport protocol (SF/FF/CF/FC, BS, STmin, N_Bs timeout) | ISO 15765-2 (ISO-TP) |
| OBD on CAN: functional 0x7DF, responses 0x7E8+, PIDs | ISO 15765-4, SAE J1979 |
| Diagnostic services 10/3E/22/19/14, negative responses | ISO 14229 (UDS) |
| DTC format (P/C/B/U + 4 hex digits, two-byte encoding) | SAE J2012 |
| LIN protected identifier and enhanced checksum | ISO 17987 / LIN 2.x |
| DLC pin-out (6/14 HS-CAN, 3/11 Ford MS-CAN) | SAE J1962, plus widely published Ford usage |

**Public facts about the truck** used for the layout: PX2/PX3 owner and press material (EPAS from the PX2 facelift; SYNC 2/3;
the PX3 2.0 Bi-Turbo with 10R80; the 3.2 TDCi with 6R80; Tech-Pack ADAS with radar ACC and camera-based lane keeping; TPMS;
rear park aid; shift-on-the-fly 4×4 and the rear e-locker). Also the module set that community diagnostic tools commonly
show for Ford vehicles of this era.

## 2. The vehicle and its networks

### 2.1 Modules

| Module | Location (model) | Bus | Role |
|---|---|---|---|
| PCM | engine bay, left | HS-CAN1 | engine control, PATS, LIN master to the alternator |
| TCM | in the transmission valve body | HS-CAN1 | 6R80 / 10R80 shift control |
| ABS / ESC | engine bay, right | HS-CAN1 | wheel-speed sensors, hydraulics, vehicle-speed authority |
| RCM | transmission tunnel | HS-CAN1 | airbags, pretensioners, crash status |
| PSCM | on the steering rack | HS-CAN1 | electric power steering, steering angle |
| 4×4 module | near the transfer case | HS-CAN1 | transfer-case motor, e-locker |
| GWM | under the dash | all four | gateway (§6) |
| IPMA (camera) | top of the windscreen | HS-CAN2 | lane keeping, LDW, auto high beam |
| CCM (radar) | lower grille | HS-CAN2 | adaptive cruise, forward-collision warning |
| IPC | behind the wheel (RHD) | HS-CAN3 | instrument cluster |
| APIM | behind the centre stack | HS-CAN3 | SYNC 3, Emergency Assistance |
| ACM | behind the centre stack | HS-CAN3 | audio |
| BCM | lower dash, driver side | MS-CAN | lights, locks, wipers, power mode, RKE and TPMS receivers, LIN master |
| HVAC | behind the dash | MS-CAN | climate, LIN master to actuators |
| PAM | behind the rear bumper | MS-CAN | rear park sensors |
| TRM | at the rear | MS-CAN | trailer lamps and detection |
| DLC | under the dash | HS-CAN1 + MS-CAN | J1962 diagnostic connector |

### 2.2 Buses

| Bus | Rate | Bit time | Members | Terminators (model) |
|---|---|---|---|---|
| HS-CAN1 | 500 kbit/s | 2 µs | PCM, TCM, ABS, RCM, PSCM, 4×4, GWM, DLC | PCM, GWM |
| HS-CAN2 | 500 kbit/s | 2 µs | CCM, IPMA, GWM (PX3 with Tech Pack only) | CCM, IPMA |
| HS-CAN3 | 500 kbit/s | 2 µs | IPC, APIM, ACM, GWM | IPC, ACM |
| MS-CAN | 125 kbit/s | 8 µs | BCM, HVAC, PAM, TRM, GWM, DLC | BCM, TRM |

**Why several buses?** Bandwidth, fault containment and cost. Powertrain and chassis traffic is frequent (10 ms frames) and
safety-relevant. Body traffic is slow and spread along a long harness. Infotainment and ADAS add load and change more often
from one model year to the next. Splitting them means a fault or overload on one bus does not take the others down, and
the slow body bus can use cheaper parts. The cost is a gateway in the middle, which every cross-domain signal has to pass
through.

**PX2 vs PX3.** Select the build in the header. The PX2 (3.2 TDCi, 6R80) has no radar or camera, so HS-CAN2 is not
fitted and the gateway does not route to it. The PX3 (2.0 Bi-Turbo, 10R80) model has the full Tech-Pack fit.

## 3. CAN in depth (ISO 11898)

### 3.1 The classical base frame

```
 SOF | Identifier (11) | RTR | IDE | r0 | DLC (4) | Data (0–64) | CRC (15) | CRC del | ACK | ACK del | EOF (7) | IFS (3)
  0     MSB first          0     0    0    0–8 B                              1        0*     1        1111111   111
```

- **SOF**: one dominant bit. Every receiver hard-synchronises on its falling edge.
- **Identifier**: what the frame is (its meaning) and its priority. There are no node addresses: frames are broadcast and
  each receiver filters by ID.
- **RTR**: 0 for data frames. A remote frame (RTR = 1) loses arbitration to a data frame with the same ID.
- **IDE / r0**: 0 = standard 11-bit format.
- **DLC**: number of data bytes (0–8).
- **CRC**: CRC-15, generator `x^15 + x^14 + x^10 + x^8 + x^7 + x^4 + x^3 + 1` (0x4599), computed over SOF … end of data on the
  *unstuffed* bits.
- **ACK slot**: the transmitter sends recessive; every receiver whose CRC check passed drives it dominant.
- **EOF**: seven recessive bits, then a three-bit intermission before the bus is idle again.

An 8-byte frame is 108 bits plus stuffing (worst case 24 stuff bits in the stuffed region), plus 3 bits of intermission.
At 500 kbit/s that is roughly 220–270 µs on the wire. The decoder tab shows exact numbers for any frame.

### 3.2 Bit stuffing

CAN uses NRZ coding, and receivers re-synchronise on recessive-to-dominant edges. To guarantee edges, after **five
consecutive equal bits** the transmitter inserts **one bit of opposite polarity**. Receivers remove it. The stuff bit
counts as the first bit of the next run. Stuffing covers SOF to the end of the CRC sequence; the CRC delimiter, ACK field
and EOF are fixed-form and never stuffed. Six equal bits inside the stuffed region are therefore a **stuff error**, which is
also why a 6-bit error flag is guaranteed to be seen by everyone.

In the decoder, stuff bits are drawn white-on-black. Try `00 00 00 00 00 00 00 00` against a random payload.

### 3.3 Arbitration

CAN is multi-master. Any node may start when the bus has been idle for the intermission. Nodes that start on the same bit
arbitrate on the identifier (then RTR), bit by bit:

- dominant (0) overrides recessive (1): the bus is a **wired-AND**;
- each transmitter reads back every bit it sends;
- a node that sent recessive but reads dominant has **lost**. It stops transmitting at once and becomes a receiver;
- the winner never notices the contest, so its frame is not damaged (**non-destructive** arbitration).

The **lowest ID wins**. Losers retry automatically at the next idle bus. In the model, three nodes queueing 0x0A0, 0x0B0
and 0x0F0 together go out in that order. The arbitration table shows each node's bits, the resulting bus level, and where
each loser dropped out. An important consequence: the **worst-case latency** of a frame depends on its priority and on the
load of all higher-priority frames. That is why bus-load budgets (often kept under about 50–60 %) matter.

### 3.4 Acknowledgement

The ACK bit tells the transmitter that **at least one** node received the frame correctly. It does not say which node,
or how many. A transmitter alone on a bus (every other node off, or the bus cut) gets an **ACK error** on every attempt.

### 3.5 Error detection

| Error | Detected by | Rule |
|---|---|---|
| Bit error | transmitter | sent bit ≠ monitored bit (outside arbitration and the ACK slot) |
| Stuff error | receivers | 6 equal bits in the stuffed region |
| CRC error | receivers | computed CRC ≠ received CRC |
| Form error | all | fixed-form bit (CRC delimiter, ACK delimiter, EOF) is dominant |
| ACK error | transmitter | ACK slot stayed recessive |

A node that detects an error sends an **error frame**: an error flag (6 dominant bits when error-active), which breaks the
stuffing rule so everyone else notices too, superposition with the other nodes' flags (up to 6 more bits), then an 8-bit
recessive error delimiter. The transmitter then **retransmits automatically**.

## 4. The physical layer: CAN-H, CAN-L and termination

ISO 11898-2 high-speed CAN uses a twisted pair:

| State | CAN-H | CAN-L | V_diff |
|---|---|---|---|
| Recessive (1) | ≈ 2.5 V | ≈ 2.5 V | ≈ 0 V (receiver reads recessive below 0.5 V) |
| Dominant (0) | ≈ 3.5 V | ≈ 1.5 V | ≈ 2 V (receiver reads dominant above 0.9 V) |

The transceivers **drive** only the dominant state. Recessive is the bus being released, and the **termination** pulls
the two wires back together. A linear bus is terminated at **both ends** with 120 Ω, matching the cable's characteristic
impedance, so edges are absorbed instead of reflected. The two resistors in parallel read **60 Ω** across CAN-H/CAN-L with
the battery disconnected. That measurement, at DLC pins 6–14 for HS-CAN1 and 3–11 for MS-CAN, is the first test for a
termination fault.

| Condition | Ohmmeter | Effect in the model |
|---|---|---|
| Healthy | 60 Ω | clean edges, no errors |
| One terminator missing | 120 Ω | slower recessive edges, ringing from the unterminated end. Most frames pass; about 3 % on HS (0.4 % on MS) hit a stuff, CRC, form or bit error |
| Both missing | open (≫ 1 kΩ) | edges smear over whole bits. Most frames fail, and error counters drive nodes bus-off |
| CAN-H shorted to CAN-L | ≈ 0 Ω | V_diff stuck near 0 V, so nobody can make a dominant bit. Every transmitter gets bit errors and goes bus-off |
| CAN-H shorted to ground | 60 Ω across H–L, 0 Ω H–ground | CAN-H at 0 V, so no positive differential is possible. As above |

The scope tab draws CAN-H (orange), CAN-L (blue) and V_diff for the latest frame on the selected bus, with a field band,
stuff-bit markers and the 87.5 % sample point. The waveform shapes are qualitative, not SPICE results. The error
probabilities are model parameters chosen to show the behaviour.

## 5. Fault confinement: error frames, TEC/REC, error states

Each controller has a **transmit error counter (TEC)** and a **receive error counter (REC)**. The model implements the main
ISO 11898-1 rules:

- transmitter detects an error → **TEC += 8**;
- receiver detects an error → **REC += 1**;
- successful transmission → **TEC −= 1** (not below 0);
- successful reception → **REC −= 1**, or, if REC > 127, REC is set back to a value between 119 and 127 (the model uses 120);
- exception: an **error-passive transmitter** with an **ACK error** (and no dominant bit during its passive flag) does not
  increment its TEC. A lone node therefore stalls at error-passive instead of going bus-off.

States:

| State | Condition | Behaviour |
|---|---|---|
| Error-active | TEC ≤ 127 and REC ≤ 127 | sends active (dominant) error flags |
| Error-passive | TEC > 127 or REC > 127 | sends passive (recessive) error flags; waits 8 extra bit times ("suspend transmission") before transmitting again after its own frame |
| Bus-off | TEC > 255 | does not take part in bus activity at all. It may restart after seeing **128 occurrences of 11 consecutive recessive bits** and a restart request from its host software |

Each bus-off in the model is followed by a host restart delay (200 ms by default, 80 ms for the TRM). The delay doubles
after each further bus-off, up to 10×. Many ECUs use a similar "slow recovery" strategy so that a node with a persistent
fault does not keep disturbing the bus. The design goal of the scheme is that a **node with a local fault removes itself**:
its TEC climbs 8 per failure while each healthy receiver gains only 1, and loses it again with every good frame.

What fault confinement **cannot** do: stop a node that sends **valid** frames too often (a babbling idiot). Its frames are
perfect, so no counters move. Scenario 8 shows both cases.

## 6. The gateway

The GWM is a node on all four buses. For each frame it receives it looks up `(ID, source bus)` in its routing table. It
then queues a **new frame with the same ID and data** on each destination bus, after a processing latency of 250 µs in the
model. Each copy competes in arbitration on its own bus, so end-to-end latency is the source frame time, plus gateway
latency, plus queuing, plus the destination frame time. In the log, copies show as `GW←HS1` etc.

Routes in the model (illustrative):

| ID | Name | From | To |
|---|---|---|---|
| 070 | RCM_CrashStatus | HS1 | HS3, MS |
| 090 | ABS_WheelSpeeds | HS1 | HS2 |
| 0A0 | ABS_Status | HS1 | HS2, HS3, MS |
| 0B0 | PSCM_Steering | HS1 | HS2 |
| 0F0 | PCM_Engine | HS1 | HS2, HS3 |
| 110 | TCM_Gear | HS1 | HS2, HS3, MS |
| 120 | PCM_Engine2 | HS1 | HS3, MS |
| 128 | PCM_FuelFlow | HS1 | HS3 |
| 130 | TC4_Status | HS1 | HS3 |
| 331 | PCM_PATS | HS1 | MS |
| 0C8 | CCM_ACC | HS2 | HS1, HS3 |
| 0D0 | IPMA_Lane | HS2 | HS1, HS3, MS |
| 330 | BCM_PATS | MS | HS1 |
| 340 | BCM_Power | MS | HS1, HS2, HS3 |
| 3A0, 3B0, 3B8, 3C8 | PAM / doors / lights / TPMS | MS | HS3 |
| 3D0, 3E0, 3F0 | battery / HVAC / trailer | MS | HS1, HS3 |

It also routes **physical diagnostic IDs**: a request on HS-CAN1 to a module on HS-CAN2/3 (e.g. 0x720 for the IPC) is
forwarded to that bus, and the response (0x728) comes back.

On many real Ford platforms of this era the gateway function is built into the BCM or the cluster rather than a separate
box. The behaviour is the same.

## 7. Message catalogue (illustrative)

Bit numbering in this model: bit 0 is the MSB of byte 0, counting on through the bytes ("big-endian sequential").
Safety frames end with a 4-bit **alive counter** (byte 6, low nibble) and a **checksum** in byte 7:
`(ID low byte + ID high byte + data[0..6]) mod 256, XOR 0xFF`. Receivers check both. This scheme is illustrative,
not Ford's.

| ID | Name | Tx | Bus | Period | Key signals |
|---|---|---|---|---|---|
| 070 | RCM_CrashStatus | RCM | HS1 | 100 ms (10 ms after a crash) | CrashDetected, DeployFront, FuelCutReq, DrvBelt, AirbagLamp, severity |
| 090 | ABS_WheelSpeeds | ABS | HS1 | 10 ms | four wheel speeds, 0.01 km/h |
| 098 | ABS_Inertial | ABS | HS1 | 10 ms | yaw rate, lateral and longitudinal acceleration |
| 0A0 | ABS_Status | ABS | HS1 | 20 ms | VehSpeed, ABS/ESC/TCS active and fault flags, WhlValid, BrakePress |
| 0B0 | PSCM_Steering | PSCM | HS1 | 10 ms | SteerAngle 0.1°, rate, driver torque, LkaApplied |
| 0F0 | PCM_Engine | PCM | HS1 | 10 ms | EngRpm 0.25 rpm, pedal, torque, EngRunning |
| 100 | PCM_TorqueCoord | PCM | HS1 | 10 ms | actual, maximum and minimum torque |
| 110 | TCM_Gear | TCM | HS1 | 20 ms | Selector PRNDM, GearActual (0 N, 1–10, 15 R), lockup, temperature |
| 118 | TCM_TorqueReq | TCM | HS1 | 10 ms | torque reduction request, output shaft rpm |
| 120 | PCM_Engine2 | PCM | HS1 | 100 ms | coolant, raw fuel level, SenderOhms, SenderFault, MIL, outside temperature, FuelCut |
| 128 | PCM_FuelFlow | PCM | HS1 | 100 ms | FuelRate 0.05 L/h, FuelUsed rolling 16-bit mL counter, fuel temperature |
| 130 | TC4_Status | 4×4 | HS1 | 100 ms | Mode4x4, ShiftInProg, LockerActive, ShiftDenied |
| 331 | PCM_PATS | PCM | HS1 | event | immobiliser response |
| 0C8 | CCM_ACC | CCM | HS2 | 20 ms | AccState, target distance and relative speed, AccelReq, SetSpeed, FCW |
| 0D0 | IPMA_Lane | IPMA | HS2 | 50 ms | lanes, LkaState, LDW, lateral offset, torque request, auto high beam |
| 3C0 | IPC_Info | IPC | HS3 | 200 ms | odometer, damped FuelGauge, RangeKm, AvgCons, LowFuel, chime request |
| 400 | APIM_Status | APIM | HS3 | 100 ms | screen, EmergCall |
| 410 | ACM_Status | ACM | HS3 | 200 ms | source, volume |
| 330 | BCM_PATS | BCM | MS | event | challenge / start authorisation |
| 340 | BCM_Power | BCM | MS | 100 ms | IgnStatus (OFF/ACC/RUN/START/REMOTE), remote start |
| 3A0 | PAM_Rear | PAM | MS | 100 ms in R | four zone distances, chime rate |
| 3B0 | BCM_Doors | BCM | MS | 100 ms | doors, tailgate, bonnet, Locked, LockEvent |
| 3B8 | BCM_Lights | BCM | MS | 100 ms | headlamp, turn, hazard, brake, reverse, ambient light, wiper, rain |
| 3C8 | BCM_TPMS | BCM | MS | 1 s | four pressures (1.5 kPa/bit), low flags |
| 3D0 | BCM_Battery | BCM | MS | 500 ms | voltage, SOC, current, temperature |
| 3E0 | HVAC_Status | HVAC | MS | 200 ms | set temperature, fan, AcReq, mode, cabin temperature |
| 3F0 | TRM_Status | TRM | MS | 500 ms | TrlConnected, lamp faults |

Bus loads in normal driving come out at roughly 20 % (HS-CAN1), 12 % (HS-CAN2), 9 % (HS-CAN3) and 17 % (MS-CAN).

## 8. LIN sub-buses and RF links

LIN (ISO 17987, 19.2 kbit/s, one wire) is used where a cheap single-master link is enough. The master sends every
**header**: a break of at least 13 dominant bits, a sync byte 0x55, and the **protected identifier**. The PID is the 6-bit
ID plus two parity bits: P0 = ID0⊕ID1⊕ID2⊕ID4, P1 = ¬(ID1⊕ID3⊕ID4⊕ID5). The slave that publishes that ID replies with
data and an **enhanced checksum**: an inverted sum with carry, over the PID and the data. There is no arbitration; the
master's schedule table decides who speaks.

Model schedules (20 ms slots): BCM ↔ rain/light sensor (0x23) and battery monitor (0x2C); PCM ↔ smart alternator (0x29
command, 0x2A status); HVAC ↔ flap actuators (0x10 / 0x11). The BCM repackages LIN data onto CAN (ambient light into
BCM_Lights, battery into BCM_Battery).

**RF links (not wired).** The key fob and the four TPMS wheel sensors transmit radio telegrams (315/433 MHz depending on
market) to receivers in the BCM. Only what the BCM concludes reaches the CAN bus.

## 9. Diagnostics: OBD-II, UDS and ISO-TP

### 9.1 Access

The scan tool is a node on the DLC: HS-CAN1 on pins 6/14 and MS-CAN on pins 3/11. Modules on HS-CAN2/3 are reached only
through the gateway's diagnostic routing. Physical request/response IDs used in the model (response = request + 8): PCM
7E0, TCM 7E1, ABS 760, RCM 737, PSCM 730, 4×4 761, GWM 716, IPMA 706, CCM 764, IPC 720, APIM 7D0, ACM 727, BCM 726,
HVAC 733, PAM 736, TRM 775. These match IDs widely reported by the Ford diagnostic community, but treat them as
illustrative. **OBD-II** requests use the functional ID **0x7DF**; here the PCM answers on 0x7E8.

### 9.2 ISO-TP (ISO 15765-2)

| PCI (high nibble of byte 0) | Frame | Layout |
|---|---|---|
| 0 | Single Frame | `0L d1…d7`: payload ≤ 7 bytes |
| 1 | First Frame | `1L LL d1…d6`: 12-bit total length |
| 2 | Consecutive Frame | `2N d1…d7`: sequence number N = 1, 2 … 15, 0, 1 … |
| 3 | Flow Control | `3S BS ST`: S = 0 CTS / 1 WAIT / 2 overflow; BS = block size (0 = no more FC); ST = STmin (0–127 ms, F1–F9 = 100–900 µs) |

The sender sends the FF and then waits for a FC (**N_Bs** timeout of 1000 ms in the model). It then sends BS consecutive
frames, spaced at least STmin apart, and after each block waits for another FC. The receiver checks the sequence numbers.
The Diagnostics tab lets you choose the tester's BS and STmin and shows every frame. Example: the 20-byte VIN response
`49 02 01 + 17 ASCII` with BS = 1 takes FF, FC, CF, FC, CF.

### 9.3 Services implemented

| Request | Response | Notes |
|---|---|---|
| `01 00` | `41 00 A B C D` | bitmap of supported PIDs 01–20 (04, 05, 0C, 0D, 11) |
| `01 0C` | `41 0C A B` | RPM = (256A + B) / 4 |
| `01 0D` | `41 0D A` | km/h. The PCM reports the ABS speed it **received** (0 if stale) |
| `01 05` | `41 05 A` | °C = A − 40 |
| `01 20` / `01 40` | `41 20/40 A B C D` | next PID-support bitmaps (2F; 5E). The last bit of each bitmap says the next range exists |
| `01 2F` | `41 2F A` | fuel tank level input = A·100/255 % (the PCM's sender reading) |
| `01 5E` | `41 5E A B` | engine fuel rate = (256A + B)/20 L/h |
| `03` | `43 n DTC…` | stored emission (P) codes, 2 bytes each |
| `09 02` | `49 02 01 VIN` | multi-frame. The VIN is deliberately fake: `SIMRANGERPX300001` |
| `10 03` | `50 03 00 32 01 F4` | extended session, P2 = 50 ms, P2* = 5000 ms |
| `3E 00` | `7E 00` | tester present |
| `22 F190` / `22 F188` | `62 …` | VIN / software part number (fake) |
| `19 02 FF` | `59 02 FF [DTC(3) status]…` | ReadDTCInformation by status mask |
| `14 FF FF FF` | `54` | clear all DTCs |
| other | `7F sid NRC` | 0x11 serviceNotSupported, 0x31 requestOutOfRange … |

DTC status bytes in the model: **0x2F** while active (testFailed, testFailedThisOperationCycle, pending, confirmed,
testFailedSinceLastClear), and **0x28** once the fault has gone (confirmed + failed since last clear, stored). The tester's
P2 timeout is 150 ms; "no response" usually means the module is off, its bus is down, or the gateway is.

## 10. Faults and scenarios: what happens and why

| Fault / event | Mechanism | Visible effects |
|---|---|---|
| **Module silent** (e.g. ABS unpowered) | Frames simply stop. CAN has no "node lost" signal, so listeners detect it by timeout. In the model a U-code is set after 10 × period, or at least 500 ms | U0121 in PCM, PSCM, 4×4, BCM, IPC, CCM…; the cluster's speedo goes stale and the ABS/ESC lamps come on; ACC cancels; the PCM sets P0500 |
| **Wheel-speed sensor open** | Hard-wired sensor; the ABS detects the open circuit | C0035; FL marked invalid; AbsFault/EscFault flags; vehicle speed from three wheels; ACC unavailable; HDC unavailable |
| **CAN-H short to ground / to CAN-L** | No dominant level is possible | Bit error on every SOF, TEC +8 per try, bus-off after 32 tries; the whole bus is silent; other buses keep running; U-codes beyond the gateway |
| **Missing terminator(s)** | Reflections / slow edges | One missing: occasional error frames, retransmissions, 120 Ω at the DLC. Both: error storm, bus-off |
| **Corrupt babbler** | Wins arbitration (ID 0x005), then hits a bit error | TEC climbs 8 per attempt; error-passive, then bus-off; the bus recovers; repeated restarts back off |
| **Valid babbler** | Sends ID 0x010 back to back | 100 % load; higher IDs starve; U-codes; no error counters move. Must be found and unplugged |
| **Gateway failure** | No forwarding | Four healthy islands; the cluster goes stale; ACC cancels (no speed); the PCM loses the ACC request; diagnostics reach only HS-CAN1 and MS-CAN |
| **Crash** | The RCM fires squibs directly, then broadcasts 0x070 every 10 ms | The PCM cuts fuel; the BCM unlocks and flashes the hazards; SYNC starts Emergency Assistance; the cluster shows it |
| **Keyless entry** | RF to the BCM; the BCM wakes MS-CAN; the gateway wakes HS-CAN3 | Doors unlock; cluster welcome mode |
| **Remote start** | The BCM wakes every bus and checks locked, closed and P (from the TCM via the gateway); PATS challenge/response with the PCM; crank | Power mode REMOTE with a 10-minute timer. Refused if the gateway is down or the gear is not P |
| **4×4 shift** | The 4×4 module needs fresh speed and selector frames | 2H↔4H on the move; 4L only when stopped in N; refused with "no data" if the ABS is silent |

## 11. The cluster: data received, staleness, lamp-on-loss

The cluster view is drawn **only from the IPC's receive buffer**: the last data and timestamp of each frame that reached
HS-CAN3. A value is **stale** once its age exceeds 3 × the message period, plus 20 ms. Stale values turn grey with a
`STALE` tag and their age. As real clusters do, the IPC treats missing safety data as a fault: no ABS frame lights ABS and
ESC, and no RCM frame lights the airbag lamp. The freshness table lists every input, which bus it came from, and how old
it is.

With the ignition off the network sleeps (§13.4), and the cluster says so rather than flagging everything stale.

## 12. Next-generation Ranger (2022+)

What is publicly reported, at the level of general direction:

- A newer global Ford electrical architecture with many more modules and a central **secure gateway**. Diagnostic writes
  and configuration need **authenticated access**, so independent tools need online authorisation for some functions.
- **CAN FD** on the busiest buses: the same arbitration at 500 kbit/s, then a faster data phase (e.g. 2 Mbit/s) and payloads
  up to 64 bytes. It also has a 17- or 21-bit CRC with stuff-bit counting. The extra bandwidth suits sensor fusion and leaves
  room for **message authentication codes** (SecOC-style) on selected frames.
- Much more ADAS: forward radar plus camera, corner radars for blind-spot and cross-traffic alert, a 360° camera and active
  park assist. A **digital cluster**, and **SYNC 4A** on a large portrait screen.
- A built-in **modem** (FordPass Connect) for remote functions (app lock/unlock, remote start, status) and **over-the-air
  updates** of module software.
- The general move toward fewer, larger domain controllers, and toward **automotive Ethernet** for high-bandwidth links
  (cameras, infotainment).

None of this is modelled in the simulation; it is described in the About tab.

## 13. How the simulation works

### 13.1 Discrete-event core

`index.html` contains a DOM-free core between `CORE-BEGIN` and `CORE-END`, which the Node tests run directly. It uses
a binary-heap event queue, `at(t, fn)`, in **true seconds of bus time**.

- **Controllers.** Each node has one controller per bus, with a transmit queue. Periodic frames sit in a **mailbox per
  ID**: newer data overwrites an unsent frame, which is counted as "overwritten". Other frames (diagnostics, events) queue
  first-in first-out. Several mailboxes are served lowest ID first, as in typical controllers.
- **Bus.** When the bus is idle and frames are pending, an `arbitrate` event gathers every eligible head-of-queue frame
  (not bus-off, past any suspend time). The lowest ID wins. The winner's real bit sequence comes from `frameBits()`, so
  durations include the actual stuff bits. The outcome (OK, an error type at a bit position, or an ACK error when nobody
  else is listening) is decided from the bus and node fault state. An end event at `t0 + bits / bitrate` then applies the
  counter rules, delivers the frame to receivers (their receive buffer, the gateway, behaviour hooks, ISO-TP) and frees the
  bus after 3 bits of intermission.
- **Shorts** produce a 15-bit error frame on every attempt by all contenders (SOF bit error, flag, delimiter).
- **Vehicle model.** A 5 ms tick integrates a simple longitudinal model: drive, rolling and aero drag, brakes, creep, an
  automatic shift schedule using the real 6R80/10R80 ratio sets, torque-converter slip and 4L reduction. It also models
  steering geometry for the wheel-speed split, and slow states such as temperatures, fuel and battery.
- **Module behaviour.** A transmit function per message builds the payload **from what that module knows**: its own
  sensors, or frames it has received. So the radar's ACC needs the ABS speed via the gateway; the PCM applies an ACC
  request only if it received a fresh one; and the 4×4 module refuses to shift without fresh frames.
- **Monitors** run every 100 ms and set or age out DTCs. Network management (sleep and wake) is a simple per-bus
  "awake-until" time.

### 13.2 Time and animation

- **Real time.** Bus time advances with the wall clock, so the buses carry their full traffic (about 1,800 frames/s in
  total). Animating every frame is impossible, so the animation **samples**: roughly one frame per bus every 0.26 s,
  rotating through the IDs, each shown for 0.9 s. Gatewayed copies of a sampled frame chain on after it, so the path is
  visible. Errors are always shown. The log shows every frame.
- **Slow-mo ÷N.** Bus time advances at 1/N of the wall clock and **every** frame is animated, with its progress tied to bus
  time: a glow front from the transmitter, the bus lit for the frame's length on the wire, receivers flashing at the end.
  At ÷1000 an 8-byte HS frame takes about a quarter of a second. At ÷20000 one bit is 40 ms. The vehicle model slows down
  too, so everything stays consistent.
- **Pause / Step frame** runs events until the next frame or error frame ends.

### 13.3 Randomness

A seeded PRNG (mulberry32) drives the message phases, error positions and payload noise. `?seed=N` in the URL changes it.

### 13.4 Sleep and wake

Ignition OFF keeps the networks awake for 1.5 s, then the modules stop transmitting. A fob press or door switch wakes
MS-CAN and HS-CAN3 for about 10–12 s; remote start wakes everything. Transceivers still acknowledge while "asleep", which
simplifies what a real ISO 11898-2 transceiver in standby with remote wake-up does.

## 14. Limits of the model

- IDs, layouts, rates, routing, bus membership and terminator locations are **illustrative** (§1).
- Each controller is either error-free, or fails a whole frame at one bit. There is no per-bit synchronisation, phase-error
  modelling, overload frames, or the receiver "+8 after own error flag" rule. CAN FD and extended 29-bit IDs are not modelled.
- The scope waveforms are qualitative. The error probabilities for termination faults are parameters, not physics.
- Wake-up, network management and partial networking are simplified. Real Ford modules use their own network-management
  frames and wake lines.
- The PATS exchange and the safety checksum are made up and have nothing to do with Ford's security mechanisms.
- The vehicle dynamics are deliberately simple; the network is the subject.

## 15. Fuel level management

Ford's real values are not public. The chain below follows common automotive practice; the numbers are illustrative.

```
 float + resistor card ──wire──▶ PCM ──HS-CAN1──▶ GWM ──HS-CAN3──▶ IPC ──▶ needle, range, low-fuel lamp
 (in the 80 L tank)              │   0x120 raw level, SenderOhms, SenderFault       │   0x3C0 FuelGauge, RangeKm,
                                 │   0x128 FuelRate, FuelUsed (mL counter)          │   AvgCons, LowFuel, chime
                                 └── circuit check → P0462 / P0463, OBD PIDs 2F, 5E
```

**Sender.** A float on an arm moves a wiper along a resistor card. In the model the resistance runs from 160 Ω (empty) to
15 Ω (full), through a slightly non-linear tank-height curve. The sender is a hard-wired analog input to the PCM, not a CAN
node, which is the usual arrangement for a single-sender diesel tank.

**Slosh.** The free surface is modelled as a lightly damped oscillator (about 0.55 Hz, ζ ≈ 0.07). It is driven by
longitudinal and lateral acceleration, plus a little road ripple. A hard stop from 90 km/h swings the float reading by
roughly 25–30 percentage points.

**PCM.** The PCM reads the resistance every 100 ms. Above 220 Ω it reports an open circuit: **P0463** "Fuel Level Sensor A
Circuit High", `SenderFault = open`, level 0. Below 5 Ω it reports a short: **P0462** "Circuit Low". Otherwise it
converts the resistance to a percentage and broadcasts it **unfiltered**. Separately it reports the fuel it commands in
0x128: an instantaneous rate, and a rolling 16-bit millilitre counter that receivers difference (handling the wrap at
65 536).

**Cluster (IPC).**
- *Initialisation:* on wake-up the gauge snaps to the current raw value.
- *Anti-slosh damping:* a first-order filter with a time constant of about 40 s, so the needle ignores braking, cornering
  and bumps. The test suite checks that a 27 % raw swing moves the gauge by less than 1 %.
- *Fast-fill:* if the raw level stays more than 5 % above the gauge for 2 s while the ABS speed is below 2 km/h, the cluster
  treats it as a refuel and uses a 1.5 s time constant until it has caught up.
- *Consumption:* it integrates the 0x128 millilitre counter against distance from the ABS speed, and keeps an
  exponentially weighted average in L/100 km. It also shows instantaneous L/100 km.
- *Range (DTE):* (gauge litres − ~4 L hidden reserve) ÷ average × 100.
- *Low fuel:* below ~11 L on the **damped** gauge, so a slosh cannot trigger it. Lamp, chime request, `LowFuel` in 0x3C0.
- *Invalid data:* if 0x120 is missing or `SenderFault ≠ ok`, the cluster shows "---" and flashes the fuel lamp. It does not
  show "empty", because it was told the reading is untrustworthy.

**Running dry.** At 0 L the engine stops. A diesel may need its fuel system primed before it restarts.

**Burn ×N (demo shortcut).** The multiplier drains the tank N× faster than the injected quantity reported in 0x128, so
the learned average consumption and range keep realistic values. It also divides the cluster's 40 s filter by N, so the
gauge keeps pace with the compressed time. At ×1 everything runs in real time.
