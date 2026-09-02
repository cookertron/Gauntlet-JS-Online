# Gauntlet Online

Online multiplayer fork of a faithful ZX Spectrum *Gauntlet* (1986, U.S.
Gold) JavaScript port. The plan: a single-player browser client, a
standalone C++ Windows server, and online play for up to 4 players — keeping
the original game's look, feel and rules while modernising how people reach
it.

Status: **online multiplayer for up to FOUR players** (2026-09-02).
The client is one local player; the simulation carries four player
blocks (the original's two, and two more cut to the same pattern and
proven against the two-block build pass for pass), the relay seats four
by default, and the in-game HUD is four quarters -- name, score, health,
keys and potions, power icons -- one per seat.  Whoever presses FIRE is
in, exactly the engine's own join-in model, and a dead player rejoins
the same way.

## Build & test

```
python tools/build.py     # client/template.html -> client/gauntlet.html
node tools/headless.js    # the client test suite (1399/1399)
```

Open `client/gauntlet.html` in a browser to play offline.

## Play online

The relay serves the game itself: run it, share the address, done.

```
server\build\gauntlet-relay.exe          # builds below; --port/--seats/--html (four seats by default)
```

Everyone opens `http://<host-ip>:33792/`, picks a character and a NAME
(worn over your head when players meet on screen, in your own colour —
left unset, your character's name), and STARTs with SERVER ONLINE —
START drops you straight into the dungeon, joining any game already
running.  After a game ends the attract screen waits for
FIRE to begin the next one, exactly as the arcade did.  Opening the
page from disk (or setting SERVER LOCAL) plays offline;
`?server=host:port` joins a relay from a page hosted elsewhere.

If a session stutters, paste `__GAUNTLET__.net.info()` from the
browser console (F12) on BOTH machines.  It names each machine's
exchange rate against the sim's own, the worst stall seen, the clean
link round trip (`rtt=min/median/worst`, from a once-a-second ping
the relay answers ahead of everything else) and how long each seat's
input waited at the relay for the others (`wait=`, per seat) — which
together separate "the wire is slow" from "one seat is slow".

For play from OUTSIDE the network, `--forward` asks the router to open
the port itself (NAT-PMP first, then UPnP), prints the public address
to share, renews the lease, and removes the mapping on Ctrl+C
(`--unforward` cleans one up by hand).  It also tells the truth when
forwarding cannot work: a DOUBLE-NAT setup (the router behind an ISP
modem — the outer box must forward too, or run in bridge mode) or
carrier-grade NAT (only the ISP or a tunnel can fix that).  The
Windows Firewall must allow the exe as well — it prompts on first run.

The C++ relay server (`server/relay.cpp`, protocol in
`shared/PROTOCOL.md`) builds inside the VS x64 environment:

```
vcvars64 && cmake -S server -B server\build -G Ninja
         && ninja -C server\build
python tools/protocheck.py                 # protocol constants in sync
node tools/relaytest.js                    # the relay's own gate (50 checks)
node tools/e2etest.js                      # four real clients through it (30 checks)
server\build\gauntlet-relay.exe            # run it (--port 33792 --seats 4)
```

## Provenance

Forked 2026-08-28 from the faithful port (its own repo/folder remains the
reference build and is unchanged by anything here). The first commit of this
repository is the pristine fork point — everything this fork changes is
visible as a diff against it.
