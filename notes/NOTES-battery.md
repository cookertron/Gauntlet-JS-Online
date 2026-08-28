# Gauntlet — the section 8 diagnostic battery

"Is this game like the example?" — run before writing any engine code.
Answers are **measured**, with the tool that produced them named. Where a
question is not yet settled it says so; nothing here is filled in by analogy
with the Chuckie Egg case study.

Tools: `tools/tzx.py`, `tools/grepbytes.py`, `tools/harness.py`,
`tools/battery.py`, `tools/keyprobe.py`, `tools/filmstrip.py`, `tools/screen.py`.

---

## Pre-harness (Q1–Q9)

**Q1 — tape structure and protection.** Not protected in any way that defeats
a block parser. Two TZX v1.10 images, only IDs `0x30`, `0x10`, `0x20`; every
checksum clean; no `0x15`/`0x18`/`0x19`. The only deviation is non-standard
flag bytes (`$80/$81/$82` on side 1, `$80` + 30× `$C0` on side 2) and a
ROM-edge-assisted custom loader. **Block copy works; the snapshot route is not
needed; R3 (byte cross-check) remains available.** Full detail in
`NOTES-loader.md`.

**Q2 — port inventory.** Static (confirmed at instruction boundaries) plus
dynamic over driven play:

| port | direction | site(s) | meaning |
|------|-----------|---------|---------|
| `$xxFE` | IN | `$B4EE` (`IN A,(C)`, BC=`$FEFE` rotated) | keyboard, all 8 half-rows every pass |
| `$00FE` | OUT | `$B4FC`, `$B8DB`, `$923C` | border — **and the SPEAKER**, on a 48K: `$B8DB` is the beeper's own toggle and it is live whenever `($FFFD) == 0`. See Q17 |
| `$FFFD` | OUT | `$BB9D` | **AY-3-8912 register select** (the PORT; RAM address `$FFFD` is a different thing entirely — Q17) |
| `$BFFD` | OUT | `$BBA2` | **AY-3-8912 data** |
| `$7FFD` | OUT | `$61A8` (block A only) | the 128K PAGING PROBE that chooses the sound driver — Q8's "no `$7FFD` writes" is true of block C, not of the front end |
| `$1F` | IN | `$8682` | Kempston joystick (one of the four control methods) |

No `$7FFD` (no 128K paging). The `$DE/$07/$D7/$1E/$6B` "ports" reported by an
early naive recursive-descent walk were walker drift into data and are not
instructions — they do not appear in the dynamic inventory.

**Q3 — self-modification. YES, and it matters.** `tools/battery.py` flags 29
distinct (writer PC → target) pairs writing into bytes that have been
executed. They are operand patches, always a 16-bit pair:

```
$9FF3 -> $A00F/$A010     $9F70 -> $9F88/$9F89     $B583 -> $B578/$B579
$A0B3 -> $A0CA/$A0CB     $A250 -> $A294/$A295     $A28D -> $A297/$A298
$ABB4 -> $A21F/$A220     $A2C7 -> $A2F5 (single byte)
```

**Consequences, per the manual's own warning:** a coverage-based code/data map
is unreliable in both directions here; a per-transition differential replay
must re-seed the *patched operands* as part of the mutable world, not just the
data; and the isolation harness must never byte-patch the image.

