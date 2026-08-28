# Gauntlet (ZX Spectrum) — tape, loader and memory map

Phases 1–2 of `PORTING-ZX-TO-JS.txt`. Everything here is derived from the tape
bytes and from disassembly of the loader; nothing is assumed from the Chuckie
Egg case study.

Tools: `tools/tzx.py`, `tools/basic.py`, `tools/adis.py`, `tools/mkimage.py`,
`tools/harness.py`, `tools/boot.py`.

---

## 1. The tape

Two TZX v1.10 images, both stamped "Created with Ramsoft MakeTZX".
`python tools/tzx.py "tape/Gauntlet - Side 1.tzx"` prints the manifest.

### Side 1 — 54,904 bytes, 7 blocks

| # | ID | kind | flag | bytes | purpose |
|---|----|------|------|-------|---------|
| 0 | 0x30 | text | — | — | tool stamp |
| 1 | 0x10 | std data | 0x00 | 19 | BASIC header, name `\x12\x01GAUNTLET`, len 337, p1=0, p2=65535 |
| 2 | 0x10 | std data | 0xFF | 339 | the BASIC program (18 bytes) + 319 bytes of loader smuggled in a REM |
| 3 | 0x10 | std data | **0x80** | 21,010 | front-end: loading screen + title code |
| 4 | 0x20 | pause | — | — | |
| 5 | 0x10 | std data | **0x81** | 2,883 | game data, loads below the main block |
| 6 | 0x10 | std data | **0x82** | 30,585 | the game |

### Side 2 — 95,399 bytes, 32 blocks

| # | flag | bytes | purpose |
|---|------|-------|---------|
| 1 | 0x80 | 964 | first dungeon pack (loaded at the start of play) |
| 2–31 | **0xC0** | 2,609 … 3,841 | 30 further dungeon packs |

**Every data block checksums clean** (XOR fold over flag+body against the last
byte). **No unhandled block IDs.** No `0x15` (direct recording), `0x18` (CSW)
or `0x19` (generalized data) — the three that genuinely defeat a block parser.
Header length (337) equals the body of the block that follows it.

The only deviation from a stock tape is the **flag byte**: `0x80`, `0x81`,
`0x82`, `0xC0` instead of `0xFF`. A stock ROM `LOAD ""CODE` will not touch
them. This is the whole of the tape-level protection, and it does not stop a
block parser — so **the snapshot route is not needed and R3 (byte cross-check)
remains available**.

---

## 2. The BASIC line is a decoy

`python tools/basic.py build/blocks1/Gauntlet_-_Side_1.b02.body.bin`

```
0 {PAPER 7}{INK 7}RANDOMIZE USR 32768<=23778>:REM <319 bytes of machine code>
```

Two tricks, both worth naming because both mislead a careless reader:

1. **The line-length field is `$FF00`** (65,280) where the line is 337 bytes.
   A detokeniser that trusts it runs off the end of the block. The program
   autostarts at line 0 and the first statement never returns, so the ROM
   never needs the field.
2. **The printed digits say `32768`; the 5-byte binary form says `23778`.**
   The interpreter acts on the binary form. 23778 = `$5CE2`, which is the byte
   immediately after the `REM` token. Machine code in a REM.

Layout at `PROG = $5CCB` (stock 48K, 21-byte channel block at `CHANS=$5CB6`):

```
$5CCB  00 00        line number 0
$5CCD  00 FF        bogus length
$5CCF  11 07 10 07  PAPER 7 : INK 7
$5CD3  F9 C0        RANDOMIZE USR
$5CD5  "32768"      the printed digits
$5CDA  0E 00 00 E2 5C 00   the binary form: 23778 = $5CE2
$5CE0  3A EA        ':' REM
$5CE2  <machine code>
```

---

## 3. The loader

```
$5CE2  DI
$5CE3  LD HL,$5CF1
$5CE6  LD DE,$FF00
$5CE9  LD BC,$0100
$5CEC  LDIR                 ; 256 bytes of itself to the top of RAM
$5CEE  JP $FF00
```

The relocated stub (`tools/adis.py 0xFF00 70 --image build/loader_image.bin`):

