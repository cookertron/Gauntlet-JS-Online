# Gauntlet Online

Online multiplayer fork of a faithful ZX Spectrum *Gauntlet* (1986, U.S.
Gold) JavaScript port. The plan: a single-player browser client, a
standalone C++ Windows server, and online play for up to 4 players — keeping
the original game's look, feel and rules while modernising how people reach
it.

Status: **fork point.** The client is the complete faithful port (one
self-contained HTML file); nothing has been stripped or added yet.

## Build & test

```
python tools/build.py     # client/template.html -> client/gauntlet.html
node tools/headless.js    # the test suite (1211/1211 at fork point)
```

Open `client/gauntlet.html` in a browser to play.

## Provenance

Forked 2026-08-28 from the faithful port (its own repo/folder remains the
reference build and is unchanged by anything here). The first commit of this
repository is the pristine fork point — everything this fork changes is
visible as a diff against it.
