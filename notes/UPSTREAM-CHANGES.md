# Upstream changes since the fork point — for cherry-picking

The faithful port (`E:/Software/Gauntlet`, GitHub `cookertron/Gauntlet-JS`)
kept moving after this fork was cut (fork point `9c66f25`, 2026-08-28,
1211/1211 checks).  Its suite now stands at **1268/1268**, and every change
below was mutation-tested there.  This file is the handover: what changed,
where it lives (symbol anchors, since `web/` there is `client/` here and
the trees have diverged), which upstream commit carries it, and an honest
read on how each lands in THIS fork's world (lockstep relay, per-player
cameras, stripped local 2P, attract-as-lobby).

Priority order for this fork: **the audio stack first** — it is untouched
pre-fork vintage here, it ports nearly clean (self-contained regions), and
four players' worth of online sound will ride on it.

| # | Change | Upstream commit | Applies here? |
|---|--------|-----------------|---------------|
| 1 | Adaptive audio lead (underrun ratchet) | `cc6e122` | Yes, clean |
| 2 | `latencyHint: 'playback'` | `0e5ff6c` | Yes, one line |
| 3 | Speaker model (4.2 kHz biquad) | `6f0f148` | Yes, clean |
| 4 | AudioWorklet FIFO transport | `daeb59f` | Yes — the big one |
| 5 | `data:` worklet fallback + `wk=` diagnostics | `83a6e98` | Yes (file:// offline play is supported here) |
| 6 | START means start (`autoJoin`) | `f23d538` | Adapt — lobby design decision |
| 7 | deviceJoin (device-claimed P2 drop-in) | `f23d538` | Mostly N/A — pattern worth knowing |

## The audio stack (items 1–5)

The origin story, compressed: an Acer Nitro 5 played the game with choppy,
crackly sound.  Five debugging rounds later the decisive facts were: (a) a
native Spectrum emulator on the same machine played the same game clean —
acquitting the machine and indicting the TRANSPORT; (b) the crackle lived
only in the title tune, the one place the scheduler cuts a tiny buffer
every video frame (50 joins/s; pass-sized in-game buffers were clean); and
(c) the worklet fix shipped to address that had silently failed to engage,
which one pasted `info()` line finally revealed (`mode=sched`).  Full
narrative: the faithful repo's `PORTING-JOURNEY.md`, sound section.

### 1. Adaptive schedule lead — `cc6e122`

The bridge's fixed `SND_LEAD = 0.08` head start was the entire jitter
budget; a main-thread stall longer than that tore the schedule (one gap
for the stall + one more lead of silence from the resync).  Now:

- `SND_LEAD_MAX = 0.24`; `SoundOut` gains `this.lead` (starts at
  `SND_LEAD`, never decays) and `this.underruns` (genuine tears only —
  `resyncs` also counts benign game-reset re-origins).
- `ratchet(now, when)` — called ONLY on the `when < now + 0.005` branch of
  both scheduled flush paths (`flushBeeper`, `flushAy`), never on the
  `upto < this.next` restart branch: `lead = min(MAX, max(lead,
  (now - when) + SND_LEAD))` — the measured deficit plus the base margin.
- Every `now + SND_LEAD` in the flush paths becomes `now + this.lead`.

Tests to replicate: origin-at-default-lead, healthy-flush-never-ratchets,
underrun-ratchets-by-measured-deficit, huge-stall-caps, restart-does-NOT-
ratchet.  Driven with a mock ctx whose `currentTime` the test owns.

### 2. Stability buffer — `0e5ff6c`

`new AudioContext()` defaults to `latencyHint: 'interactive'` — the
smallest hardware buffer the OS can serve, maximally glitch-prone under
DPC spikes.  `try { new C({ latencyHint: 'playback' }) } catch { new C() }`.
Costs ~100 ms output latency, which sits below the game's own 80–100 ms
pass-quantised sound granularity.

### 3. The speaker model — `6f0f148`

A fidelity argument, not just a comfort one: the chip reproduced bit 4 of
`$FE` exactly — a mathematically perfect square — and nobody in 1986 ever
heard that; the real machine's ~4 cm cone rolled off the top octaves, the
game's own chirps reach 7.4 kHz, and small modern drivers buzz on raw
edges.  (It was NOT the Nitro's crackle — that was the transport — but it
stays on its own merits.)

- `let SPEAKER_FILTER = true;` above `BeeperChip`; exported as a
  live-toggleable `speakerFilter` get/set (`__GAUNTLET__.speakerFilter`).
- In the `BeeperChip` constructor: RBJ low-pass biquad, fc 4200 Hz,
  Q 0.7071, transposed direct form II (`fb0/fb1/fb2/fa1/fa2`, state
  `z1/z2`).  In `render()`, after the DC blocker: compute the filtered
  sample ALWAYS (state stays warm so a live toggle never thumps), output
  filtered or raw per the flag.  The `dc === false` exactness path bypasses
  it entirely — every edge-stream gate sits upstream, untouched.
- Test consequences: chip-measurement tests that assert on RENDERED values
  (the 1,588 Hz at-unity DC-blocker bound especially) must run with the
  filter OFF — wrap them in `speakerFilter.set(false) … set(true)`.  New
  tests: 8 kHz square shaded below 0.5× raw RMS; 500 Hz passes > 0.85×;
  split-render === whole-render EXACTLY (state continuity across calls —
  this is the anti-click property, and upstream the bridge's own
  continuous-reconstruction test catches its violation independently).

### 4. The worklet transport — `daeb59f` (THE cherry-pick)

The scheduled path pushes dozens of tiny one-shot AudioBufferSourceNodes
per second and hands every join to the browser.  Sample-exact in context
time — and one real machine crackled on the joins anyway, while playing an
emulator's continuous stream clean.  So the transport is now the
emulator's: ONE AudioWorkletNode pulling from a FIFO.

- `WORKLET_SRC` — the processor source as a template-literal string
  (deliberately: it gets loaded as a module from a generated URL, and the
  suite `eval`s the same string with stubbed `registerProcessor` /
  `AudioWorkletProcessor` to unit-test the state machine).  The processor:
  chunk FIFO + `depth`; a `min` refill gate; a `started` flag (boot
  silence is NOT an underrun); underrun episodes emit zeros and REFUSE to
  resume until `depth >= min` — recovery and lead-rebuild inside one gap —
  then report `{underrun: episodeLength}` once.
- `SoundOut` gains `mode` ('sched' | 'worklet'), `initPending`, `node`,
  `vbase`/`vsent` (the virtual stream clock).  `flush()` waits on
  `initPending`, dispatches on `mode`.
- `flushWorklet(events, upto)` — the same absolute whole-sample tiling as
  `flushBeeper` (floor at the ends, cut-by-the-window trim, unrendered-
  edge level backstop) but against the stream clock: chunk length =
  `floor((upto - vbase)/FRAME_HZ*sr) - vsent`.  A sim-clock restart just
  re-origins `vbase/vsent` — no gap at all, the stream never stops.  No
  live[] cap, no resync arithmetic; bursts (the 104-frame banner) deepen
  the queue and drain.
- `ratchetSamples(n)` — the worklet-side twin of `ratchet()`: fed by the
  underrun reports, ratchets `lead`, posts the worklet its new
  `{min: floor(lead*sr)}`.
- The scheduled path stays whole: it is the fallback for no-worklet
  browsers AND the AY/128K mode (declared).
- Key proof to replicate: the FIFO chunk CONCATENATION is sample-for-
  sample identical to a one-shot render of the same edges (< 1e-7).

### 5. `data:` module fallback + never-silent diagnostics — `83a6e98`

MEASURED in headless Chrome (`--headless=new --virtual-time-budget
--dump-dom` on a probe page): `audioWorklet.addModule(blobUrl)` FAILS on a
`file://` page with `AbortError: Unable to load a worklet's module`, while
`'data:application/javascript;base64,' + btoa(WORKLET_SRC)` loads,
constructs and messages.  This fork's README says opening the page from
disk plays offline — so it needs this fallback too, even though the relay
serves over HTTP (where blob works).

- `start()` init chain: try blob, on failure try data:, record every
  failure into `this.workletErr` ('blob:AbortError data:…').  The chain
  uses ONLY `addModule(url).then(onOk, onErr)` — no interior Promises — so
  tests drive it synchronously with a thenable mock.
- `info()` — one console-pasteable line of the whole audio state:
  mode, sr, lead, underruns, resyncs, dropped, baseLatency, outputLatency,
  and `wk=` (on / the recorded failure / off).  The lesson that earned it:
  the worklet's first silent fallback cost an entire remote-debugging
  round trip.  On a machine you cannot touch, shipped diagnostics ARE the
  debugger.
- Fork-specific check after porting: this fork changed the hidden-tab
  clock — verify background-tab audio with the worklet engaged (the FIFO
  keeps draining on the audio thread regardless of rAF throttling; the
  feeding side must keep flushing on whatever clock the hidden-tab path
  uses).

## The join-flow changes (items 6–7)

### 6. START means start — `f23d538`

Upstream, pressing START GAME on the options screen dumped the player on
the ranked table's PRESS FIRE — a decision they had already made.  Now
`optFinish()` records `playersOut = players`, and `feHandover()` calls
`Game.autoJoin(n)`: for each configured player, satisfy the `$944C` FIRE
gate (`q.dir = DIR_FIRE`, restore after) and call the REAL `joinOne()` —
placement via `$9689`, stat reset, armour row, everything.  The first
attractTick's own `$B47E` arm then carries them into dungeon 1 before the
table ever draws.  The faithful front end sets no `playersOut` and keeps
attract-until-FIRE, as does the post-game-over replay prompt (a decision
NOT yet made).

For this fork: a genuine design decision, not a mechanical port.  The
attract screen here is the LOBBY, and FIRE-as-join is the drop-in shape
online play wants — upstream's change may apply only to the OFFLINE/local
start (auto-join the one local player), while the online path keeps the
lobby.  `playersOut` here is always 1 (local 2P is stripped).  The
mechanism worth stealing regardless: join by faking the FIRE gate through
the real join, never by poking state bits.

### 7. deviceJoin — `f23d538`

Upstream, an out-of-game LOCAL player 2 is now claimed by whichever device
presses FIRE: a claim block in `readKeys()`, one line before P2's dir
read, reassigns `method2` (and `indepGamepads`) so the SAME pass's
untouched join brings him in.  The pad that can claim him is the one P1 is
NOT using (pad 0 shared when P1 is on keyboard; pad 1 independent when P1
holds pad 0 — so P1's own fire can never conscript P2), and the keyboard
zone's fire claims him back the other way.  Flag `deviceJoin`, faithful-
false, on the same handover wire as `zonePotion`.

For this fork: mostly NOT applicable as-is — local P2 is stripped and
`players[1].dir` is the network seam; do not let a local pad claim a wire
seat.  The transferable idea is the pattern: an unjoined SEAT claimed by
the input device that presses FIRE, with device-ownership rules making
misfires impossible.  If the local player here ever gets keyboard/pad
flexibility, this is the shape.

## How to lift the code

The faithful repo can be added as a remote and diffed with a path rewrite
(`web/` → `client/`):

```
git remote add faithful https://github.com/cookertron/Gauntlet-JS.git
git fetch faithful
git diff <hash>^ <hash> -- web/template.html tools/headless.js
```

Expect the audio hunks (BeeperChip / SoundOut / the SND_ constants block)
to apply nearly clean — they are self-contained and this fork has not
touched them.  Expect the frontend/join hunks to CONFLICT — the frontend
here is heavily diverged — which is why the symbol-level descriptions
above, not the diffs, are the authoritative guide.  House rules apply as
ever: port a change, run the suite, mutation-test the behaviour (upstream's
mutation list per change is in the commit messages), and keep
`node tools/headless.js` green at every step.
