# Gauntlet Online

Online multiplayer fork of a faithful ZX Spectrum *Gauntlet* (1986, U.S.
Gold) JavaScript port. The plan: a single-player browser client, a
standalone C++ Windows server, and online play for up to 4 players — keeping
the original game's look, feel and rules while modernising how people reach
it.

Status: **single-player client.** Local two-player has been stripped from
the frontend and input layer.  The simulation deliberately keeps both
player blocks and the join/leash/shove machinery -- the engine's join-in
model (whoever presses FIRE is in) is exactly the drop-in shape online
multiplayer needs, and `players[1].dir` is the marked network seam.  The
C++ server is not started.

## Build & test

```
python tools/build.py     # client/template.html -> client/gauntlet.html
node tools/headless.js    # the test suite (1161/1161; 1211/1211 at fork)
```

Open `client/gauntlet.html` in a browser to play.

## Provenance

Forked 2026-08-28 from the faithful port (its own repo/folder remains the
reference build and is unchanged by anything here). The first commit of this
repository is the pristine fork point — everything this fork changes is
visible as a diff against it.