```
$FF00  LD SP,$5C00
$FF03  LD IX,$8600 / LD DE,$5210 / LD A,$80 / CALL $FF3B   ; block A -> $8600
$FF0F  CALL $C1F2                                          ; front-end, inside block A
$FF12  65,536-iteration delay, border 0
$FF20  LD A,$81 / LD IX,$73DA / LD DE,$0B41 / CALL $FF3B   ; block B -> $73DA
$FF2C  LD A,$82 / LD IX,$8400 / LD DE,$7777 / CALL $FF3B   ; block C -> $8400
$FF38  JP $8400                                            ; ENTRY POINT
$FF3B  SCF / CALL $FF43 / RET c / JP $0000                 ; load-or-reset
$FF43  <inline copy of the ROM's LD-BYTES preamble, then its own
        pilot/sync detection, calling ROM $05E7 and $05E3 for edges>
```

So the loader is **ROM-assisted, not fully custom**: it does its own
flag-byte and pilot handling but uses the ROM's `LD-EDGE-1`/`LD-EDGE-2`.

### The memory map

| block | tape flag | destination | length | note |
|-------|-----------|-------------|--------|------|
| A | `$80` | `$8600` | `$5210` (21,008) | transient front-end |
| B | `$81` | `$73DA` | `$0B41` (2,881) | persists |
| C | `$82` | `$8400` | `$7777` (30,583) | **overwrites all of A** |

`$8400 + $7777 = $FB77`, so block C covers `$8400..$FB76` — which contains all
of block A's `$8600..$D80F`. **Block A is a stage, not a payload:** it is
loaded, `$C1F2` is called, and then it is gone. Anything it leaves behind must
live outside `$8400..$FB76`; `$C1F2` LDIRs a 6,912-byte loading screen from
`$8600` to `$4000` and does its own front-end work there.

**§8 now runs block A for real** and settles what it leaves: exactly five
bytes, `$FFFB..$FFFF`.

The stub survives at `$FF00..$FFFF` (block C ends at `$FB76`) — but see §4: the
game's own relocation overwrites `$FF00..$FF73` moments later, which is
consistent with the static finding that **the game never calls `$FF3B`**
(`tools/grepbytes.py "CD 3B FF"` → 3 hits, all inside the stub itself).

### Loader-left machine state

Only `SP = $5C00`, and it is immediately overwritten — the game's own entry
sets `SP`, `IY` and the interrupt mode itself. There is **no equivalent of the
case study's one-shot `ERR_SP` guard**: the game block runs standalone from a
plain block copy (Q5 = yes). `tools/mkimage.py` asserts each payload length
against the loader's own `DE`, so a mis-parsed block fails the build.

---

## 4. The game relocates itself — the static image is NOT the runtime layout

`$8400: JP $BDED`, and `$BDED` moves five regions before doing anything else:

```
$BDED  DI / LD SP,$FFFB / LD IY,$847F
$BDF5  clear $5800..$5AFF (attributes)
$BE01  LDIR  $F642 -> $4000  len $0535
$BE0C  LDIR  $F1C2 -> $4800  len $0480
$BE17  LDIR  $C000 -> $5F00  len $1080
$BE22  LDIR  $EFF4 -> $8000  len $01CE
$BE2D  LDDR  $EFF3 -> $FF73  len $1F74   ; moves $D080..$EFF3 up to $E000..$FF73
$BE38  9 x $80-byte copies to $4800 from a pointer table at $BF07
```

**Consequence: disassembling the block-copy image gives plausible nonsense in
every moved region.** The ISR is the clearest example — the IM 2 vector
resolves to `$DADA`, and `$DADA` in the static image decodes as garbage.
Everything downstream therefore disassembles against `build/live.bin`,
produced by `tools/boot.py` from the harness after the relocation has run.

---

## 5. Interrupts

`I = $DB`, `IM 2`. The 257 bytes at `$DB00..$DC00` were dumped and counted:
**all 257 are `$DA`**, so the vector resolves to `$DADA` whatever the data bus
floats to — the classic run-of-identical-bytes trick. (Two agreeing bytes
would have proved nothing; the count is the evidence.)

