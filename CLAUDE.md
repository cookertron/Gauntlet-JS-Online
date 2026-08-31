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
  the C++ constants block to it (28 constants, both directions).
- `tools/relaytest.js` — the relay's empirical gate (29 checks): spawns
  the exe, speaks real WebSocket at it (own client, every frame byte
  controlled), plays the full protocol conversation.
- `tools/e2etest.js` — the full stack (18 checks): two real client sims
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
   `CTRL_MAGIC`'s SPACE ($85A7), `controlRead`'s `who` parameter, and the
   local keyboard feed of `players[1].dir`.  **Deliberately KEPT:** the
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
   - `restore()` now repairs `feScr` (attract/rewind shadow screen) —
     found by the e2e: a mid-lobby joiner crashed the page redraw.
   - **The background-tab clock** (found by Anthony's first real test):
     a hidden tab has NO requestAnimationFrame, so the client went
     silent, the relay's 10 s input timeout dropped it and the session
     orphan-reset — the second browser then got a "totally separate
     game".  Fixed: when `document.hidden`, the PASS echo itself is the
     clock (`netPump()` — WebSocket messages still fire in hidden
     tabs), floor-paced at the sim's own tick rate so a hidden-solo
     session cannot free-run (measured 13,800 steps/s before the
     floor).  Tab-out also releases all keys (`visibilitychange`/
     `blur`) — a hidden tab never receives its keyups.
   - v1 paces one tick per round trip (LAN-ideal).  **Later polish:**
     input pipelining (net layer only); a join-time character pick (the
     dir byte has two spare bits); growing the sim to four player
     blocks, which is what unlocks `--seats 3/4`.
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
