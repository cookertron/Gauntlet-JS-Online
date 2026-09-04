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
- `shared/PROTOCOL.md` + `shared/protocol.json` — the wire contract, v3.
  The JSON is the source of truth; `python tools/protocheck.py` holds
  the C++ constants block to it (36 constants, both directions).
- `tools/relaytest.js` — the relay's empirical gate (54 checks): spawns
  the exe, speaks real WebSocket at it (own client, every frame byte
  controlled), plays the full protocol conversation, then a four-seat
  run.
- `tools/e2etest.js` — the full stack (32 checks): real client sims
  (vm sandboxes on the BUILT file) through the real relay — two, a late
  joiner, then a fourth and a fifth: FOUR PLAYERS in one game, a sixth
  refused; the proof that browser windows play.  `tools/wsmini.js` is
  the shared WS client both tests use.
- `tools/fourblock.js` + `build/_fourblock_ref.json` — the four-block
  DEGENERACY fixture (see planned work 4): scenarios + per-pass digest,
  the reference recorded on the two-block build.
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
   still drive the flag directly.  And (2026-09-03) THE HURRY-UP:
   $971B's idle-party eviction (doors at 23 drain ticks, every wall an
   exit at 140) is OFF by default behind `FAITHFUL_HURRY_UP`, the
   fourth faithful/added boundary flag (Anthony: "a bit chesty for the
   online multiplayer version") — the counter still runs, the stages
   never fire, the Z80-measured checks flip the flag on around
   themselves (`G.hurryUp`).  **Deliberately KEPT:** the
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
   orphaned-session reset.  The PROTOCOL allows 4 seats and (since
   2026-09-02, planned work 4) the server defaults `--seats 4`.
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
     keyups.  THIRD CUT 2026-09-03 (Anthony: "leave the tab and come
     back: the game is locked up, WAITING FOR PLAYERS flashes though
     I'm the only player, the audio lags by seconds — 60 s").  MEASURED
     under the virtual clock (tools/netlag's shim with Chrome's one-
     second timer clamp modelled): hidden 30 s the second cut ran 66 s
     of sim (2.2×, in three-times-rate bursts — nobody visible was
     pacing the wire, so the RATE budget was the pace), the speaker got
     two extra seconds of sound per hidden second and the FIFO's
     flat-run drain can never shed live sound; on return the first
     INPUT went 5.08 s late (netApply had debited the accumulator to
     its −5 s floor with nothing crediting it) — the frozen game — and
     WAITING tripped at that instant off a lastProgress five seconds
     stale; the sim stayed 31 s ahead of the wall clock for good.  Now
     the hidden clock paces on the LEAD: an origin (wall ms, sim s)
     taken the moment the tab hides, and an echo is answered only while
     the sim is not ahead of real time by more than a bound — a session
     paced by a visible player never leads, so a hidden participant
     still adds zero delay (the Sheffield rule, re-modelled with zero-
     mean jitter and a pacer's 0.25 s catch-up burst, both pinned);
     only the every-tab-hidden free-run holds.  Two bounds: a tenth of
     a second when THE SPEAKER TICKS (the worklet/sproc processor posts
     a tick every 2048 samples off the audio thread, which a hidden tab
     keeps running: SoundOut.tick → netTick → netPump), half a second
     under the clamped timer alone (headroom over a pacer's burst — a
     one-second hold on it would rebuild the Sheffield oscillation).
     Unhiding (netUnhide) re-origins the accumulator to the lead,
     refreshes lastProgress, and posts the FIFO a catchUp that drops
     the OLDEST samples to the refill gate — one skip, then the
     present.  `lead=` and `tick=` ride net.info().  Pinned end to end
     under the shim: hidden 30 s → 30 s of sim (±1.2), lead ≤ 0.75 s
     on the timer / ≤ 0.25 s ticking, first INPUT back ≤ 0.7 s /
     ≤ 0.25 s, WAITING never.  (tools/fourblock's loader exposes its
     sandbox as `G.__sandbox` for probes that need a clock.)
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
     jittered at-rate regression pins it.  (SUPERSEDED 2026-09-03: the
     rate budget over-ran a session nobody visible was pacing — see the
     background-tab clock's THIRD CUT above, which paces on the LEAD;
     the forty-echo regression survives, re-modelled with zero-mean
     jitter.)  THE JAPAN SESSION (2026-09-03, Anthony + Eve, Eve
     over wifi in Japan; for the record): far seat `rate=3.4 sim=12.5
     worst=692ms rtt=270/273/9122 wait=/280ms held=0 tick=1` — a 273 ms
     median round trip, so pure stop-and-wait lockstep ran ONE pass per
     round trip: 3.4 passes a second, 27% speed, for BOTH players (the
     host's own line, `rate=10.0 held=60`, was captured at a different
     step and says only that his tab was hidden for a while); the 9.1 s
     worst RTT is a wifi blackout that came within a second of the
     relay's input timeout.  This is the plan's §3.3 regime (r > 150
     ms): §3.2's deadline-advance would cost the far seat three or four
     steps of overshoot (the pipelining verdict again), and only
     rollback plays at full rate over that link — Task D priced it
     affordable, the audio choice in §3.3 is still open, and it is a
     seam rewrite to scope on its own.  Recorded, not acted on.  Per
     the plan, §3 is NOT pre-empted: no transport redesign is
     authorised; the readings are §3.1 (Sheffield) and §3.3 (Japan).
     DECIDED 2026-09-03 (Anthony): §3.3 rollback — the only full-rate
     answer to a Japan-class link — is PARKED: ON HOLD, SUBJECT TO
     REQUIREMENT, recorded in NETPLAN.md's status.  **§3.1 BUILT
     2026-09-03** (Anthony authorised it after asking, rightly, whether
     it was pipelining again — it is not: nothing is sent ahead, one
     byte in flight, sampling lead zero): in attract/over/rewind ONE
     exchange is FOUR video frames (`Game.NET_LOBBY_FRAMES`,
     `wireFrames()`/`wireSeconds()`; `stepNet` steps the group with the
     same byte to each frame and ENDS it the moment the mode becomes
     play, so a lobby byte never runs a pass), and the net layer paces
     sends and reports `sim=` on the wire tick; the sim's own tick and
     the offline clock are untouched.  The wire's cadence is 80 ms in
     every mode, so the lobby and the RIP hold are as latency-tolerant
     as play (250 frames = 63 exchanges).  Pinned: the two ticks, the
     send clock, four frames a PASS, a join ending its group at one
     frame and zero passes, the 63-exchange hold (headless 1472, e2e
     32 — the e2e now lets A's lobby exchange before B connects, since
     a B inside the first 80 ms tick is a FRESH joiner whose pick
     applies, and asserts the four seats' BYTES rather than a walk the
     join ring's geometry can box in).
4. **FOUR PLAYERS — BUILT 2026-09-02** (agreed 2026-09-01; headless
   1330 → 1399, relaytest 40 → 50 with a four-seat run, e2e 20 → 30
   with a fourth and fifth client and a sixth refused; the relay
   DEFAULTS to `--seats 4`, protocol `defaultSeats` 4, protocheck 33).
   The sim carries FOUR player blocks; the in-game HUD is four QUARTERS.
   - **The gate is DEGENERACY, not faithfulness** (blocks 3/4 have no
     Z80 reference): `tools/fourblock.js` holds seven scenarios (solo
     and duo, offline and online, dungeon 2, a shove scene, a double
     death through the RIP hold into the next attract) and a per-pass
     state digest over players 0-1 plus the shared state;
     `build/_fourblock_ref.json` was RECORDED ON THE TWO-BLOCK BUILD
     (`node tools/fourblock.js old.html out.json`, old.html from `git
     show 51c19a0:client/gauntlet.html`) and headless replays every
     scenario on the current build in a PRISTINE sandbox
     (`FB.loadClient`), hash for hash.  FOUND ON THE WAY: the suite's
     shared `G` carries module state — dungeon 2 diverged at pass 52
     inside the suite and nowhere else — so replays never run on it.
     INERTNESS (blocks 3/4 unchanged over 260 shove-heavy passes, the
     upper ring $FF) and SYMMETRY (each generalized rule driven with a
     block 3/4) sit beside it.
   - **The generalizations**, each keeping the original's structure:
     `other(p)` stays the classic partner (2 for 1, 4 for 3) and
     `others(p)` is everyone else; $96B4's placement anchor = partner
     first, then the rest, first non-(0,0) cell; the leash and $AAC4's
     box = any other; $A38A's walk: BLOCK 1's contact bit alone reverses
     the order ([p4..p1]), the reversed walk shoves unconditionally
     ($A3BE and $A3CF's bug), the forward walk only from a set bit, bits
     read once at the top; $ADC7's chase = "the other blocks in the
     game", nearest, ties to the lower block, quirks kept (a corpse whose
     partner is out is still aimed at); $B060's coin = where the walk
     STARTS (even: block 1, odd: block 2), a dead block ends it, a
     flashing one falls through; the $5B90 ring is 32 slots (blocks 3/4
     at +$40/+$60) and $8FC5 drains the same two slots of BOTH halves;
     $B717's robin serves blocks i and i+2 on one pass; $94AE/$B3AB
     "both" = every, $94C3 max over all; the module camera (offline)
     follows the first two live blocks; `potionBy`/`bannerBy`/`localIdx`
     masks & 3; readKeys' abstract path takes p2..p4; `Game.charTable`
     fills blocks 3/4 with the lowest unused characters (four seats by
     four characters = one each; netBoot derives the same four from the
     CHARS table); the snapshot wire is v2; `net.seats > 2` is `> 4`.
   - **Found and FIXED on the way** (each pinned; each a two-block bug
     too): (1) a DEAD player could never rejoin while others played, and
     after a game over neither could block 2 — the retired name entry
     ($92A6) had been what cleared $93E2's mark; joinOne now spends the
     mark (and $AB24's shove bit, which $A48D clears only for the
     living) on the first poll after death: cleared, $948C's strip, the
     RIP kept until FIRE brings him back through $9440.  (2) levelOver
     read PLAYER 1's dead flag for $B3AB's all-dead test, so a dead
     player 1 whose partner walked out went to the game-over chain
     instead of the next dungeon; it reads levelEnd's `gameOver` now.
     (3) `autoJoin(n)` masked n & 3, so 4 joined nobody.
   - **The HUD in play is four quarters of 64×32 px in the MICRO FONT**
     (drawQuarter; the arcade's own four-column layout).  A first cut
     used the HUD's 8x8 font at eight columns a quarter and Anthony
     called it "far too cramped"; the quarters now wear the 4x5 tag
     font (twelve characters a line, 6 px a line): the NAME
     (tagNameFor, the character's ink with $9788's low-health flash),
     `SCORE 123456` (packed BCD printed as hex = $B6AE's suppression for
     free), `HEALTH 2000`, then a KEY icon + count and a POTION icon +
     count (TAG_ICONS: 8×5 micro icons, two tiles wide, drawn ON THEIR
     SIDE so the five rows give a middle row of symmetry — Anthony's
     spec; the words KEYS/POT were "heavy") in the original icon
     colours and only while owned, and the six $B61F power icons as
     the HUD font's own 8x8 glyphs on the band's last cell row, lit by
     attribute.  `drawNameTag` grew an optional clip bottom
     (`drawMicro` = left-aligned, clipped to the screen).  An out block's
     quarter is blank; the attract/rewind screens keep the classic
     captured halves (drawPanel is attract-only now).  The pixel checks
     RASTERIZE the draw list: the captured panel art is painted first
     and the quarter's fill covers it.  `build/ui/hud.png` shows four
     in, `hud2.png` two.
5. **SPEECH BUBBLES — BUILT 2026-09-03** (Anthony's spec 2026-09-01:
   max 32 characters; ENTER opens the line in game, ENTER again sends,
   an empty ENTER closes — ESC was the cancel in the first cut and was
   dropped 2026-09-03: one key, one rule; headless 1402 → 1432, relaytest 50 → 54, e2e
   30 → 31, protocol v3, protocheck 36).  Display metadata end to end,
   the NAMES pattern exactly:
   - **The wire:** MSG_CHAT (16; 14/15 were taken by PING/PONG) C→S
     `u8 len, text` and S→C `u8 seat, u8 len, text`; `chatLen` 32;
     the relay sanitizes to the micro font's charset — upper A-Z 0-9
     space and the punctuation `. , ? ! ' -` ADDED to TAG_FONT for
     speech (names stay A-Z 0-9 space) — cuts to 32, stamps the SEAT
     and echoes to everyone seated, the SPEAKER INCLUDED (his bubble
     rises on the echo like everyone's: one path, one timing); one
     line per seat per `limits.chatMinMs` (500), the rest and empty
     lines dropped silently; an unseated CHAT drops the connection.
     `game.chat[seat] = {text, until}` (until = netNow + CHAT_MS,
     5 s), reset() clears it, restore() preserves it like names;
     never in fingerprint() or the snapshot (both pinned).
   - **The bubble** (drawBubbles, called from the TAG PASS with its
     `placed` list — the tag records grew an `h`): the sprite's own
     draw arithmetic anchors it, a DEAD speaker's at his RIP cell; two
     lines of 16 via `chatLines` (wrap at a space inside 16 when the
     tail also fits, else hard split); 1 px border in the speaker's
     panel ink (steady, no flash), bright white paper, black micro
     text, a two-row tail; placed above the sprite, stepping up past
     tags/bubbles, else BELOW with the tail up (the window's top edge,
     where a sprite has no room above); clipped to the playfield like
     a tag; NO meeting gate.  The newest line replaces the last.
   - **Composing:** `netChatKey(key)` is the keydown handler's first
     stop (before KEYMAP): online, live, in play, for a player in the
     game or lying dead, ENTER opens `net.compose`; then every key is
     the line's — letters/digits/space/punctuation upper-cased,
     Backspace, cap 32, all else swallowed (ESC included: it is no
     longer a chat key) — ENTER sends the trimmed line, an EMPTY line
     closes without sending (rub it out, ENTER = abandon).
     `netLocalDir()` returns 0
     while a line is open (the player STANDS: just a byte on the
     wire; mutation-verified), and your own bubble shows the line so
     far with a blinking `_` cursor — the text box IS the bubble.  NO
     on-screen hint (a first cut said ENTER SENDS  ESC CANCELS; a
     bubble could sit under it and a text line needs no manual —
     Anthony).  ENTER falls through to KEYMAP (the options screen's
     own) whenever the chat does not take it, and it CANNOT BE BOUND:
     it is the rebind capture's reserved key (skipped) — pinned (ESC
     has no KEYMAP entry either, pinned for the record).  `build/ui/chat.png`
     shows three bubbles, one stacked under a name tag.
7. **THE KEYS PAGE — REWRITTEN 2026-09-03** (Anthony: "tidy it up and
   add the relevant details — arrows, ENTER, full screen, chat, default
   keys, controller buttons").  $C2D3's second splash kept the
   original's text (cursor keys + SPACE for a menu this fork lacks, a
   PAUSE key it never had, the retired high-score entry).  Its logo
   rows still print from the page data; the body is `KEYS_PAGE` data
   drawn over the screen by `FrontEnd.pageRender` — headings in the HUD
   font (uiText, bright yellow), the bulk in the MICRO font (drawMicro,
   up to 51 characters a line), the footer white — rolling in on the
   page's own row clock.  The credits page is untouched (Anthony: "the
   credits should definitely stay as is").  The suite holds every line
   to its font's charset and width and checks the page says what it
   must; `build/ui/keys.png` and `credits.png` are the shots.  ONLINE
   IN THE WORDMARK (2026-09-04, Anthony's mock-up): every drawn logo —
   credits, keys, the options panel — carries ONLINE in the micro font,
   bright green, INSIDE the logo's three rows: the bitmap (dumped from
   FE_LOGO_SCR) has its letter bodies ending at row 15 and only three
   stems below, leaving x 114..157 clear across rows 17..21, so ONLINE
   sits at x 121..149, rows 17..21 (`FE_LOGO_ONLINE`, `drawLogoOnline`);
   the suite checks the wordmark is blank under it, inked above it and
   beside it.  A first cut put it under the logo and shifted the
   credits text a row — wrong: it is part of the logo, and the credits
   page is untouched again.  THE BIG ONE: the LOADING screen's wordmark
   (up through the tune) gets ONLINE in the HUD font's 8x8, ink only on
   the red band (`drawTextInk`), at x 120..166, rows 169..176 — right of
   the tail, level with it, under the letters — read off
   FE_LOADING's bitmap: letters end at row 167, one tail to 177, the KB
   signature at x 210+ (`FE_LOADING_ONLINE`, `drawLoadingOnline`; the
   suite checks the picture is clear under it and inked above).  The
   character-portraits title screen has no wordmark; the attract HUD's
   captured one keeps PRESS FIRE under it.
6. **FULL SCREEN — BUILT 2026-09-03.**  The PICTURE only (Anthony:
   "render exactly how the port intends, no extension of the playing
   field" — the 256×160 window is a rule: actors freeze outside it,
   shots die at its edge).  `#overscan` is the fullscreen element, so
   the whole screen is the $84CA border; `fullscreenScale` picks the
   largest WHOLE multiple in DEVICE pixels (HiDPI-safe, or the 4x5 tag
   font blurs); Alt+Enter toggles (the PC convention; F5 was suggested
   and is the browser's reload, F11 the browser's own window mode),
   as do a double-click on the canvas and a second faint corner button
   (`#fs`).  The browser owns Escape in full screen (it leaves; the
   page never sees it) — moot for the chat, whose one key is Enter.
   Pinned: the scale table, the key rule, the furniture.
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
  `FAITHFUL_TAPE_PROMPTS`, `FAITHFUL_SYM_CHEAT`, `FAITHFUL_HURRY_UP`,
  `zonePotion`. In this fork
  they can be collapsed toward the modern side — but strip incrementally
  and keep `headless.js` green at every step.
- The HUD font has verified glyphs ONLY for digits, uppercase letters and
  space. Punctuation renders garbage. Reword UI text; never print `:` `/`
  `>` etc. with it.
- Key rebinding: 6 slots, swap-on-own-key, nothing ever refused except
  ENTER (the screen's confirm and the chat's open/send: the capture
  SKIPS it).  The
  cross-player conflict UI left with local P2.  The zone persists in
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
  GitHub (2026-09-03): `origin` = https://github.com/cookertron/Gauntlet-JS-Online
  (PRIVATE; `main` tracks `origin/main`, push after each commit).  The
  `faithful` remote is the upstream port, for cherry-picks only.