The game enables interrupts itself and is **HALT-paced**: `HALT / HALT` pairs
appear in its wait loops. See `notes/NOTES-battery.md` Q10.

---

## 6. The runtime tape load (side 2)

The game loads dungeon packs from side 2 *during play*, through code at
`$9203` (called once from `$918E`):

```
$9203  CALL $B4FF                      ; save SP, clear
$9206  print "START THE TAPE" at $8A08
$9213  print "STOP   THE  TAPE"
$921E  CALL $8B8E
$9222  LD HL,$C000 / LD DE,$C001 / LD BC,$1010 / LD (HL),L / LDIR
                                       ; ZERO the buffer $C000..$D010 first
$922F  POP IX                          ; IX = $C000
$9231  LD DE,$1000
$9234  LD A,(IY+$4E)                   ; the EXPECTED TAPE FLAG, set by the caller
$9237  SCF / INC D / EX AF,AF'         ; note: no DEC D -- DE is $1100 at the call
$923A  LD A,15 / OUT ($FE),A / IN A,($FE) / RRA / AND $20 / OR 3 / LD C,A / CP A
$9247  CALL $056B                      ; jump straight into the ROM's LD-BREAK
$924A  LD HL,$D000                     ; scan DOWN for the last non-zero byte
$924D  LD A,(HL) / DEC HL / OR A / JR z,$924D
$9252  INC A / JR z,$9258              ; last byte $FF -> the load SUCCEEDED
$9255  INC (HL) / JR nz,$9222          ; else RETRY -- see the correction below
$9278  LD HL,$C000 / (zero 6 bytes) / PUSH HL
$9283  RET                             ; <- JUMPS INTO THE BLOCK JUST LOADED
```

Two things here are design, not accident, and both were confirmed by
measurement in the harness rather than inferred:

* **The buffer is zeroed before the load and the request is deliberately too
  long** (`DE = $1100` = 4,352 against a 962-byte first pack). The load is
  *meant* to run out of tape. The game never tests carry; it finds the real
  length by scanning down from `$D000` for the last non-zero byte.
* `$918E` sets `(IY+$4E) = $80` for the first pack. The 30 side-2 blocks
  tagged `$C0` are the later packs.

### CORRECTION: `$9252` is not an end-of-tape test

This file used to gloss `$9252` as "last byte `$FF` → that was the final
pack". **Every one of the 31 packs ends in `$FF`**, so it cannot be that.
`$9252` is a **load-success / block-complete test** and `$9255 INC (HL) /
JR nz,$9222` is a **retry**: the game re-enters the loader until it gets a
block whose last non-zero byte is `$FF`. Measured by driving `$924A` directly
— `$FF` goes to `$9258` and stops, `$37` or `$01` goes back to `$9222` and
loads another block — and by making every load fail: the scan then runs off
the bottom of the zeroed buffer, stops at the highest non-zero byte below
`$C000` (`$BFFB`), increments `$BFFA` and retries, 240 times in 4M
instructions. That retry loop is precisely the mechanism that lets a real
tape roll forward past blocks whose flag does not match.

### AND THE LOADER'S LAST ACT IS TO EXECUTE WHAT IT LOADED

`$9278..$9283` zeroes six bytes at `$C000`, pushes `$C000` and `RET`s into it.
The six zeroes are six `NOP`s; the pack's own **179-byte stub at `+$006`**
then runs. Measured by stepping from `$9283`: the PC goes `$C000 $C001 …
$C006 …`, and the writes `($84CC) ← $80` (from `PC=$C00D`) and `($84CD) ← $C0`
(from `PC=$C010`) are made **by the pack**. Nothing in the game's own code
ever writes `$84CD` except `$918A`.

That is what makes the whole scheme work, and it is why **the game never
indexes the tape**: there is no pack number anywhere in the code. `$9203` asks
the ROM for the next block whose flag equals `(IY+$4E)`, takes whatever
arrives, and the block itself decides which of its ten sub-blocks become
levels. The tape's physical order is the level order. Full account, with the
stub's own algorithm, in `NOTES-engine.md`, *The dungeons*.

