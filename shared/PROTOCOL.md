# Gauntlet Online — the relay protocol, v1

The wire between the browser clients and the C++ relay
(`server/relay.cpp`).  `protocol.json` beside this file is the
machine-readable half: every constant named here lives there, the C++
mirrors it in one marked block, and `python tools/protocheck.py` fails
the moment the two drift.

## What the relay is — and deliberately is not

**Lockstep relay.**  Every client runs the full JS sim it already has;
the server relays **one direction byte per seat per pass**, owns the
session (who is seated, when the loop advances, who provides a state
snapshot), and arbitrates desyncs with the sim's own `fingerprint()`.
The server **never runs the sim** — that is what keeps it a small
standalone program.  It never inspects a snapshot either: the JSON from
`game.snapshot()` crosses it verbatim.

A player *joins the game* in-sim, not in-protocol: the engine has no
player-count switch — whoever presses FIRE is in ($9440).  The relay
only decides whose bytes are in the lockstep set; the first FIRE bit a
new seat relays is what materialises the player, through exactly the
code that revives a dead one.

## Transport

WebSocket (RFC 6455) over TCP, default port **33792** ($8400 — the
game's own load address).  Payloads are **binary frames**; client
frames are masked, as the RFC requires, and the server closes on an
unmasked one.  Frames up to `limits.frameMax`, assembled messages
(continuation frames are honoured) up to `limits.messageMax`.

All multi-byte integers below are **little-endian** (both ends are
explicit about this; the RFC's own length fields stay network order as
the RFC demands).

The relay also sends an RFC 6455 **ping** control frame once a second
to every upgraded connection and times the pong for its window's ping
column (browsers answer in the network layer, no page code involved).
That is transport, not protocol: a client that never answers loses
nothing but that column.  The protocol's own PING/PONG (14/15) remain
the client's clean round-trip probe.

## Messages

One message = `u8 type` then the fields.  C→S / S→C marks direction.

| type | name    | dir | payload                                            |
|-----:|---------|-----|----------------------------------------------------|
| 1    | HELLO   | C→S | `u8 protoVersion, u8 char` (0..3, the character pick), then optionally `nameLen × u8` name (space-padded) |
| 2    | WELCOME | S→C | `u8 seat, u8 seats, u32 buildSeed, u8 mode, u32 pass` |
| 3    | INPUT   | C→S | `u32 pass, u8 dir`                                 |
| 4    | PASS    | S→C | `u32 pass, u8 seats, seats × u8 dir, seats × u8 wait` (wait = how long that seat's byte waited at the relay for the rest, in 4 ms units, 0 for an empty seat, 255 = a second or more) |
| 5    | FP      | C→S | `u32 pass, u32 fingerprint`                        |
| 6    | DESYNC  | S→C | `u32 pass`                                         |
| 7    | SNAPREQ | S→C | *(empty)*                                          |
| 8    | SNAP    | C→S and S→C | `u32 pass`, rest = UTF-8 JSON (`game.snapshot()`) |
| 9    | READY   | C→S | `u32 pass`                                         |
| 10   | SEATS   | S→C | `u8 occupiedBitmask`                               |
| 11   | ERROR   | S→C | `u8 code` — then the server closes                 |
| 12   | CHARS   | S→C | `maxSeats × u8` character per seat, `0xFF` unset   |
| 13   | NAMES   | S→C | `maxSeats × nameLen × u8` name per seat, space-padded |
| 14   | PING    | C→S | `u32 tag` — answered at once, seat or no seat, ahead of every other duty |
| 15   | PONG    | S→C | `u32 tag` echoed verbatim                          |
| 16   | CHAT    | C→S and S→C | C→S: `u8 len, len × u8 text` (len ≤ `chatLen`); S→C: `u8 seat, u8 len, len × u8 text` — the line sanitized (uppercase A-Z, 0-9, space, `. , ? ! ' -`), stamped with the speaker's seat, echoed to everyone seated |

`dir` is the engine's own per-pass direction byte
(up/down/left/right/fire/potion — the unit the sim always read).

## The session

* **Seating.**  HELLO with the right version takes the lowest free seat
  below the server's seat count, else `ERROR FULL`.  The protocol
  allows up to `maxSeats` (4) and the server defaults to
  `defaultSeats` (4): the sim carries four player blocks (2026-09-02).
  `--seats` lowers it for a smaller table.
* **Boot.**  `WELCOME.mode` is FRESH while the session is at pass 0:
  the client boots `reset({online:true, buildSeed})` and sends READY.
  The buildSeed is the server's one die roll, shared by everyone.
* **Characters are sim state** (they pick shot/fight/magic/armour), so
  every client must boot every block identically.  A fresh HELLO's
  `char` is stored per seat — bumped `(c+1)&3` past any earlier seat's
  pick, since the engine never fields two of one character — and CHARS
  is broadcast to everyone seated.  On CHARS at pass 0 a booted client
  simply resets again (TCP ordering puts every CHARS before PASS 0, so
  nobody has stepped).  The table freezes at the first PASS; an unset
  seat's block derives its character deterministically (the client's
  own default rule), and a late joiner takes characters from the
  snapshot, where they already live.
* **Names are display metadata**, never sim state: they ride HELLO's
  optional trailing field (a HELLO without it means a blank name — old
  clients stay parseable), the server stores one per seat — sanitized
  to uppercase A-Z, 0-9 and space, anything else a space — and NAMES
  broadcasts the whole table on every seating.  Unlike the character
  pick, a snapshot joiner's name DOES apply (the snapshot carries no
  names; each client's table comes only from NAMES).  A leaver's name
  stays with his standing block mid-game — whoever reuses the seat
  overwrites it — and clears with his pick pre-start.  Names never
  enter the sim, the snapshot, or the fingerprint.
* **Chat is display metadata**, the names rule again: a client sends
  CHAT with a line of up to `chatLen` (32) characters; the server
  sanitizes it to the micro font's charset, cuts it to `chatLen`,
  stamps it with the sender's seat and echoes it to every seated
  client — the sender included, so his own bubble rises on the echo
  like everyone's.  A seat may speak once per `limits.chatMinMs`;
  lines inside that window are dropped silently (the spam guard), as
  are empty ones.  An unseated CHAT drops the connection.  Chat never
  enters the sim, the snapshot, or the fingerprint; the client shows a
  line as a speech bubble over the speaker's sprite for a few seconds.
* **The page is the server.**  A plain HTTP `GET /` (no `Upgrade`
  header) on the same port answers with `client/gauntlet.html`, so the
  server's address is the page's own origin and the client needs no
  configuration: the owner runs the exe and shares
  `http://host:33792/`.  `?server=host:port` on the page URL overrides;
  a page opened from `file://` with no override plays offline.
* **The pass loop.**  Pure lockstep.  The loop advances only when every
  seated, READY client has sent INPUT for the current pass; the server
  then broadcasts one PASS with a byte per seat — an empty or
  not-yet-ready seat is substituted `0x00` (in-sim: that player stands
  still, exactly as the pinned byte at the client's NETWORK SEAM always
  did) — and the pass number increments.  A client that starves the
  loop past `inputTimeoutMs` is dropped, and its seat frees.
* **Late join.**  A HELLO after pass 0 gets `WELCOME.mode` SNAPSHOT.
  The loop pauses at the current boundary, the server sends SNAPREQ to
  a provider (the lowest-seat clean client), the provider answers SNAP
  at exactly the session pass, the server forwards it verbatim to the
  joiner, the joiner `restore()`s and sends READY, the loop resumes.
  Snapshots exist only at pass boundaries — which is the only place a
  lockstep joiner could land anyway.
* **Desync arbitration.**  Clients send FP every `fpEvery` passes (a
  pass number divisible by it, same number on every client by
  lockstep).  When every seated client has reported the same pass, the
  values are compared: majority wins, a tie goes to the lowest seat.
  Each minority client gets DESYNC and is then re-synced through the
  snapshot flow above, with a majority client as provider.
* **Seat reuse is the join-in model.**  A dropped client's sim player
  keeps standing (bytes 0); a new client seated there resumes that
  block, and FIRE joins or revives him ($9440).  Nothing extra.
* **Orphaned session.**  If every seat empties, the state died with
  the clients: the session resets to pass 0 with a fresh seed, and any
  joiner still waiting mid-sync gets `ERROR ORPHANED` (reconnect lands
  FRESH).

## Version discipline

`HELLO.protoVersion` must equal `version` or the server answers
`ERROR VERSION`.  The snapshot JSON carries its own `v` (the sim's
format); the relay does not look inside it.

Version 2 (2026-09-02, the measurement phase of NETPLAN.md): PASS grew
its trailing per-seat wait bytes and PING/PONG were added.  Neither
changes the lockstep; both exist so that a slow session can be
measured — the far seat's clean round trip, and how long each seat's
byte waited at the relay — before any transport redesign is chosen.

Version 3 (2026-09-03): CHAT (16) was added — display metadata only;
the lockstep is untouched.
