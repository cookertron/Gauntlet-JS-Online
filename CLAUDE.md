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
- `server/` — the C++ server (not started).
- `shared/` — client/server protocol definitions (not started).
- `tools/build.py` — `python tools/build.py` regenerates the client.
- `tools/headless.js` — `node tools/headless.js`, the test suite
  (1211/1211 at fork point). Boots the BUILT file in a vm sandbox.
- `tools/uishot.js`, `tools/dungeonshot.js` — PNG screenshot tools.
- `build/` — JSON assets the build inlines + fixtures the tests read.
- `notes/NOTES-engine.md` — the 4700-line reverse-engineering log of the
  engine. The map. Search it before re-deriving anything.

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
3. Open design questions to settle WITH Anthony before building netcode:
   - lockstep vs server-authoritative (the sim is deterministic — both work);
   - what "the camera" means with 4 players (the original is ONE shared
     screen with a hard 2-player separation leash, $A924/$A944: 61 units
     across / 37 down = exactly one playfield);
   - whether the server re-implements the sim in C++ or hosts the JS one.

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
