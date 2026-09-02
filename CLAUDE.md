# Gauntlet Online

A fork of the faithful ZX Spectrum Gauntlet JS port. Goal: a single-player
browser client plus a standalone **C++ Windows server** giving **online
multiplayer for up to 4 players**. This fork is explicitly NOT faithfulness-
bound — modernise freely; the faithful build exists precisely so this one
doesn't have to be it.

**Forked from:** `E:/Software/Gauntlet` on 2026-08-28, at 1211/1211 headless
checks. The faithful build is FROZEN — never edit anything in that folder.

## Layout

- `client/template.html` — the engine SOURCE (~10.6k lines). Never edit
  `client/gauntlet.html`; it is generated.
- `client/gauntlet.html` — the built, playable single file.
- `server/relay.cpp` — the C++ lockstep relay (one file, ws2_32 +
  iphlpapi only; speaks RFC 6455 itself, and NAT-PMP/UPnP for
  `--forward` self-port-forwarding with double-NAT/CGNAT detection —
  Anthony's own network IS double-NATted: router 192.168.50.1 behind
  an ISP box, its "external" address 192.168.1.239).  Build inside
  vcvars64:
  `cmake -S server -B server\build -G Ninja && ninja -C server\build`.
- `shared/PROTOCOL.md` + `shared/protocol.json` — the wire contract, v1.
  The JSON is the source of truth; `python tools/protocheck.py` holds
  the C++ constants block to it (33 constants, both directions).
- `tools/relaytest.js` — the relay's empirical gate (40 checks): spawns
  the exe, speaks real WebSocket at it (own client, every frame byte
  controlled), plays the full protocol conversation.
- `tools/e2etest.js` — the full stack (20 checks): two real client sims
  (vm sandboxes on the BUILT file) through the real relay; the proof
  that two browser windows play.  `tools/wsmini.js` is the shared WS
  client both tests use.
- `tools/build.py` — `python tools/build.py` regenerates the client.
- `tools/headless.js` — `node tools/headless.js`, the test suite
  (1211/1211 at fork point). Boots the BUILT file in a vm sandbox.
- `tools/uishot.js`, `tools/dungeonshot.js` — PNG screenshot tools.
- `build/` — JSON assets the build inlines + fixtures the tests read.
- `notes/NOTES-engine.md` — the 4700-line reverse-engineering log of the
  engine. The map. Search it before re-deriving anything.

## Upstream cherry-picks — DONE 2026-08-30

`notes/UPSTREAM-CHANGES.md` (see its STATUS note): the five audio
changes are IN — adaptive lead, playback latencyHint, the 4.2 kHz
speaker model, the AudioWorklet FIFO transport, the `data:` module
fallback with `info()`/`wk=` diagnostics — plus the fork-specific piece:
the hidden-tab clock (`netPump`) feeds the transport, or a hidden tab's
FIFO would drain dry mid-session.  "START means start" is adapted
everywhere (online 2026-08-31): OFFLINE the handover calls
`Game.autoJoin`; ONLINE it arms `net.autoFire` — a held FIRE in the
OUTGOING dir byte (`netLocalDir`), because every byte comes from the
relay's echo — spent the moment the seat's player is IN (a reused
seat's standing player spends it silently = reconnect resumes him).
One-shot: only the handover arms it, so game over still returns to
attract-until-FIRE, and the faithful path is untouched.
`deviceJoin` declined — `players[1].dir` is the wire's seam.  The
`faithful` git remote stays wired for future picks.

**This fork's audio is now AHEAD of upstream** (candidates for a
reverse handover, all field-verified here 2026-08-30):
- the ScriptProcessor FIFO fallback — `AudioWorklet` exists only in
  SECURE contexts, and `http://<LAN-IP>` (how second machines join a
  relay) is not one; same WORKLET_SRC state machine, main-thread;
- the queue drain (depth IS the latency; drops only samples identical
  to the last played — flat runs, never an edge), the `depth=` report
  in `info()`, and the gate decay (a frame per five clean seconds);
- `SND_LEAD_FIFO` 50 ms (FIFO recovers in one gap; the scheduler keeps
  80) with at-least-a-frame ratchet escalation;