The harness serves these at a **PC breakpoint at `$9247`** rather than
modelling the tape signal — see the docstring in `tools/harness.py` for
exactly what that substitution does and does not preserve. Note that the
breakpoint is *before* `$9278`, so the pack's own stub still executes for
real; only the transfer of the bytes is by fiat.

---

## 7. Global variables live at `IY`

`$BDF1  LD IY,$847F`, and it is never reloaded during play (`LD IY,nn` occurs
three times in the whole image: `$9CF4` and `$BDF1` both load `$847F`;
`$BAE3` loads `$BDBF` inside one routine). So **every `(IY+d)` in the game is a
named global at `$847F+d`**, and `(IY-d)` reaches the block below it. That
single fact replaces most of what a reference disassembly would have given us.

Confirmed members so far:

| address | via | meaning |
|---------|-----|---------|
| `$847F..$8486` | `IY+$00..$07` | **keyboard state**, one byte per half-row, written by `$B4E8` |
| `$84CA` | — | shadow of the last `OUT ($FE)` value (border + speaker bit) |
| `$84CD` | `IY+$4E` | expected tape flag for the next dungeon pack |
| `$8420`, `$8440` | — | the two **player blocks**, 32-byte stride |
| `$FFFC` | — | control-method selector (0..3) dispatched at `$8560` |

`$B4E8` is the whole keyboard driver:

```
$B4E8  LD BC,$FEFE
$B4EB  LD HL,$847F
$B4EE  IN A,(C)          ; read one half-row
$B4F0  OR $E0            ; force bits 5-7 high
$B4F2  LD (HL),A / INC L
$B4F4  RLC B             ; $FE -> $FD -> $FB -> ... -> $7F, carry clears after 8
$B4F6  JR c,$B4EE
$B4F8  RET
```

Because it scans **all eight half-rows unconditionally every pass**, the
manual's "single-step to the first port read and log the half-row select"
trick (8.1) does not discriminate in this game. Menu keys were found
behaviourally instead — `tools/keyprobe.py` presses each of the 40 keys from
one saved boot state and reports new PCs and changed variables.

---

## 8. Block A — THE FRONT END, DRIVEN

