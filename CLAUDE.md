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

1. Strip local two-player from the client: player-2 blocks, join/leash/
   shove/PvP, `indepGamepads`, the P2 options rows. Drop to one local player.
2. C++ Windows server; online sessions of up to 4 players.
3. Open design questions to settle WITH Anthony before building netcode:
   - lockstep vs server-authoritative (the sim is deterministic — both work);
   - what "the camera" means with 4 players (the original is ONE shared
     screen with a hard 2-player separation leash, $A924/$A944: 61 units
     across / 37 down = exactly one playfield);
   - whether the server re-implements the sim in C++ or hosts the JS one.

## Engine facts that cost real effort to learn — don't rediscover them

- Each player's input is already a clean per-pass direction byte via
  `controlRead(method, who, kb)` (bits: up/down/left/right/fire/potion).
  That byte is the natural network-serialization unit.
- Faithful/added boundary flags exist throughout: `STREAMLINED_FRONTEND`,
  `FAITHFUL_TAPE_PROMPTS`, `FAITHFUL_SYM_CHEAT`, `zonePotion`. In this fork
  they can be collapsed toward the modern side — but strip incrementally
  and keep `headless.js` green at every step.
- The HUD font has verified glyphs ONLY for digits, uppercase letters and
  space. Punctuation renders garbage. Reword UI text; never print `:` `/`
  `>` etc. with it.
- Key rebinding: 6 slots/player, swap-on-own-key, cross-player conflicts
  refused with an on-screen reason. Zones persist in localStorage.
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