- `latencyHint` back to 'interactive' by default (the FIFO carries the
  jitter the big buffer guarded); `?audio=stable` restores 'playback'.
Confirmed from play: crackle gone AND sfx latency at native-emulator
feel, on both the worklet (localhost) and sproc (LAN) paths.

## Planned work (agreed with Anthony, in order of intent)

1. ~~Strip local two-player from the client~~ **DONE 2026-08-29** (suite
   1211 -> 1161, every retirement deliberate): the client is one-local-
   player.  Gone: the PLAYERS/P2 options rows, the P2 key zone and the
   cross-player rebind-conflict UI, `indepGamepads`/`kempston2`,
   `CTRL_MAGIC`'s SPACE ($85A7), `controlRead`'s `who` parameter, the
   local keyboard feed of `players[1].dir`, (2026-08-31) the IN-GAME
   $B864 join invite — an out player's half of the HUD is blanked in
   play/over; the attract/rewind screens keep the classic cycling
   wordmark+PRESS FIRE halves, offline's only restart prompt — and
   (2026-09-01) the SLOWDOWN options row: redundant in the multiplayer
   build (online forces the smooth cap on every client; offline is
   FIXED at the faithful ON default).  `loadSlowdown` survives only as
   the suite's boundary hook (`G.settings.slowdown`), a legacy blob's
   `slowdown` key is ignored on load, and the heavy-scene cap gates
   still drive the flag directly.  **Deliberately KEPT:** the
   sim's two player blocks and the join/leash/shove machinery.  The engine
   has NO 1P/2P switch (NOTES: "There is no one-player/two-player switch.
   There never was.") -- both blocks ship marked not-in-game and whoever
   presses FIRE joins ($9440, the same routine that revives a dead
   player).  That join-in model IS drop-in online multiplayer, so the sim
   side is the seed of step 2, not dead weight.  `players[1].dir` is
   pinned 0 at the marked NETWORK SEAM in `readKeys()`; the abstract
   input path (`input.p2`) still drives him -- that is the tests' path
   and will be the server's.  (The faithful menu phases 'players'..'ctrl2'
   are untouched: unreachable in the shipped build, they go with the
   STREAMLINED_FRONTEND collapse, a separate pass.)