**Q4 — ROM called at runtime? YES.** `$9247 CALL $056B` enters the ROM's
`LD-BREAK`/`LD-BYTES` to load dungeon packs. So the harness uses a **real 48K
ROM locally** (SkoolKit's `resources/48.rom`), never shipped and never
transcribed. No other sub-`$4000` transfers survive instruction-boundary
confirmation.

**Q5 — does the game block run standalone? YES.** A plain block copy of the
three side-1 blocks plus `JP $8400` boots to the title screen. There is no
one-shot loader-written guard. (`tools/mkimage.py` asserts each payload length
against the loader's own `DE`.)

**Q6 — reference disassembly?** None found or used. Everything here is
first-hand. The `IY = $847F` global base (see `NOTES-loader.md` §7) replaces
most of what a reference would have supplied.

**Q7 — level format. CLOSED, and the level data ships.** The answer is *not*
"drive the original and read each dungeon out of live RAM", which is what this
question's fallback advice was: the format is decoded from the tape bytes
alone by `tools/packdecode.py` (Python) and by the engine's own port of
`$97CB` (JavaScript), and both agree with the original **cell for cell on all
307 dungeons**.

* A side-2 block is a **pack**. `+$0B9` holds ten 16-bit sub-block lengths,
  `+$0D0` the sub-blocks; the last byte of the block is `$FF`. A sub-block is
  one **record** and one record is one dungeon: `+0` length low byte, `+1`
  flags, `+2` bit 7 the 9th length bit and bits 3–5 the colour scheme, `+3`
  the vector-table length, then the vector table and an RLE cell stream.
* **`+$006` is CODE.** The loader `RET`s into the block and the pack's own
  179-byte stub — byte-identical in all 31 packs — decides which sub-blocks
  come out. Pack 0 (flag `$80`) ships all 7 of its records as dungeons 1–7;
  each of the 30 `$C0` packs draws four of its ten, one played at once and
  three stashed, so **one pack is four levels**.
* `$97CB` expands a record into the 32×32 map at `$8000`.
* **Closure: 307/307 sub-blocks, 1024/1024 cells each**, plus the player start
  and the whole actor list in the original's own order —
  `python tools/packgate.py all` compares the original against the Python
  decoder, and `node tools/headless.js` compares it against the shipped engine
  through `build/levelcheck.json` (`python tools/levelgate.py`).

The guess in the old answer was wrong on both counts: `$5F00..$6F7F` is the
**graphics bank** (the `$1080`-byte LDIR is the four character sets, and the
`$FFFF` boot bug is why it ends up holding ROM), and the level list lives at
`$6F80..$73D9` plus `$DDD8..$DFFF`, 1,666 bytes copied to `$C000` by `$91D7`
before every record walk. Nothing is "the live map buffer" but `$8000..$83FF`
itself.

**Q8 — machine, paging, multi-load.** 48K; no `$7FFD` writes; **multi-load
confirmed** — the game loads further dungeon packs from side 2 during play.

**Q9 — pre-shift test.** Not yet run. It matters more here than in a
single-screen game: this is a scroller (Q15), so the copy count is the
horizontal scroll granularity, not a compensation.

---

## Post-harness (Q10–Q19)

**Q10 — the clock. FRAME-SYNCED, one main-loop pass per FOUR video frames.**
Measured, not read: T-states between successive visits to the top of the main
loop at `$8503`, over driven play —

```
   3.97 frames  ###### 6
   4.03 frames  ######## 8
```

A tight cluster at 4.0 with no 2× or 3× tail, so **no dropped frames in this
scene**. The ±0.03 is where the frame interrupt falls relative to the loop
top, not jitter in the game. The game is genuinely HALT-paced: its wait loops
are `HALT / HALT` pairs (e.g. `$9D31`).

That gives an update rate of **50.08 / 4 = 12.52 Hz**, and it is the single
most consequential number in the project.

*QUALIFICATION, phase 11 — AND THE FIGURE ABOVE IS THE WRONG BRANCH'S.*
Everything in this answer down to here was measured on the **128K/AY** arm,
because the harness never ran the real menu and RAM `$FFFD` held a stale
`$2A`, which `$BF21` treats as 128K. **A real 48K answers 0 and runs the
BEEPER, and that is the branch this port now ships** (Q17). Re-measured on
`build/state_48k.pkl`, which reaches the branch through the game's *own*
`$7FFD` probe rather than a poke, 200 passes a cell, anchored on `$8503`
(`python tools/beepgate.py clock`):

| key | 48K / beeper | 128K / AY |
|---|---|---|
| idle | 4.145 `{4:171, 5:29}` | 4.000 `{4:200}` |
| right | 4.040 `{4:192, 5:8}` | 4.000 `{4:200}` |
| down | 4.810 `{4:38, 5:162}` | 4.100 `{4:180, 5:20}` |
| left | 4.510 `{4:98, 5:102}` | 4.000 `{4:200}` |
| up | **5.000** `{5:200}` | 4.000 `{4:200}` |

**A PASS IS A WHOLE NUMBER OF FRAMES, NEVER A FRACTION.** The distribution is
discrete in every cell, so 4.375 — the number this note used to carry — is a
*duty cycle*, not a period, and it was a 16-pass window besides. Do not quote
a single 48K clock figure; quote the range and the scene.

*CORRECTED, phase 12: "FOUR OR FIVE" is scene-limited and this table's five
cells are all quiet ones.* Over 2,740 driven passes across 38 scenes the
whole-frame histogram is `{4:1023, 5:1447, 6:249, 7:21}`; six-frame passes are
ordinary at a generator cluster and a planted 190-actor pass reaches 16. The
law is `frames = 2 + ceil((p + W1)/FRAME_T)`, and four-or-five is simply what
a W1 near 1.8 frames produces.

*WHY, and it is not an audio cost.* `$B8CC`, the beeper's noise sample, is
58 T-states of extra work **per drawn object even in total silence** (68 T
against the 128K arm's 10 T `RET`, enumerated over all 256 values of `R`),
and it is called ~250 times a pass from six sites inside the blitter. That is
0.207 frames charged against a compute budget of TWO FRAMES MINUS THE PHASE,
which a quiet pass already fills to 1.80 of 2.00. The identity, measured by
T-stamping `$8503`, `$9CD7` and `$9CD8`:

```
one pass = ceil(p + W1) - p + ISR + W2
p 0.178..0.205   W1 1.797 (idle)..1.934 (down)   W2 2.166   ISR ~2000 T
"p + W1 > 2.0  <=>  a 5-frame pass" called 720/720 passes correctly
```

so the observable is 0 or 1 WHOLE frame and the tip rate is wildly
scene-dependent. `$B8FB`, the tone tick, is **not** one of `$BF21`'s ten
bytes and burns 12,811 T (0.1833 frames) of `DEC HL` delay every pass on
BOTH branches, audible or not; the whole measured slowdown is `$B8CC`.

*WHAT THE ENGINE DOES — **CLOSED**, and the paragraph this replaces is kept at
the end because refusing to ship a 62.7% fit was right.* The port now keeps a
T-STATE CLOCK and charges every pass the work it did. `python
tools/clockgate.py`; `web/template.html` → `CLK`, `clockCost()`, `quantise()`.

**THE MECHANISM IS EXACT AND IT IS NOT A FIT.** A 48K pass executes exactly
ONE `HALT`, at `$9CD7`, reached from `$8550` — 200/200 driven passes over five
scenes, `{$9CD7: 1}` every time and no other `HALT` retired. (`$9D2D`'s
`HALT`/`HALT` pair is the AY arm's and is unreachable here.) So

```
$8503 ....... W1, the work, interrupts ON ....... $8550 CALL $9CD7
$9CD7 HALT   <- waits for the next frame interrupt: THE QUANTISER
$9CD8 DI, the tone tick, three shadow->screen copies, $9CF8's hand
      CALL $A29F, $8491++, $B4FF's clear, $8553 ................ W2

cost = ceil((t + W1)/FRAME_T)*FRAME_T + W2 - t          t = phase at $8503
```

reproduced the measured cost on 200/200 passes to within 19 T.

**W2 IS COMPUTABLE TO THE T-STATE, and the engine computes it.** 147,491 T of
straight line (196 of 200 passes exactly) plus THREE handler bodies — the
`HALT`'s own wake interrupt, `$9CF8`'s hand call, and **one more accepted
inside `$B4FF`'s screen clear**, because `$A29F` ends `$A2ED EI / $A2EE RET`
so interrupts are back on for the tail (exactly one, at `$B50B..$B51B`, on
150/150 passes). A body is 2,205 T except when `($8497 & 7) == 6` *before* its
own `$A2A2 INC`, when `$A2B4`'s `RRCA x3 / CP $E0 / JR nc` skips the GAUNTLET
logo colour cycle and it costs 328 T — 94/94 samples at that residue, 570/570
at the others. Predicting W2 that way was inside 40 T on 200/200 passes, which
is why the phase `p` is pinned at 0.155..0.205 frames.

**`$8497` IS NOT A VIDEO-FRAME COUNTER — it counts HANDLER INVOCATIONS**, so
it advances by (boundaries inside W1) + 3, which equals the pass's frame cost
whenever every interrupt is taken. Measured over 61 passes from the saved
state, two independent steppers:

| dir | frames/pass | `$8497`/pass | health after 61 |
|---|---|---|---|
| right | 4.131 | 4.000 | `$1993` |
| left | 4.525 | 4.016 | `$1993` |
| up | 5.000 | 5.000 | `$1992` |
| down | 4.425 | 4.262 | `$1982` |
| idle | 4.131 | 4.131 | `$1993` |

**and that `$1992` is the point of this whole exercise.** The health drain is
keyed to `$8497`, not to the pass counter, so holding UP — where a pass really
costs five frames — the same 61 player steps cost a *fourth* point of health.
The engine reaches it on its own now; `tools/headless.js` asserted `$1993`
there and that baseline was wrong.

**WHAT `W1` IS.** A per-CALL-site sum over quantities the port already
computes, each site's features taken from its own code. The large terms:

* **the four map painters.** One map cell is 4 units = 16 px and the camera
  steps 2 units = HALF A TILE, so bit 1 of each camera byte splits the
  viewport: `$9EFC` walks `(16-bx) x (10-by)`, `$9FC2` two extra ROWS only
  when `camY&2` (`$9FC5 AND 2 / RET z`), `$A08B` two extra COLUMNS only when
  `camX&2` (`$A08E AND 2 / RET z`), `$A159` four corners only when both —
  160 / 170 / 176 / 187 cells. **A cell costs 156 T empty and ~810 T drawn**,
  so what W1 tracks is the NON-EMPTY CELL COUNT UNDER EACH PAINTER, not the
  gate. The old note's 0.108 frames between RIGHT and UP is exactly this:
  holding UP the camera is clamped in the start room with 38 solid cells in
  view, holding RIGHT it scrolls into sparser corridor with 28, and ten cells
  at 810 T is 0.116 frames. It was never "strip-blitter work the port does not
  model" — the port draws the same cells and always could count them.
* **the actors**, by which of `$A1DA`'s four `RET nc` clips each leaves by
  (pure arithmetic on `(x, y, camX, camY)`), plus `$ADF8`'s probe and
  `$AEA0`'s 7x7 for the ones that reach `$ABFF`.
* **`$A31A`**, 190 T or 3,502 T strictly on `$8491` bit 0.
* **`$891C`**, the message banner: 49,799 T in situ and 52,727 T in
  beepgate's own scenario against 77 T on every other pass — 0.75 of a frame,
  and the whole of the ten edges beepgate used to lose.
* **`$B8CC`**, the beeper's noise sample: +28 T a call and +39 T more when it
  toggles, for as long as a ramp is live.

**ACCURACY, HONESTLY.** 94.7% of 2,740 driven passes over 38 scenes get the
whole-frame cost exactly right; **94.8% on the 1,620 passes of the 18 scenes
no constant was fitted on**, with the model carrying its own phase and its own
`$8497` forward from pass 0 rather than being handed the original's. The
always-guess-the-commonest baseline on the same data is 60.8%. `python
tools/clockgate.py score` re-runs it against the BUILT ARTIFACT — there is no
Python copy of the model — and reports 93.5% of 860 passes with a W1 residual
of 2,977 T = 0.043 frames.

**`python tools/clockgate.py diff`, the engine building its OWN census from its
OWN simulation, pass for pass: 280/280 exact** in the seven scenes where the
two simulations provably agree (no actors, 8 actors, 24 actors).

**A PASS IS NOT ALWAYS FOUR OR FIVE.** Over 2,740 passes the whole-frame
histogram is `{4:1023, 5:1447, 6:249, 7:21}` and six-frame passes are ordinary
at a generator cluster. `beepgate.py clock`'s `set(whole) <= {4,5}` assertion
is true of the five quiet cells it runs and false of the game.

**THE EFFECTIVE RATE — the deliverable** (`python tools/clockgate.py hz`, 120
passes a scene, both sides driven from the same state):

| scene | keys | ORIGINAL | PORT | error |
|---|---|---|---|---|
| empty playfield | idle | 4.000 f, 12.52 Hz | 4.000 f, 12.52 Hz | +0.0% |
| quiet dungeon 1 | idle | 4.133 f, 12.12 Hz | 4.025 f, 12.44 Hz | +2.7% |
| walking right | right | 4.067 f, 12.31 Hz | 4.092 f, 12.24 Hz | −0.6% |
| walking down | down | 4.692 f, 10.67 Hz | 4.775 f, 10.49 Hz | −1.7% |
| walking up | up | 5.000 f, 10.02 Hz | 5.000 f, 10.02 Hz | +0.0% |
| walking left | left | 4.516 f, 11.09 Hz | 5.000 f, 10.02 Hz | −9.7% |
| **generator cluster** | idle | 4.733 f, 10.58 Hz | 4.875 f, 10.27 Hz | −2.9% |
| **…and walking** | down | 5.591 f, **8.96 Hz** | 5.875 f, **8.52 Hz** | −4.8% |

The port used to run 12.52 Hz in every one of those rows — 4% fast in a quiet
dungeon and **43% fast at a generator cluster**, which is precisely where
manual B2b says the game is meant to bite.

**WHAT IS STILL DECLARED.**

1. **Frame interrupts lost inside the blitter's DI windows.** `$9F86/$9F92`,
   `$A00D/$A019`, `$A0C8/$A0D4`, `$A241/$A24B`, `$A292/$A29E` bracket every
   object blit with `DI`/`EI` because they blit with `LD SP,source`; the ULA
   asserts INT for 32 T with no pending latch, so an interrupt whose window
   falls inside a DI span is LOST FOR EVER. 14% of W1 boundaries overall, 49%
   holding LEFT, ~45% in p2gate's two-player scenarios. The engine charges
   every boundary its MEAN cost (1,520 T, fitted) and advances `$8497` once
   per boundary. Consequence: `left` is 9.7% slow and its drain ticks one pass
   early, and **`p2gate`'s `$8497` substitution does NOT retire** — 0 rows with
   it, 41 of 289 without, every one a one-pass skew of `$842B` bit 0 with the
   same health either side. Closing it needs a cycle-exact model of the
   blitter's inner loop, i.e. emulating the CPU rather than porting the game.
2. **The per-pass 4-vs-5 outcome is not knowable to any port once actors are
   visible.** `$ABFF` branches on the Z80 refresh register at `$AC25`/`$AC4C`;
   one updated actor moves W1 by up to 16,438 T against a margin to the
   boundary of 11,000–14,000 T. What a port can reproduce is the distribution.
3. **The AY arm is charged with the 48K branch's constants.** `$B8CC` is a
   bare `RET` there, so its W1 is ~7,000 T cheaper (measured: 75,484 T against
   83,543 T on the same pass). It happens not to change any whole-frame
   outcome in the checks, by 12,000 T of margin, but it is not modelled.

*THE PARAGRAPH THIS REPLACES, kept because refusing to ship it was right:*
"it still charges a flat four … a least-squares fit on the quantities the port
does have predicts the whole-frame cost on only 62.7% of 480 passes, so
shipping it would be fake precision." That attempt was a global fit on three
aggregates. What closed it was per-CALL-site features taken from each
routine's own code, W2 computed rather than averaged, and the phase carried in
T-STATES rather than in frames — the last of those matters most, because the
whole question turns on a 0.5% margin that rounding to frames destroys.

*ALSO WRONG ON THIS BRANCH: the 100-frame banner pause.* See Q10's pickup
paragraph below and Q17 — on a 48K the pause **is** a blocking tune, 72.07 or
209.97 frames, with interrupts off.

*CLOSED, and the answer is NO.* The 4-frame period is an **average in a quiet
scene**, and it is not safe to use as a sampler. Two independent measurements:

* frames per pass over 97 passes of ordinary play —
  `3.92:1 3.94:1 3.97:38 3.98:1 4.00:3 4.02:1 4.03:45 4.06:1 4.96:1 4.97:4
  5.03:1` — a mean of 4.0 with a tail to 5.03. The long ones are the actor
  subsystem: with `$8496 = 0` nothing in the same run exceeds 4.03.
* frames per pass against live actor count at a generator cluster: ~4.0 at 60
  actors, ~5.9 at 80–89. At the cluster's equilibrium population the game runs
  at about 8.5 Hz, not 12.52.

Individual passes cost far more: the `$2F` map sweep 5.03 frames, an inventory
pickup 104.8, a level reload 271.8.

*CORRECTION, phase 11:* this paragraph used to say the pickup "blocks inside
`$BA2B`, the sound queue". **It does not.** `$BA2B` costs 501–769 T-states
(0.011 of a frame) for all 18 effect ids and contains no wait. The stall is
`$9D2D` — fifty iterations of `PUSH BC / CALL $9432 / HALT / HALT / POP BC /
DJNZ`, i.e. 100 video frames of deliberate pause — reached from `$9D01` when
bit 2 of `$847D` is set, and that bit is armed by the MESSAGE BANNER
(`$8996`), not by the sound system. A T-state histogram of the 104.82-frame
pass puts **90.4% of it in the two HALTs** and 1.2% in the attribute filler
`$A2F8`. Sound is a passenger on a game-state pause, not its cause. The port
reproduces the pause (see `NOTES-engine.md`, *Sound*).

*SECOND CORRECTION, and it is a branch correction.* The paragraph above is
the **128K/AY** arm. `$9D0A LD A,($FFFD) / OR A / $9D0E JR nz,$9D1A` is a
RUNTIME fork on the same flag `$BF21` reads, and on a 48K it is **not**
taken: control falls to `$9D10 BIT 5 / JP nz,$B8B5 / JP $B8B0`, which LDIRs a
`$013E`-byte two-voice tune player to `$C000` and executes it with interrupts
OFF. `$9D2D`'s fifty `HALT / HALT` pairs — the 100-frame pause — **never run
on the shipped branch**. Measured on both arms from the same entry:

| | 48K / beeper | 128K / AY |
|---|---|---|
| banner (`$B8B0`) | 72.07 frames, `$8497` +0 | 99.08 frames, `$8497` +100 |
| level start (`$B8B5`) | 209.97 frames | 259.08 frames |
| in situ (an inventory pickup) | 77.0 frames | 104.8 frames |

So a port that keeps the AY pause lengths while playing the beeper runs **27
frames late at every banner**, and the `$8497` behaviour is different in kind,
not degree: the AY arm ticks the frame counter 100 times, the 48K arm 0-1,
because the tune holds the interrupt off for all of it. The engine debits the
measured 72.07 / 209.97 on the beeper branch.

**Consequence, and it has already bitten once.** `tools/sim_move.py` used to
advance the machine by four video frames per "pass"; on the 60-pass down run
that slipped by one whole pass at the 5.03-frame pickup and manufactured a
two-row differential that three investigations then tried to explain as a
missing game rule. It now steps to the main-loop top `$8503`, which is visited
exactly once per pass ({1: 97} increments of `$8491` between visits). The
engine's own clock keeps the 12.52 Hz average; only the *measuring* was wrong.
See `notes/NOTES-engine.md`, "The differential".

**Q11 — per-path pass cost.** Not needed in the same form as a free-running
game, but the overrun question above is its equivalent here. Not yet measured.

**Q12 — entity update intervals.** Not yet measured.

**Q13 — code vs data from execution coverage.** 4,346 bytes executed over 120
driven frames, in 135 runs (41 of them ≥ 25 bytes). The main loop is
`$8503–$854B`. Coverage is a lower bound and, because of Q3, is unreliable at
the patched operands. The full run list is in the tool output.

**Q14 — which way is up? SETTLED by Q7.** The map is row-major from `$8000`,
one byte per cell, 32 columns to a row: `cell = $8000 + row*32 + col`, and the
cursor routines make the direction unambiguous — `$9A3D` steps DOWN by adding
`$20` to L, `$9A18` steps UP by subtracting it, and `$9A6B` turns a pointer
into coordinates as `(L & $1F)*4` across and `((HL << 3) >> 8 & $1F)*4` down.
Both axes wrap, and the wrap is the original's own arithmetic (`$7F → $83` on
the way up, `$84 → $80` on the way down), not a modulo.

**Q15 — the render model. SCROLLING PLAYFIELD (model 3), state-then-render,
NOT a framebuffer.** Four measurements:

* **Display-file read-back: ZERO.** A read-watch over `$4000–$5AFF` during
  driven play recorded **0 reads**. So the game never consults the screen to
  decide solidity — there is real level state to extract, and phase 5 has
  something to decode.
* **Scrolling: confirmed visually.** `tools/filmstrip.py` with a movement key
  held shows the wall translating across the play area while the player stays
  put. See `build/strip_move.png`.
* Display-file writes: 153,712 over 120 frames (~1,280/frame), overwhelmingly
  from one blitter at `$9D55–$9D76`. Attribute writes: 26,025, from
  `$9DBD–$9DC6` and a row-filler at `$A2F8`.
* No raster-timed effects: the only `$FE` writes are 1 per frame.

The manual's model-3 checklist now applies: recover the camera, the scroll
mechanism, the pre-shift count and the attribute lag before any pixel gate
means anything.

**Q16 — BRIGHT, FLASH, and where colour comes from.** Measured over 26,025
attribute writes in driven play:

* **BRIGHT IS USED** — 7,010 of 26,025 writes have bit 6 set. So the palette is
  *not* uniformly `0xD7`; the renderer must honour the bright bit per cell.
* **FLASH is used, rarely** — 44 writes with bit 7 set (`$CB`). A flash cycle
  is required.
* 15 distinct values in total:
  `$00 $40 $41 $42 $43 $44 $45 $46 $47 $16 $3B $CB $77 $68 $56`.
  The `$40–$47` run is bright-on-black in all eight inks; `$00` is the black
  background that dominates.

**Q17 — sound. CLOSED, AND THE FIRST ANSWER WAS AN ARTEFACT OF THE SKIPPED
MENU.** This answer used to read "AY-3-8912, NOT the beeper", on the strength
of 92 writes each to `$FFFD`/`$BFFD` and zero changes of the speaker bit over
60 frames. Those writes are real, but the configuration that produced them is
one the harness fell into by accident.

**THE GAME SHIPS TWO COMPLETE, MUTUALLY EXCLUSIVE DRIVERS AND PICKS ONE AT
BOOT.** Block A relocates a 100-byte routine from `$CE50` to `$61A8` and runs
it (`$C238`): it writes `$D1` into `$C000` through `$7FFD`'s bank 1, pages
bank 0 back and reads the cell again. `$C23B CP $D1 / LD A,1 / JR nz / SUB A
/ $C242 LD ($FFFD),A`. Reading `$D1` back means nothing paged — a 48K — and
stores **0**; a 128K stores **1**. `$BEB9 CALL $BF21` then rewrites nine
bytes:

```
($FFFD) != 0    $B8B5 := C9   $B8CC := C9                 kill the BEEPER
($FFFD) == 0    $BADB $BA01 $BBA7 $BBBC := C9             kill the whole AY
                $BA2B := JP $B92B                          repoint the entry
```

**The harness never runs block A**, so `$FFFD` holds the loader stub's padding
byte `$2A` — non-zero — and every sound measurement in this project until
phase 11 was made on the AY branch by accident. Confirmed as a byte
differential: `build/blkC.bin` and `build/live_cs.bin` differ over the whole
`$B8B0..$BDB0` code region at exactly `$B8B5` (`21`→`C9`) and `$B8CC`
(`ED`→`C9`), which is precisely the 128K arm.

**So on a real 48K — the machine this tape is for — the AY is never written at
all and the beeper is the only output.** `$FFFD` is NOT the AY
register-select port of the same number; the port is written at `$BB9D`, the
RAM byte is read at `$BF21` and `$9D0A`.

**BOTH DRIVERS ARE NOW PORTED, AND THE SHIPPED ONE IS THE BEEPER.** The
engine carries both and selects between them with the game's own probe flag —
the same byte `$BF21` reads — so nothing is lost and nothing is hard-coded.

*Why the beeper ships:* the tape is a 48K tape, the owner's machine is a 48K,
and `$CE50` answers 0 on it. The AY driver stays in place, inert, reachable
and still gated, because it is verified work.

**THE AY PATH (`SOUND_128K`, inert).** A per-50-Hz-frame register dump exactly
as this answer predicted: `$BA2B` is a three-channel allocator, `$BADB` its
per-frame tick from the ISR at `$A2A5`, and `$73DA` holds 18 effects as
two-byte rows (volume and noise period, then a tone byte whose
`((p+1)&$FF)*4` is the period). Verified as a **register-level differential**
— `python tools/soundgate.py all`, **0 mismatching over 2,152 (frame,
register, value) comparisons** against the real Z80's own OUTs.

**THE BEEPER PATH (`SOUND_48K`, SHIPPED).** Not a different voicing of the AY
one — **a different instrument**, three mechanisms sharing one bit of one
port, and the AY's whole allocator is bypassed (`$BA2B` becomes `JP $B92B`):

* **TONE** `$B8FB`, one `(toggles, delay)` step per **MAIN-LOOP PASS** from
  its single call site `$9CD9`, inside `$9CD7 HALT / $9CD8 DI`. An effect is
  a train of *n* short chirps, one a pass, ~4% audible duty. *An AY row is
  one VIDEO FRAME; a beeper row is one PASS* — a port that copies the AY row
  timing is wrong by a factor of four. Half-period `H(E) = 17*(E or 256) + 31`
  T-states, edge count `= C`, cost `152 + C*H`, duty exactly 50%.
* **NOISE** `$B8CC`, one sample per **drawn object**, six sites in the
  blitter. `LD A,R / CP (IY+$53)` — and `(IY+$53)` IS `$84D2`, so the
  threshold and the ramp counter are one byte. 127 ramp calls to silence,
  toggle density exactly `level/128`.
* **TUNES** `$B8B0`/`$B8B5`, a `$13E`-byte two-voice interleaved player
  LDIR'd to `$C000` and executed with interrupts off. Fully blocking, and on
  this branch they **are** the banner pause (Q10).

*The dispatcher is a bare `CP` chain:* eleven ids handled (0, 2, 4, 6, 7, 8,
`$0A`, `$0B`, `$0E`, `$0F`, `$11`), **seven a bare `RET` at `$B98A`** (1, 3,
5, 9, `$0C`, `$0D`, `$10`); ids 6 and `$0F` share a stream. There is no
allocator, no channel, no age and no steal — a new trigger overwrites
`$84CF`/`$84D0` and abandons the old stream mid-flight.

**TWO DECLARED DEFECTS OF THIS PORT DISAPPEAR ON THE SHIPPED BRANCH**, and
both are Q18's class:

* `$BAB2`'s `LD A,R` **id-0 coin never executes** — `$BA2B` is `JP $B92B`, so
  the allocator body is dead. Ids 0 and 1 are deterministic here and the
  substitute coin stream is unused.
* id `$0C`, the generator spawn (`$B0D3`), is **SILENT**. The substitute RNG
  that the AY differential made audible (0 spawns on the original against 4
  in the port over 60 identical passes) has nothing to play on this branch.

**WHAT IS STILL A DECLARED SUBSTITUTE: the noise, and only the noise.** Which
`$B8CC` samples toggle is `LD A,R` against a level — Q18's class, and no port
can reproduce it. What *is* reproduced and gated: 127 ramp calls, the level
walking 1→127 (id 0) or 127→1 (id 4) with `AND $7F` and `RET z` at zero, and
a density of exactly `level/128`, enumerated on the real Z80 over all 256
values of `R`.

**Gated as an EDGE-LEVEL differential**, because the beeper has no registers
to compare: `python tools/beepgate.py all` prints one row per **speaker edge**
on both sides — `pass, source, level, offset-into-the-pass, dT` — and gets
**0 mismatching over 1,840 comparisons**. Tone is compared exactly (count,
level, every `dT`, first-edge offset); noise by count and by burst span,
never edge for edge; the tunes as a block. Round trip: `node
tools/soundwav.js beep|beepplay|beeptune` renders the shipped path to a WAV
and `python tools/soundwav.py beep|…` measures the pitches back — 8 effects
and all 28 tune rows within 5%, the tune rows exact.

Both drivers are written up in `notes/NOTES-engine.md`, *Sound*.

Two corrections this question's own brief carried:

* "only register 7 has been observed" is not a mystery — `$BADB` writes
  `R7 = $38` **unconditionally every tick**, even in silence, which is the
  whole of the 92 writes.
* `$B807`/`$B83C`/`$B852` are **not sound**. They are the packed-BCD score
  add and health subtract this project already gates as `daaAdd`/`daaSub`;
  `$A610 LD DE,$25 / JP $B807` adds 25 to the score. Of the five addresses
  the brief listed as "all in the sound region", only `$B8E9`/`$B8F2` are.

**Q18 — the random source. IDENTIFIED, and it is unreproducible.** `$B575` is
a self-modifying 16-bit shuffle whose *last* instruction is `$B586 LD A,R /
SUB L` — the Z80 **refresh register**, i.e. a count of M1 cycles. The same
source is read directly at `$AC25` and `$AC4C` inside the actor update. Every
draw in the game comes from it: the actor coins, the generator spawn roll,
which of a pack's ten sub-blocks become levels, which `$36` survives `$9B5F`,
the mirror byte `$84C7`, `$9BB7`'s extra objects, the treasure countdown and
the 4th byte of every actor record. Simulating `$B577..$B583` alone gives a
period of 101 and only 88 distinct low bytes, so a port that transcribes the
shuffle has reproduced nothing. What *is* reproducible — and what the port
reproduces — is the consumption pattern and the rules around each draw.

**Q19 — stack-imbalance scan.** 25,729 CALLs recorded; the matching-RET pass
is not yet implemented. This is the one scan that finds rules you did not know
existed, and it is outstanding.

---

## 8.20 — the decision checklist

| question | answer |
|---|---|
| Tape protected/packed? | **No** — non-standard flags only. Block copy. R3 available. |
| Ports touched? | `$FE` (kbd/border), `$FFFD`/`$BFFD` (AY), `$1F` (Kempston). Unattached → `$FF`; Kempston → `$00`. |
| Self-modifying/decrypting? | **Self-modifying: yes**, 29 operand-patch sites. No runtime decryption. |
| ROM called at runtime? | **Yes** (`$056B`, tape). Real ROM used locally. |
| Loader-left state? | None load-bearing; the game sets `SP`, `IY`, `IM` itself. |
| Clock model? | **Frame-synced, 1 pass / 4 frames (12.52 Hz)**. Dropped-frame behaviour OPEN. |
| Hot code below `$8000`? | No — game code is `$8400–$FB76`; data at `$5F00`, `$73DA`. |
| Render model? | **Scrolling playfield, state-then-render.** No display-file read-back. |
| Level format? | Packed on tape; live buffer candidate `$5F00..$6F7F`. OPEN. |
| Coordinate origins? | Not yet derived (one per draw routine). |
| Camera / pre-shift? | Not yet measured. |
| Random source? | Not yet identified. |
| Sound? | **TWO drivers, chosen at boot by a `$7FFD` paging probe** (`$BF21` on RAM `$FFFD`): 48K → beeper, 128K → **AY-3-8912**, register-dump architecture. The port plays the AY. |
| Reference disassembly? | **None.** Extra days budgeted; `IY` base offsets the loss. |
| BRIGHT / FLASH / attr owner? | **BRIGHT used, FLASH used rarely.** Attribute writers at `$9DBD`, `$A2F8`. |
| Paging / multi-load? | No paging. **Multi-load yes** (30 dungeon packs on side 2). |
| Hand-written Z80? | Yes — `IY` global base, `IX` entity blocks, stack tricks. |
| Scope of "faithful"? | **DECIDED, and it is now IN.** The loading screen, the title/character
screen, the credits and keys pages, the CONTROLS page, the character and 1/2-player choice, ALL FOUR
control methods, the 48K title tune, the ranked score table with its sort and its four-page attract
display, and the cold-boot REWIND TAPE prompt are all ported. See `NOTES-loader.md` §8.9. |

---

## Assumption → reality, so far

| assumption | reality | caught by |
|---|---|---|
| `RANDOMIZE USR 32768` | binary form is 23778 = `$5CE2`, code in a REM | detokenising the 5-byte form |
| game = the block-copy image | game **relocates itself** over 5 regions at `$BDED` | ISR vector `$DADA` decoding as garbage |
| beeper game (48K) | ~~**AY-3-8912**; zero speaker-bit changes~~ — right about the writes, wrong about the machine: the game ships BOTH and `$BF21` picks by a `$7FFD` paging probe. The harness's stale `$FFFD = $2A` had put it on the AY branch; a real 48K plays the BEEPER and never writes the AY | dynamic port inventory, then disassembling `$BF21`/`$C242`/`$CE50` and diffing the tape bytes against the live dump |
| single load | **multi-load**, 30 dungeon packs on side 2 | "START THE TAPE" text + `$9203` |
| static binary | **self-modifying**: 29 operand-patch sites | write-into-executed-region watch |
| find menu keys by watching port reads | game scans **all 8 half-rows every pass**; port reads do not discriminate | `$B4E8` |
| every measurement in this project is of "the game" | **EVERY MEASUREMENT UP TO PHASE 11 WAS TAKEN ON THE 128K/AY BRANCH BY ACCIDENT.** The harness never ran block A's menu, so RAM `$FFFD` held the loader stub's padding `$2A`, `$BF21` read it as non-zero and applied the *128K* arm — killing the beeper — on every saved state and in every gate. This is the single biggest correction the project has made: it does not change one gameplay rule, but it silently invalidated the clock, the whole of sound, the banner pause and the control-method dispatch | booting `build/image.bin` three times with `($FFFD)` = `$00`/`$01`/`$2A` and diffing `$4000..$FFFF`: `$00` vs `$01` differ at ten bytes, `$2A` vs `$01` at none but `$FFFD` itself |
| 12.52 passes/s, 4 video frames a pass | the 128K figure. 48K is **4 frames or 5**, bimodal, 4.04 (right) to 5.00 (up); "4.375" was a 16-pass window and a duty cycle, not a period | `tools/beepgate.py clock`, 200 passes a cell on both arms |
| a 48K pass is 4 frames or 5, never anything else | scene-limited. Over 2,740 passes in 38 scenes: `{4:1023, 5:1447, 6:249, 7:21}`. **Six-frame passes are ordinary at a generator cluster** — the law is `2 + ceil((p+W1)/FRAME_T)`, and 4-or-5 is only what a W1 near 1.8 frames gives | `tools/clockgate.py score`, and `beepgate.py clock`'s `set(whole) <= {4,5}` assertion is too strong as a claim about the game |
| the port cannot predict the pass cost — a fit reaches 62.7%, so shipping it would be fake precision | **the fit was the wrong shape, not the wrong idea.** Per-CALL-site features taken from each routine's own code, W2 *computed* from `$8497` rather than averaged, and the phase carried in T-STATES rather than frames: **94.8% of 1,620 held-out passes**, and 280/280 exact where the two simulations provably agree. Refusing to ship the 62.7% version was still right | `tools/clockgate.py score` / `diff`; the pre-existing gate `beepgate.py diff` went from 10 unhelped mismatching edges to **0** |
| `$8497` is the video-frame counter, so it advances 4 a pass | it counts **interrupt-handler invocations**: (boundaries inside W1) + the HALT wake + `$9CF8`'s hand call + **one more accepted inside `$B4FF`** (`$A29F` ends `EI`/`RET`). 3..6 a pass, 0.89..1.00 per video frame. Holding UP that is 5, and the health drain — keyed to `$8497` — costs the player a fourth point over 61 passes where this project's own baseline said three | hooking every write to `$8497` (`$A2A2` is the only one) and 61-pass runs on two independent steppers |
| the harness's absolute rates are the machine's | **ULA contention is not modelled** (plain `Simulator`, not `CMIOSimulator`) and it lands almost entirely in W2, which sets the phase: W2 +6,100 T, p 0.195 → 0.288. Idle dungeon 1 goes `{4:19,5:6}` → `{5:25}`, i.e. **10.0 Hz on real hardware, not 12.1**. The port inherits the harness's constants and is therefore systematically FAST by about one frame a pass in a quiet dungeon | `tools/clockgate.py contend`, SkoolKit's `CMIOSimulator`, 25 passes a scene |
| the banner pause is 100 video frames of `HALT` | the 128K arm. `$9D0A` forks on the same flag: a 48K JPs into a **blocking tune**, 72.07 or 209.97 frames, interrupts OFF, and `$9D2D` never runs. 27 frames shorter, and `$8497` advances 0-1 instead of 100 | `tools/beepgate.py pause`, both arms from the same entry |
| the port's input layer implements the game's keyboard map by design | by **accident** — the stale `$2A` fell through `$8560`/`$8589`'s dispatch to the `else` arm. A menu boot that picks method 0 (Sinclair) deadlocks every key script in this project | driving block A's front end and reading `$FFFB`/`$FFFC` |
| the substitute RNG leaks into sound (id 0's coin, the id-`$0C` spawn) | both leaks are **AY-branch only**. `$BA2B` is `JP $B92B` on a 48K, so `$BAB2`'s `LD A,R` never executes and id `$0C` is one of the seven silent ids | exhaustive search for any `CALL`/`JP` into `$BA2B..$BACF`; `tools/beepgate.py ids` |
| a noise burst is ~43 ms (or ~9, depending which write-up) | **both 9.8 ms and 85 ms are real** and the difference is WHERE IN THE PASS it was armed: the 127 ramp calls come from the blitter, so one armed by the player's own move (phase 0.098) gets the whole blit ahead of it and one armed by the actor update (phase 1.30) waits for the next pass's. The 43 ms figure came from multiplying the whole-run mean `$B8CC` spacing, which is measured on the *silent* code path | `tools/beepgate.py burst`, 16 bursts in driven play, arm phase in video frames |
| the port's control method is a design choice | **method 3, KEYBOARD, reached by accident** — `$2A` falls through `$8560`'s three `DEC A`s to the else arm. The menu's own default is **0, SINCLAIR** (`$C4F9`/`$C50B` `SUB A / LD ($C808),A` before each question), so a player who taps through the menu gets a joystick and none of this project's key scripts would work on him. All four arms are now ported | `python tools/fegate.py keymap`, 40 keys × 4 methods × 2 players |
| the port's character (index 3, the ELF) is what the loader gives you | **it is a reachable CHOICE, not the default.** `$C7FD` holds its tape value `$00` and nothing writes it before `$C426`, so SPACE-only gives **index 0, the WARRIOR**; the elf is three presses of key `5`. The index-to-character map itself is now PROVED (`$C42C LD ($FFFF),A` from the picker cursor) where it used to be "corroborated three ways and proved by none" | `python tools/fegate.py bytes`, `python tools/blockA.py chars`, and the panel rendered for all four indices |
| player 2 is the valkyrie (index 1) | **in a one-player game nobody can know.** `$C43F` is `LD A,R / AND 3 / CP C / JR nz / INC A / AND 3` — a refresh-register draw forced only to differ from player 1's. Enumerated over all 256 R: `(p1+1)&3` at 1/2, the other two at 1/4. Measured across 0..15 frames of dwell it takes all three permitted values. Manual Q18's class, and the port declares its substitute rather than asserting a constant | the dwell sweep on the real Z80 |
| the four ranked tables and the attract screen are cosmetic and can be skipped | the attract screen is the **only front end that recurs** — `$B35A → $B374 CALL $B470` runs at cold boot and after **every game over**, and a committed name entry lands there rather than in a dungeon. Skipping it invents a continue the original does not have | `python tools/fegate.py attract` |
| "the eleventh ranked entry always pushes one off" | a score is filed iff it **strictly beats slot 9**; one that beats nobody changes 0 table bytes | `python tools/fegate.py hiscore`, driving `$869F` |
| "the sound has slight noise in it" is a defect report about the sound | **one of each, and they are different things.** The roughness is the GAME: `$B8FB` steps one chirp per main-loop PASS, so the pass cost IS the chirp spacing, and the real Z80's own speaker goes from a strictly periodic 4.000-frame interval in an emptied room to `4444444444454545444444455444...` walking down a live dungeon 1 (sd 0.027 → 0.502) and 5.873 f at a generator cluster. The PITCH is `{609, 1102}` T — 2,873.6 / 1,588.0 Hz — in every scene on both machines, a 0.000% change, because the half period runs under `$9CD8`'s `DI`. Flattening the clock would move the port AWAY from the machine. The DEFECT was elsewhere: the bridge did not tile the timeline | `python tools/loadsound.py tone` and `node tools/sounddemo.js`, id 7 re-armed every time `$84CF` hits 0, port `$FE` bit 4 attributed by writer PC |
| a buffer `Math.round(nf*sr/FRAME_HZ)` samples long, scheduled at the exact `t0 + (f-base)/FRAME_HZ`, tiles the timeline | it never does: `FRAME_HZ` 50.08 makes a frame **880.591 samples**, so the length misses the slot by +0.409 (`nf`=1) or −0.364 (`nf`=4) and consecutive buffers SUM or leave a hole. Inaudible on the game path — a pass boundary is a frame boundary and `$B4FC` holds the speaker low there — and **audible on the front end**, which flushes one frame a buffer and whose tune writes no border edge: 238 of 583 joins summed, mixed peak **1.1094 against a largest single-buffer sample of 0.9977**, −7.5 dB injected. Rounding the two ENDS (with `floor`, so no edge is ever pushed back into a dispatched buffer) makes the schedule reconstruct one continuous render EXACTLY: 0 samples wrong where 3.3–7.0% were | mixing what the bridge scheduled against a single continuous render of the same edges on the same sample grid; 17 sample-level checks in `tools/headless.js`, all five of which fail on the pre-fix bridge |
| the rendered WAVs are a round trip on what the player hears | **they empty the stage** (`game.actors = []` and every `$20..$2E` cell cleared), which is exactly the scene in which the pass-cost model never fires. `beep` and `beeptune` are BYTE-IDENTICAL with the clock pinned flat and `beepplay` differs only in the single five-frame banner pass — so the renders were structurally incapable of observing the change the play report was about | pinning `quantise()` to four frames and diffing the rendered f32; `node tools/soundwav.js beeplive` now renders the same walk on the shipped stage, `{4:33, 5:31}` |
| the bridge's frame → time map only ever moves forward | `game.reset()` sets `simFrame` back to 0 (`feHandover()`, `$FF38 JP $8400`, and `setMode()`), and `if (nf <= 0) return` then swallowed every flush until the game's counter climbed past the front end's. After a 930-frame menu the first sound of play arrived **19.3 s late**, scaling one-for-one with time spent in the menu. A backward jump is not drift — the origin is gone — so it takes the first-flush path and counts a resync | transcribing the page's own `frame()` loop through a recorder stub and measuring rms/non-zero over the post-handover region: 0.034 / 10% → 0.113 / 95% |