`tools/blockA.py` is a second harness. `tools/harness.py` cannot run the front
end at all: it places blocks A, B and C and enters at `$8400`, and block C has
already covered `$8600..$D80F` before the first instruction executes.
`blockA.py`'s `stage_a()` instead builds **ROM + block A at `$8600` + the
loader stub at `$FF00`**, sets `PC = $C1F2` and `SP = $5C00`, and pushes the
loader's own return address `$FF12` — the machine at the instant `$FF0F CALL
$C1F2` runs, with blocks B and C not yet loaded. "The front end finished" is
then a PC comparison, not a guess.

```
python tools/blockA.py map        walk the screens, PNGs to build/fe_*.png
python tools/blockA.py chars      drive the character picker to each index
python tools/blockA.py controls   drive the control picker to each method
python tools/blockA.py two        every (player 1, player 2) character pair
python tools/blockA.py inputmap   MEASURE all four control methods in-game
python tools/blockA.py leaves     full memory diff across the front end
python tools/blockA.py boot C M   front end -> blocks B,C -> game, live at $8503
python tools/blockA.py save       build/state_frontend_{menu,done}.pkl
```

### 8.1 Its timing model is not the game's

The game's loop top is `$8503`, once per pass, several video frames per pass.
Block A HALTs **once per screen update**, in

```
$CC4E  EI / HALT / RET
```

and each interactive loop polls the keyboard after a fixed number of those
HALTs. The character picker `$C75B` is the extreme case: `$C809` counts
`0..13` and the key test at `$C7BB` is only reached on the pass where it wraps,
so **the picker samples input once every 14 video frames (0.28 s)**. A shorter
tap is invisible; a held key repeats at that rate. The one/two-player toggle
`$C5CF`/`$C5F1` is the opposite extreme — its loop contains **no** frame wait
at all, so it is level-triggered and clamped (`INC A / CP 3 / JR nz / DEC A`)
and a held key pins the count rather than repeating.

Block A also has **its own keyboard scanner**, `$C8EA` — the game's `$B4E8` is
in block C and does not exist yet. It writes eight half-rows to
`$C8FB..$C902` and is called once per frame from block A's own IM 2 handler at
`$C824` (`I = $FD`, a **256-byte** `$FD01..$FE00` table of `$EE` — `$C283 LD
HL,$FD01 / LD B,$80` writes exactly 256 bytes and `$FD00` is never touched —
with `JP $C824` planted at `$EEEE`). Every key test in the front end reads
`(IX+n)`: `+0` `$FE` CAPS Z X C V, `+1` `$FD` A S D F G, `+2` `$FB`
Q W E R T, `+3` `$F7` 1 2 3 4 5, `+4` `$EF` 0 9 8 7 6, `+5` `$DF` P O I U Y,
`+6` `$BF` ENTER L K J H, `+7` `$7F` SPACE SYM M N B.

**CORRECTION, measured.** An earlier draft of this section said "`IX` is
parked at `$C8FB` throughout". It is not — **each key test loads it itself**.
Sampled live, `IX` is `$C408` on arrival at `$C426` and `$C8FB` at `$C7BF`,
because the instruction immediately before is `$C7BB LD IX,$C8FB` (and
likewise `$C2B3`, `$C4F5`, `$C5BC`, `$C861`, `$C86C`, `$C220`, `$C389`,
`$C5F4`). The half-row decode above is unaffected and every 40-key probe
confirms it; only the word "parked" was wrong.

**CORRECTION, measured: a HELD CURSOR KEY REPEATS.** An earlier draft said "a
held key cannot drive this front end". That is true only of SPACE, which is
edge-gated by `$C86C` (wait for RELEASE) followed by `$C865`/`$C7BF` (wait for
PRESS) — held continuously from `$C1F2`, 3,000 frames later the machine is
still inside block A with `($FFFF) = $2A`. The two cursor keys are
**level-triggered and loop straight back with no release test** (`$C7DD JP
$C75B`, `$C572 JR $C558`), so they auto-repeat at the poll rate. Measured:

| held key | where | steps | over |
|----------|-------|-------|------|
| `5` | character picker | `0 → 1 → 2 → 3 → 0`, one per **14.000** frames | 60 frames |
| `6` | control picker | eight steps, one per **10.000** frames | 80 frames |
| `8` / `5` | player count | **pinned** at 2 / at 1 (both arms clamp) | 60 frames |

### 8.2 The screens, in order

| PC | screen | PNG |
|----|--------|-----|
| `$C224` | "STOP TAPE AND PRESS SPACE" (inline text at `$C203`) | `build/fe_0_stoptape.png` |
| `$C25D` | the 6,912-byte loading screen, LDIR `$8600`→`$4000` | `build/fe_1_loadingscreen.png` |
| `$C2D0` | credits page 1 (`IX = $CE71`, `CALL $C83C`) | `build/fe_2_title1.png` |
| `$C2DA` | credits page 2 (`IX = $D189`) | `build/fe_3_title2.png` |
| `$C386` | ONE OR TWO PLAYERS | `build/fe_4_players.png` |
| `$C426` | PLAYER ONE CHOOSE | `build/fe_5_choose1.png` |
| `$C4DD` | PLAYER TWO CHOOSE (two-player game only) | |
| `$C4FF` | CONTROLS, player 1 | `build/fe_6_control1.png` |
| `$C514` | CONTROLS, player 2 — **asked in a one-player game too** | `build/fe_7_control2.png` |
| `$FF12` | "PRESS PLAY ON TAPE", back in the loader | `build/fe_8_pressplay.png` |

`$C895` is a print-inline-string call: `POP IX` / plot until NUL / `INC IX` /
`JP (IX)`, so the text sits **in the instruction stream** after each
`CALL $C895`. A plain disassembler decodes it as code and loses the boundary
for everything downstream; `tools/blockA.py` documents the convention.

### 8.3 THE FIVE BYTES

Measured with a write watch over `$FB77..$FFFF` across a complete run
(`python tools/blockA.py watch`). Above block C's top block A writes exactly
two things: its IM 2 vector table `$FD01..$FE00`, and these.

| addr | meaning | written by | default if the player only ever presses SPACE |
|------|---------|-----------|-----------------------------------------------|
| `$FFFF` | player 1's character 0..3 | `$C42C LD ($FFFF),A` from `($C7FD)` | **0 — WARRIOR** |
| `$FFFE` | player 2's character 0..3 | `$C449` (one player) or `$C4E3` (two) | a draw, see 8.5 |
| `$FFFD` | sound branch, 0 = 48K beeper, 1 = 128K AY | `$C242 LD ($FFFD),A` after the `$7FFD` probe | **0 — 48K** |
| `$FFFC` | player 1's control method 0..3 | `$C508 LD ($FFFC),A` from `($C808)` | **0 — SINCLAIR** |
| `$FFFB` | player 2's control method 0..3 | `$C51D LD ($FFFB),A` from `($C808)` | **0 — SINCLAIR** |

`$FFFB` is the lowest byte the game's own stack (`$BDF1 LD SP,$FFFB`) can
never reach, which is why the five live there.

**The defaults are not folklore, they are instructions.** `($C808)` is zeroed
by `$C4F9 SUB A / LD ($C808),A` immediately before *each* control picker, so
both control methods default to 0 unconditionally. `($C7FD)` is the character
cursor and it is **not written at all** between `$C1F2` and `$C426` — measured,
the only write in `$C7FD..$C809` on the way to the picker is `$C383 LD
($C7FF),1`, the player count — so it holds its tape value, `$C7FD = $00`.

### 8.4 The character index, PROVED

Three independent readings agree, and the third is the game's own.

1. The picker's highlight table `$C800` (2 bytes per index, an attribute
   address) and its colour table `$C818` put index 0 at attr row 9 col 8 with
   paper 2 RED, 1 at row 13 col 8 paper 5 CYAN, 2 at row 13 col 21 paper 6
   YELLOW, 3 at row 9 col 22 paper 4 GREEN.
2. The menu art (`build/fe_4_players.png`) labels those four quadrants
   **Thor / Warrior** (red), **Thyra / Valkyrie** (cyan), **Merlin / Wizard**
   (yellow), **Questor / Elf** (green).
3. Driving the menu to each index and letting the loader finish and the game
   boot (`python tools/blockA.py boot k 0`) makes the game's own panel print
   WARRIOR / VALKYRIE / WIZARD / ELF in red / cyan / yellow / green —
   `build/fe_10_panel_by_index.png`. `($8433,$8435)` come out
   `($00,$8E) ($08,$D8) ($10,$32) ($18,$64)`, matching the `$BF19` table row
   for row.

So **0 WARRIOR, 1 VALKYRIE, 2 WIZARD, 3 ELF**, and NOTES-engine's "index 3 is
corroborated three ways and proved by none" is now proved. But note what that
does *not* say: **the menu's own default is 0, the WARRIOR.** Index 3 is a
reachable choice (three presses of `5`), not what the tape does on its own.

The picker's keys, from `$C7BB`: SPACE picks (`RET z`), `5` (`BIT 4,(IX+3)`)
steps forward, `8` (`BIT 2,(IX+4)`) steps back. In a two-player game
`$C42F LD ($C7FE),A` parks player 1's index as FORBIDDEN and `$C7D4 CP C / JR
nz / INC A` skips it, so **player 2 can never be the same character as player
1** — `python tools/blockA.py two` walks all sixteen requests and the diagonal
is unreachable.

### 8.5 Player 2's character in a ONE-player game is a draw

```
$C43F  LD A,R / AND 3 / CP C / JR nz,$C449 / INC A / AND 3
$C449  LD ($FFFE),A
```

Enumerated over all 256 values of `R` the guard yields "never player 1's
index, and `(p1+1) & 3` twice as likely as either of the other two".
**Measured** by varying nothing but how long the player dwells in the picker
(0..15 frames), all three permitted values appear within a few frames of each
other — `python tools/blockA.py p2draw`. So the port's "player 2 is the
valkyrie" is not a fact about the tape; it is one of three outcomes, and only
when player 1 is the warrior. In a two-player game `$C4E3` takes it from the
second picker instead and it is a real choice.

### 8.6 The control methods, named on screen and measured in the game

`build/fe_control_all4.png` shows the four rows highlighted in turn:
**0 SINCLAIR, 1 KEMPSTON, 2 PROTEK, 3 KEYBOARD**. `python tools/blockA.py
inputmap` then pokes `$FFFC`/`$FFFB` in the live game and presses all 40 keys,
reading the bitmap `$8560`/`$8589` leave in `($8427)`/`($8447)`:

| `($FFFC)` | routine | player 1 | player 2 |
|---|---|---|---|
| 0 SINCLAIR | `$85DC` / `$8605` | 9 8 6 7 up/down/left/right, 0 fire | 4 3 1 2, 5 fire |
| 1 KEMPSTON | `$8680` (both) | `IN A,($1F)` bit3 up, bit2 down, bit1 left, bit0 right, bit4 fire | same port |
| 2 PROTEK | `$85B3` (both) | 7 6 5 8, 0 fire | same keys |
| 3 KEYBOARD | `$862E` / `$8657` | 1 Q S D, Z fire | 8 I K L, M fire |

MAGIC is added after the dispatch (`$857E` / `$85A7`) and is the same in all
four: **CAPS for player 1, SPACE for player 2**. The menu's own legend for
method 3 — `UP 1 / DOWN Q / LEFT S / RIGHT D / FIRE Z / MAGIC CAPS` and
`8 / I / K / L / M / SPC` — matches `$862E` and `$8657` bit for bit, which is
block A and block C agreeing about the same thing across a tape load.

**Consequence for the port.** `web/template.html`'s key map is method 3, the
arm the stale `$FFFC = $2A` fell through to. That is a real, labelled method
and the map is right for it — but it is not the default. Any key script
written for a menu boot that accepted the defaults must press `0` for player
1's FIRE, not `Z`; `tools/blockA.py boot` selects the right FIRE key per
method for exactly this reason.

### 8.7 What block A leaves behind — nothing but the five bytes

`python tools/blockA.py leaves` diffs the whole 64K across the front end;
2,922 bytes change outside `$8400..$FB76`. Almost all of it then dies:

* `$4000..$5AFF` — the front-end art. The game's `$BDED` clears `$5800..$5AFF`
  and LDIRs its own bitmaps over `$4000` and `$4800`.
* `$61A8..$620B` — the relocated 128K probe (`$CE50`→`$61A8`, 100 bytes).
  `$BE17 LDIR $C000→$5F00 len $1080` covers `$5F00..$6F7F`, so the game wipes
  it itself.
* `$FD01..$FE00` — block A's IM 2 vector table, 256 bytes of `$EE`.
  `$BE2D LDDR $EFF3→$FF73 len $1F74` writes `$E000..$FF73`, so the game wipes
  that too.
* `$5C01`, `$5C05`, `$5C78` and `$5BE4..$5BFD` — KSTATE, FRAMES and stack
  frames left by the **ROM's IM 1 interrupt**, which really does run: `$C245
  CALL $CC4E` does `EI / HALT` while `IM` is still 1 and `I` still points at
  the ROM, before `$C28E IM 2` installs block A's own handler.

The decisive measurement is a two-path differential. Path 1 drives the whole
front end, then places blocks B and C and enters `$8400`; path 2 never runs
block A at all and simply pokes `$FFFB..$FFFF` to the values path 1 produced.
Run both to the first `$8503` **with the arrival phase (`T` and `R`) matched**
and the live 64K differs in **25 bytes, `$5BE4..$5BFD`** — dead ROM-ISR stack
frames a long way below the game's own `SP = $FFFB`, which nothing reads.
Without matching `T`/`R` the diff is 81 bytes; the extra 56 are the game's own
`LD A,R` entropy reacting to a different arrival phase, not block A residue.

So: **the front end's entire contract with the game is five bytes**, and the
project's existing habit of booting the block-copy image and poking them is
exact, not an approximation. What it was poking was wrong; the mechanism was
not.

### 8.8 Saved states

| file | PC | use |
|------|----|-----|
| `build/state_frontend_menu.pkl` | `$C426` | the instant the player-1 character picker is entered, everything before it done for real. `$FFFB/$FFFC/$FFFE/$FFFF` still hold the loader stub's padding `$2A`; `$FFFD` is already 0. |
| `build/state_frontend_done.pkl` | `$FF12` | the front end finished and returned to the loader |
| `build/state_frontend_cK_mM.pkl` | `$8503` | live in dungeon 1 having chosen character K and control method M through the real menu |

### 8.9 THE FRONT END IS NOW PORTED — and what the gate asserts

`tools/fedata.py` extracts block A's assets into `build/fe_data.json` and
`tools/build.py` inlines them; `web/template.html` carries the whole front end
as its own state machine, clocked in **video frames** and never in passes.

```
python tools/fedata.py            re-extract, with the assertions below
python tools/fegate.py all        drive block A and $869F on the real Z80
node   tools/render_shot.js out.ppm --menu PHASE [--key K,K] [--settle N]
node   tools/render_shot.js out.ppm --attract N | --rewind
```

**`tools/fegate.py` is the regression test this project should have had from
the start.** `fegate.py bytes` drives block A from `$C1F2` with a **blind** key
script — it taps SPACE 6 frames on / 10 off and never reads a byte of memory —
and write-watches `$C7F0..$FFFF` all the way to `$FF12`:

```
($FFFB) <- $00   by PC=$C51D          ($FFFE) <- $03   by PC=$C449
($FFFC) <- $00   by PC=$C508          ($FFFF) <- $00   by PC=$C42C
($FFFD) <- $00   by PC=$C242
($C7FD) the picker cursor is written at: ['$C436']   -- i.e. AFTER the pick
writes above $FB77 that are NOT the five and NOT the IM 2 table: 0
```

Those five values are asserted in `tools/headless.js` with the invocation
quoted beside them, so the menu's answers can never be guessed at again.

**What is ported, and against what.**

| piece | original | gated by |
|-------|----------|----------|
| loading screen, title screen | `$8600` / `$A500`, 6,912 bytes each | rendered and looked at |
| block A's own 8x8 font | `$A100`, 128 glyphs | the three text pages render |
| credits / keys / controls pages | `$CE71` / `$D189` / `$D4C2`, 792 bytes | `$C877`'s one-attribute-a-row |
| the menu boxes | the inline strings after each `CALL $C895` | read out of the instruction stream |
| character picker | `$C75B`, 14-frame poll, 2x2 ramp | headless: held-key repeat = 14 |
| one/two players | `$C5CF`/`$C5F1`, unpaced, clamped | headless: pinned at 2 and 1 |
| control picker | `$C555`, 10-frame poll, `XOR $3F` marker | headless: held-key repeat = 10 |
| all four control methods | `$855D` → `$85DC`/`$8680`/`$85B3`/`$862E` | `fegate keymap`, 40 keys x 4 x 2 |
| the 48K title tune | `$C000`, 103 ticks | `fegate tune`, OUT stream byte-identical |
| the ranked tables + sort | `$8826` / `$86ED` / `$8767` | `fegate hiscore`, 9 scenarios diffed |
| the attract loop | `$B470`, 256 frames a page | `fegate attract` |
| REWIND TAPE prompt | `$B494`, cold boot only | headless |

**The tune is validated, not transcribed and hoped for.** `fegate.py tune`
runs the real `$C000` and diffs its `OUT ($FE)` stream against the model tick
by tick: **13,312 values a tick, IDENTICAL**, rests at ticks 6, 14, 22, 80, 86,
94, 102, and **1,277,952 speaker writes** over the whole tune — the published
total, now derived from the model rather than quoted at it. The port plays it
in 940 video frames (18.77 s) against the measured 939.07 (18.75 s); the
difference is frame quantisation of the tick boundaries.

**NOT reproduced, declared:** about 1 T of jitter in the OUT spacing
(1,275,456 real gaps are 48 T, 2,400 are 49 T; the port uses a flat 48), and
`$C061`'s `RL E / JP c,$C10A` escape, which `fedata.py` asserts no note in this
data can reach.