2. C++ Windows server; online sessions of up to 4 players.
   **Relay BUILT 2026-08-29** (protocheck 28/28, relaytest 24/24,
   mutation-verified: seat-order swap and advance-without-waiting each
   fail their own checks): seating, fresh boot with one shared
   buildSeed, the pure-lockstep pass loop (advances only when every
   seated READY client delivered its byte; empty seats substitute 0x00
   — the sim's own stand-still), fingerprint arbitration
   (majority, tie to lowest seat) with resync-through-snapshot, late
   join via verbatim snapshot forwarding, input/handshake/sync
   timeouts, seat reuse (= the engine's join-in model), and
   orphaned-session reset.  The PROTOCOL allows 4 seats; the server
   defaults `--seats 2` because the sim carries two player blocks —
   growing the sim to four blocks is its own later pass.
   **Client side BUILT 2026-08-29 — THE GAME IS PLAYABLE ONLINE**
   (headless 1213/1213 incl. a mock-transport section; e2e 18/18 —
   `tools/e2etest.js` runs TWO real sims in vm sandboxes through the
   real relay over real WebSocket: lobby lockstep, FIRE-join on both
   sims at once, movement, disconnect, a LATE JOIN restoring off the
   live snapshot, fingerprints equal at every barrier, zero desyncs).
   How it fits together, as agreed with Anthony:
   - **The page is the server**: the relay answers plain `GET /` with
     `client/gauntlet.html`, so the address is the page's own origin
     (`serverUrl()`); `?server=host:port` overrides; file:// = offline.
     Owner = whoever runs the exe; no seat has powers.
   - **The attract screen is the lobby**: lockstep starts at boot; the
     exchange unit is one TICK (`Game.stepTick` — one video frame in
     attract/rewind/over, one pass in play; `advance()` was refactored
     to share that body, behaviour-identical, and `stepNet()` is the
     wire's entry).  The NETWORK SEAM in `readKeys()` is closed by the
     `netDirs` arm: EVERY player's byte — the local player's included —
     comes from the relay's echo (mutation-verified: local-byte
     shortcut fails the suite).
   - **Characters are sim state**: HELLO carries the pick, CHARS locks
     the table before the first PASS (server bumps clashes — the engine
     never fields two of one character); in practice the first fresh
     boot fixes it and later joiners inherit blocks via snapshot.
   - **Names are display metadata** (2026-08-31), the localIdx rule end
     to end: the options NAME row (max 8; A-Z 0-9 space — the 4x5 micro
     tag font's charset; DELETE=Backspace rubs out) rides HELLO's
     optional trailing field, the relay sanitizes and NAMES broadcasts
     the seat table.  render() tags players only when they MEET (two+
     player sprites visible in this window — a lone sprite needs no
     label), each in his panel ink; an unset name wears the CHARACTER's
     own (class_names where it decodes — the capture's valkyrie/wizard
     entries are block-A tile codes, so those two are constants), and
     adjacent tags STACK ($9689's ring seats joiners 16 px apart, so
     centred tags collide exactly at a meeting).  Never in the sim, the
     snapshot, or fingerprint(); a SNAPSHOT joiner's name applies
     (unlike his pick); seat reuse renames; offline the handover writes
     `game.names[0]`.
   - **Death is just death** (2026-09-01): the $B3B9 three-letter
     high-score entry is RETIRED — it asked for a name the player
     already has, at the least welcome moment, and online it was a
     desync by construction ($930C read the LOCAL keyboard inside a
     lockstep tick).  Death shows RIP <name> (tagNameFor) over the
     bones ($9404's drop, the corpse marker died/diedX/diedY at the
     $93F2-snapped cell — snapshot-carried, display-only) for
     OVER_RIP_FRAMES (250), immune to input, then $B35A's own tail:
     dungeon 1, fresh block, attract.  Nothing files into the ranked
     tables — hsInsert/hsDrawPage stay ported (attract furniture, tool
     gates).  `overFrames` is fingerprinted now: it ends the hold.
   - `restore()` now repairs `feScr` (attract/rewind shadow screen) —
     found by the e2e: a mid-lobby joiner crashed the page redraw.
   - **The background-tab clock** (found by Anthony's first real test):
     a hidden tab has NO requestAnimationFrame, so the client went
     silent, the relay's 10 s input timeout dropped it and the session
     orphan-reset — the second browser then got a "totally separate
     game".  Fixed: when `document.hidden`, the PASS echo itself is the
     clock (`netPump()` — WebSocket messages still fire in hidden
     tabs).  SECOND CUT 2026-09-01: the first cut slept one tick per
     pass via setTimeout, and browsers CLAMP hidden-tab timers to ~1 s
     — a hidden participant fed one input a second and lockstep held
     the whole session to it (bench: WAITING FOR PLAYERS flashing at
     1 Hz on the VISIBLE machine; the laptop's browser sat COVERED by
     the full-screen RDP window, and Chrome marks an occluded window
     hidden).  Now a hidden tab answers AT ONCE, deferring to the
     clamped timer only when the exchange outruns the sim inside a
     trailing 1 s window — possible only with every participant hidden
     (the free-run case, measured 13,800 steps/s; it becomes 1 s bursts
     at the sim's average rate).  Tab-out also releases all keys
     (`visibilitychange`/`blur`) — a hidden tab never receives its
     keyups.
   - **Input pipelining — BUILT and RETIRED 2026-09-01**, and the
     record matters: sends ran up to 4 passes ahead of the applied
     step (then an adaptive ceiling toward 8) to absorb internet
     jitter.  Two field tests killed it.  First the pipe would not
     drain — the level-entry pause inflated it and every keypress ran
     NET_PIPE ticks late ("the character doesn't move for 0.5s");
     drain rules fixed that.  Then the ADAPTIVE CEILING ratcheted: it
     measured pass TURNAROUND, which includes the time a tag queues
     behind this client's own earlier sends — deeper pipe, longer
     turnaround, higher cap — so on the real internet
     (cookertron.plus.com) the cap pinned at 8 and input was sampled
     up to ~640 ms before it acted: "far too slow and laggy... the
     character moves after the key has been lifted".  The client is
     STOP-AND-WAIT again — one tick per round trip, one INPUT in
     flight, responsiveness chosen over smoothness — and a suite pin
     fails any reintroduced send-ahead.  Then, at Anthony's request,
     EVERY trace of the implementation was scrubbed from the source —
     the relay's per-seat queue reverted to the one-slot input, the
     protocol's pipeDepth removed, the post-mortem comments taken out
     — so THIS PARAGRAPH is the only record.  Any future revisit must
     measure LINK rtt exclusive of its own queueing, cap the sampling
     lead honestly, and re-earn the wire from scratch.  `net.info()`
     survives: inflight, rate vs sim, worst stall.
   - **Wire hardening (2026-09-01)**, the surviving keepers of an
     adversarial 18-agent design review (12 proposals, 7 killed —
     notably: input-on-change latching LOSES taps, snapshot
     compression saves nothing because the snapshot wire MEASURES
     ~7.3 KB, and send-batching shaves syscalls nobody feels; the
     PAGE, 844 KB, is the real join payload): (1) the relay serves
     `client/gauntlet.html.gz` to Accept-Encoding clients (844→307 KB
     on the owner's uplink per joiner; build.py writes the sibling
     ATOMICALLY, and serveHttp's per-request mtime guard serves
     identity for a rebuilt html until the fresh .gz lands); (2) soft
     TCP keepalive on accepted sockets (3 s idle, 1 s apart, 3 probes
     ≈ 6 s: a VANISHED host froze everyone for the full 10 s input
     timeout; wifi's 3-4 s self-healing blackouts stay safely under
     it, and a frozen app is still kernel-ACKed — the input timeout
     remains the app-death detector).  From the same review, verified
     but unbuilt: relay deadline-advance with movement-latched
     substitutes and non-blocking late-join/resync (caveats logged in
     the review).  **Later polish:** a join-time character pick (the
     dir byte has two spare bits).
   - **NETPLAN Phase 1 — MEASUREMENT, delivered 2026-09-02** (the plan
     is `NETPLAN.md`; its three rules override habit).  (E) The rAF fix:
     a visible tab applies PASS on arrival (`netDeliver`) and answers on
     a sim-clock timer (`netSendWhenDue`) — `net.acc` stays FRAME-FED,
     the timer only CREDITS unbanked real time and never writes acc, so
     nothing is double-counted; "due within a millisecond is due" kills
     a float-precision self-rescheduling storm under a virtual clock.
     (A) PING/PONG (msgs 14/15): once a second from the frame loop only,
     answered by the relay ahead of every other duty, `net.rtt`
     min/med/worst over 30 samples, `rtt=` in info().  (B) PASS carries
     a trailing WAIT byte per seat (4 ms units, protocol v2) — how long
     that seat's byte waited at the relay; `wait=` in info().  (C)
     `tools/netlag.js`: a deterministic virtual-clock delay shim (seeded
     PRNG; loss modelled as TCP shows it — a retransmit's head-of-line
     delay; no reorder knob because TCP has none) with a virtual relay,
     and THE LAG GATE in headless: FRESH boot → 12 lobby passes → latch
     join → play → a FORCED level entry → play on, at rttMs 120 and 40,
     asserting sampling lead 0 (a 4-deep pipe reads 4 — mutation-
     verified), the wire sitting out the pause (an uncharged pause
     reads 110 ms — verified), the round trip FLAT at 120 in play and
     lobby (the pre-fix frame-quantised reply reads 133 — verified),
     and sim-pace within 3% at 40.  A correction to NETPLAN 2.5: at
     RTT < pass the accumulator carries the frame surplus forward, so
     frame quantisation costs one frame of PHASE there, not throughput
     — the rAF fix's measurable win (13 ms a pass, ~10%) lives in the
     round-trip-bound regime.  (D) Node numbers on the built client, mid-level
     with 63 actors: snapshot() 0.020 ms, restore() ~0.1 ms (reset-
     dominated), stepNet 0.079 ms, wire 7,310 B — a 4-tick rollback
     window ≈ 0.3 ms per confirmation, 10-50× under the plan's
     threshold.  FOUND ON THE WAY: the attract→play join raises NO
     intro screen — the level-entry pause exists only at level
     TRANSITIONS (so pipelining's bug 1 struck at the first level
     change, not at game start); the online smooth cap is FIVE frames,
     so play's period under load is ~100 ms, not the nominal 80 — the
     gate compares wall time to CONSUMED simT.  THE REAL SESSION
     (2026-09-02, PC host via the ISP hairpin + Sheffield): far seat
     `rtt=23/28/95` — a 28 ms median round trip, the plan's §3.1
     regime (r < 60: play needs nothing more; only the 20 ms lobby
     modes are worth a targeted fix) — but `rate=7.8 sim=12.5
     worst=1190ms wait=76/1020ms`: the session stalled a second at a
     time and the WAIT bytes named the culprit — seat 1 (Sheffield) sat
     at the relay over a second waiting for seat 0, the HOST, whose own
     link reads `rtt=4/6/35`.  A host-side stall, not the wire: the
     hidden-tab pump's free-run guard allowed round(1/tick) = 13
     answers per window against a 12.5/s pace — no headroom — so an
     occluded host browser tripped it on ordinary jitter, and the
     guard's own one-second hold built the backlog burst that re-
     tripped it (a self-sustaining ~1 s stall every couple of seconds
     = the 62% rate).  FIXED: the budget is three times the sim rate
     (free-run is hundreds to thousands a second, still caught inside
     one window); `hidden=` and `held=` (guard deferrals) ride
     net.info() so the next paste says so itself; a forty-echo
     jittered at-rate regression pins it.  Per the plan, §3 is NOT
     pre-empted: no transport redesign is authorised; the reading is
     §3.1, awaiting Anthony's decision.
4. **NEXT SESSION — FOUR PLAYERS (agreed with Anthony 2026-09-01).**
   Grow the sim to four player blocks and redesign the in-game HUD to
   fit four panels ("remove or shrink the player information", his
   words).  The survey, done ahead:
   - **Already four-ready, untouched:** the protocol (maxSeats 4; PASS
     carries seats×dir; CHARS and NAMES are 4-wide tables), the relay
     (`--seats` just moves to 4 once the sim can), the character bump
     rule (4 seats × 4 characters = every session fields each at most
     once), the join-in model itself ($9440 has no player count), the
     name tags (stacking already handles n), the per-player vcams and
     every any-window rule, fingerprint/snapshot (loops over players).
     The client's `net.seats > 2` WELCOME guard is the one latch to
     lift.
   - **The sim's two-player assumption sites** (grepped, ~a dozen):
     `other(p)` = `idx^1` and its callers ($96B4 join ring, $AAC4
     shove, the leash — pairwise-over-all or nearest instead), the
     $B076 player-2-only arm at 7705ish, $94C3's level max (max over
     all), $B6DA's drain (all), `potionBy & 1` / `bannerBy & 1` /
     `localIdx & 1` masks (→ & 3), reset()'s block2 build (blocks 3/4
     are synthesized clones with their own character), the abstract
     input path (`input.p2` → p2..p4 or an array), $8503's both-dead
     test (all-dead).  Blocks 3/4 have NO Z80 reference — the original
     never had them — so the gates are SYMMETRY and DEGENERACY, not
     faithfulness: with ≤2 players in game the four-block sim must
     digest-match today's two-block sim pass for pass (the vcam proof
     pattern), and the extra blocks must be provably inert while out.
   - **The HUD:** four panels of EIGHT columns (4×8 = 32, the arcade's
     own four-column layout — and the 8-character name cap already
     fits an 8-column panel exactly).  Per quarter: NAME row, score
     (7 digits fits), health, a compressed keys/potions/icons row.
     IN PLAY only — the attract/rewind screens keep the classic
     captured two halves (wordmark + PRESS FIRE), and an out player's
     quarter stays blank (the retired-invite rule).  drawPanel/drawHud
     and the counter round-robin ($B717) rewrite around it; the RIP
     tags and meeting tags need nothing.
   - e2e grows a 3rd/4th client scenario; relaytest a --seats 4 run.
5. **QUEUED — SPEECH BUBBLES (Anthony, 2026-09-01).**  Chat messages
   drawn as a speech bubble from the player's sprite, in the game's
   own graphical style.  His spec, verbatim where it matters: max 32
   characters; ENTER opens the text box in game; ESC closes it, ENTER
   again sends.  Design notes from the survey:
   - Display metadata end to end, the NAMES pattern exactly: a new
     MSG_CHAT (13 is NAMES, so 14) client->server with the text, the
     relay sanitizes (the tag font's charset: upper A-Z 0-9 space —
     the micro font has no other glyphs) and broadcasts it stamped
     with the SEAT.  Never in the sim, the snapshot, or fingerprint().
     A light rate limit relay-side (spam guard).  protocheck +1.
   - The bubble rides the TAG PASS machinery (position over the
     sprite, stacking, playfield clipping): Spectrum-styled box (1 px
     border, paper behind micro-font text, a small tail to the
     sprite), 32 chars wrapped as two 16-char lines (16x5 = 79 px;
     one 160 px line would span most of the window), shown ~4-5 s,
     newest replaces.  The MEETING gate does NOT apply — a bubble is
     deliberate speech — but it clips like a tag: a viewer whose
     window doesn't hold the speaker misses it (v1; acceptable).
   - ENTER is FREE in play (only the options screen reads it) and ESC
     is unmapped (KEYMAP grows Escape).  While composing, the keydown
     handler feeds a compose buffer directly (real typing, not the
     rebind's release-gated capture) and `netLocalDir()` returns 0 —
     the player stands, which is just a byte on the wire, sim-safe.
     Compose UI candidate: the bubble itself, live over your own head
     as you type.  ONLINE-only (offline has nobody to talk to).
3. Netcode design — **SETTLED with Anthony 2026-08-29:**
   - **LOCKSTEP RELAY.**  Every client runs the JS sim it already has; the
     C++ server relays one direction byte per player per pass, owns the
     session (who is in, when a join byte fires), and arbitrates desyncs
     via the engine's own `fingerprint()` (players, camera, actors, tape
     counters are all mixed in).  The server never runs the sim — that is
     what keeps it a small standalone C++ program.  Late join = state
     snapshot transfer — **serializer BUILT 2026-08-29** (suite 1181 ->
     1195): `game.snapshot()` -> versioned JSON wire -> `restore()` into
     a reset machine.  One manifest (SNAP_GAME/SNAP_PLAYER) walked by
     both directions.  Proven: fingerprint equal at handover and over
     150/120/60-pass replays (offline busy, online two-window with a
     shot in flight, mid-materialise); tamper diverges; wrong version
     refused; localIdx never crosses the wire (the receiver's display
     choice survives restore).  The noise stream (sound.rng + live
     burst) IS carried — it is clock state (cost -> passTicks -> $8497
     -> drain) — and asserted directly at handover, because a mutation
     run proved 150-pass replays can miss a dropped carry.  Snapshots
     are taken BETWEEN passes only; the tone voice deliberately restarts
     silent (its cost is constant, its table is a reference).
   - **PER-CLIENT CAMERA — BUILT 2026-08-29** (suite 1161 -> 1181, all
     green): the sim carries one virtual camera per player behind a
     `cfg.online` flag (`vcamPass()` beside `camera()`), every
     camera-read rule generalized — actor gate any-window, generator
     cull nearest, shots owner-window, monster shots any-window, sweep
     union deduped, pad census union deduped — plus leash off, slowdown
     cap forced, `localIdx` display-only (mutation-verified it never
     reaches `fingerprint()`).  Proven by DEGENERACY: 260 passes of
     dungeon 1 + 120 of dungeon 2, online(1P) === offline by per-pass
     state digest.  Found on the way: the sound bridges' substitute
     `LD A,R` streams (`sound.rng`) survived `game.reset()`, and noise
     toggles are charged to the pass cost -> passTicks -> $8497 -> the
     DRAIN, so a second seeded run in one process drifted its drain
     clock by pass 128.  reset() now reseeds them (`rngSeed`); lockstep
     REQUIRES that every client boots this stream from the constant.
     The original design note, kept for the record: the
     camera is SIM STATE, not a lens.  camX/camY are in `fingerprint()`,
     and they gate real rules — actors off-camera are FROZEN ($A1DA's
     culls gate the update callback; "nothing in the first dungeon stirs
     until the camera brings it into view"), the generator cull recycles
     actors by distance from the camera centre ($B0FE), and shots are
     REMOVED at the screen edge ($8D97/$8DA1): shot range IS the screen.
     So per-client display requires generalizing those camera-relative
     rules to PLAYER-relative ones, all deterministic and lockstep-safe:
     one VIRTUAL camera per in-game player, each computed with the
     original follow logic ($A437/camStep); an actor updates when visible
     to ANY of them; the generator cull measures to the nearest; a shot
     culls against its OWNER's window; each client displays its own
     player's window.  With one player in game this degenerates to
     exactly the tested sim, so the whole change is provable against the
     current suite.  The leash stays off online; load-slowdown is forced
     OFF in online sessions (its pass-cost model reads a camera).

## Engine facts that cost real effort to learn — don't rediscover them

- A player's input is one clean per-pass direction byte (bits: up/down/
  left/right/fire/potion) -- the natural network-serialization unit.  The
  LOCAL player's byte comes from `controlRead(method, kb)`; a remote
  player's arrives over the wire and lands in `players[n].dir` (see the
  NETWORK SEAM comment in `readKeys()`).  A remote player's first FIRE
  bit joins him mid-game through `joinPass()` -- no session plumbing
  needed in the sim itself.
- Faithful/added boundary flags exist throughout: `STREAMLINED_FRONTEND`,
  `FAITHFUL_TAPE_PROMPTS`, `FAITHFUL_SYM_CHEAT`, `zonePotion`. In this fork
  they can be collapsed toward the modern side — but strip incrementally
  and keep `headless.js` green at every step.
- The HUD font has verified glyphs ONLY for digits, uppercase letters and
  space. Punctuation renders garbage. Reword UI text; never print `:` `/`
  `>` etc. with it.
- Key rebinding: 6 slots, swap-on-own-key, nothing ever refused (the
  cross-player conflict UI left with local P2).  The zone persists in
  localStorage; legacy two-zone saves migrate by taking player 1's own.
- House discipline (keep it): mutation-test every fix — reintroduce the
  bug, watch the specific test fail, restore; and verify empirically over
  reading code ("measure, don't assume").
- Comments in template.html cite original Z80 addresses ($XXXX). Keep that
  convention for engine code; it is how the code stays reviewable against
  `notes/NOTES-engine.md`.

## C++ toolchain (verified working 2026-08-28)

Visual Studio 18 (Community) is installed. Enter the x64 build environment
with:

```
"E:\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
```

Verified end to end (compiled, linked ws2_32.lib, ran, WSAStartup OK):

- MSVC `cl` 19.50.35726 for x64 (`/std:c++20` works; toolset v145)
- CMake 4.2.3 and Ninja, both VS-bundled and on PATH once vcvars64 is
  loaded — no separate installs needed.
- Quirk: vcvars64.bat prints a harmless `'vswhere.exe' is not recognized`
  warning; the environment still initialises correctly. Ignore it.
- From Git Bash the quoting mangles; invoke the toolchain via the
  PowerShell tool with `cmd /c` and backtick-escaped quotes, or from a
  plain cmd shell.

## Workflow

- git repo (branch `main`); first commit is the pristine fork point —
  diff against it to see everything the fork has changed.
- `gh` is authenticated as `cookertron`; repo-local `user.name` is set.
  No GitHub remote yet — create with
  `gh repo create gauntlet-online --private --source . --push` when wanted.
