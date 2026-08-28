# Gauntlet — the render model

Phase 10 in progress. Every claim here is a measurement from the harness with
the tool named; nothing is inferred from the artwork or from how the game
"ought" to work.

---

## 1. There are TWO screens, not one

The game keeps a **complete second Spectrum screen** in high memory, laid out
byte-for-byte like the real one:

| | bitmap | attributes | size |
|---|---|---|---|
| real display | `$4000–$57FF` | `$5800–$5AFF` | 6,912 |
| **shadow / background** | `$C000–$D7FF` | `$D800–$DAFF` | 6,912 |

Proof, three independent ways:

1. **The attribute address arithmetic gives it away.** The blitter computes its
   attribute address from the bitmap address at `$9DD2`:

   ```
   $9DD2  LD A,H / RRA / RRA / RRA / AND 3 / ADD A,$D8 / LD D,A / LD E,L
   ```

   For a bitmap high byte of `$C0`, `$C8`, `$D0` that yields `$D8`, `$D9`,
   `$DA` — the three thirds of an attribute file based at **`$D800`**, not
   `$5800`. (The same shape with `+$58` would be the real screen.)
2. **Rendering `$C000` with the screen renderer produces a picture** —
   `tools/screen.py build/live_cs.bin out.png --base 0xC000` shows the dungeon
   walls with the correct yellow-on-red attributes and **no player sprite**.
   It is the background, without actors.
3. **Write-watching `$C000–$DAFF`** during a level build shows exactly the
   phases you would expect: a `PUSH`-based clear, then the expander, then the
   tile blitter.

So the architecture is: **build the static dungeon into the shadow screen once,
then blit windows of it to the real screen and draw actors on top.** The
shadow buffer is how sprites are erased without the game ever reading the real
display file back — which is why the read-watch found **zero** reads of
`$4000–$5AFF` (Q15).

> **CORRECTION, from the shooting work.** The first half of that sentence is
> wrong. `$8550 CALL $9CD7` copies the shadow playfield to `$4000`/`$5800` and
> then `$9CFE CALL $B4FF` **clears the shadow playfield every single pass** —
> rows 0–19 of the bitmap and their attributes — so the dungeon is
> recomposited from scratch each pass and the shadow screen is a BACK BUFFER,
> not a persistent canvas. Two of the four shooting investigations measured
> this independently (`$B4FF` entered once per pass, thousands of zero writes)
> and neither was contradicted; it was not re-measured while porting.
> It is load-bearing: the four SHOT sprite banks live at `$D080`/`$D280`/
> `$D480`/`$D680` and survive only because the clear steps over the
> `$Dx80..$DxFF` halves of `$D000..$D7FF` — the game stashes them in the
> shadow screen's HUD rows, which the clear skips and the display never shows.
> The "sprites are erased by the shadow buffer" half stands: nothing erases a
> sprite individually, the whole playfield is wiped.

## 2. Scrolling is by WHOLE CHARACTER CELLS — 8 pixels, never less

Measured, not read. Holding right and cross-correlating pixel row y=40 against
the previous frame over 14 main-loop passes:

```
frame  dx(px)  match/256
   1..10   +0     256
   11      -8     250
   12      -8     256
   13      +0     256
```

The only values that ever occur are **0 and −8**. There is no intermediate
shift, so the original has no sub-cell horizontal scroll: the camera moves one
character cell at a time and holds until the player crosses the next boundary.

**This is the fact that stage 2's smooth scrolling has to replace**, and it is
worth being precise about what it costs: the faithful engine's camera is a cell
index, so a smooth-scrolling layer must add a sub-cell camera offset *in the
renderer only*, leaving the simulation's cell-quantised camera untouched — or
the faithful/added boundary assertion will not hold.

Not yet measured: whether vertical scrolling has the same granularity (it
almost certainly does, since attributes cannot scroll finer than 8 pixels
either way), and the pre-shift count for sprites (Q9).

### The half-tile phase, and what it costs (phase 12)

The camera steps 2 coordinate units and one map cell is 4, so **bit 1 of each
camera byte is a half-tile offset** and the viewport is split whenever it is
set. That is what the four painters are for, and each has its own gate:

```
$9EFC  the interior, (16 - camX&2 ? 1:0) x (10 - camY&2 ? 1:0)   always
$9FC2  two extra ROWS       $9FC5 LD A,($848C) / AND 2 / RET z
$A08B  two extra COLUMNS    $A08E LD A,($848B) / AND 2 / RET z
$A159  the four corners     both, and its draw test is AND $7F, not OR A
```

so the number of map cells a pass walks is **160 / 170 / 176 / 187** and
nothing else — exact on 760/760 and again on 570/570 driven passes.

**A cell costs 156 T empty and ~810 T drawn**, which makes the draw phase 43%
of the pass's compute and the single largest term in the pass cost model (see
`notes/NOTES-battery.md` Q10). The engine counts the same cells in
`clockCensusMap()`. Note that the generator sweep `$A9C2` uses `camX&3` /
`camY&3` — a **different** pair of bits — for its 17x11-vs-16x10 window; the
two are easy to confuse and they are not the same rule.

## 3. The blitter

The tile/sprite blitter around `$9DD2–$9E4x` uses the manual's 3.10 idiom:
**`LD SP,source` followed by `POP DE` as a fast data pointer** (two bytes per
10 T-states), with `LD SP,($8489)` at `$9DCD` restoring the real stack and
`LD ($8489),SP` at `$B4FF` saving it.

```
$9DEC  POP DE / LD (HL),E / INC L / LD (HL),D / INC H
$9DF1  POP DE / LD (HL),D / DEC L / LD (HL),E / INC H
...
```

Two bytes written per pixel row, `INC H` stepping one pixel row down inside a
character cell — so the unit is **16 pixels wide**. The alternating
`INC L`/`DEC L` pairs are just column ping-pong to avoid reloading `L`; both
variants put `E` in the LEFT column and `D` in the right, so the byte order is
plain.

> **CORRECTED.** An earlier reading of this routine stopped counting `POP DE`
> at the `JP nc` at `$9E1B` and concluded "8 rows = 16 bytes". That branch is
> the **mid-routine character-row step** (`$9E13 LD A,H / SUB 7` and
> `LD A,L / ADD A,$20`), and there are **sixteen** `POP DE` between `$9DEC`
> and the `JP (IX)` at `$9E49` — 16 rows × 2 bytes = **32 bytes**. The
> miscount is what made the sprite format look unclosed for so long. The
> record is 33 bytes: `$A23E LD C,(HL) / INC HL / LD SP,HL` takes the
> attribute from `+0` and starts the bitmap at `+1`. See
> `notes/NOTES-engine.md`, "The player sprite — closed".

Also worth stating plainly, because §1 below can be misread: `$9DD2`'s
`AND 3 / ADD A,$D8` means the attribute base is **always `$D800`**, whatever
`HL` points at. That is a property of the arithmetic, not a consequence of the
bitmap being at `$C000`, and it is why these three routines can only target
the shadow screen.

Consequences that must not be lost in translation:

* Because `SP` is the source pointer, **any sentinel pushed on the stack before
  calling one of these routines is destroyed** (manual 6.6b). The harness's
  `call()` already uses PC-comparison breakpoints and six distinct sentinels
  rather than a byte patch, for exactly this reason.
* A read-watch attributes those source reads to the `POP` instruction, not to
  a `LD A,(HL)` — which is why the graphics bank at `$5F00` first showed up as
  "reads by `$9DEC`".

## 4. The graphics bank

`$BE17` at boot: `LDIR $C000 → $5F00, $1080 bytes` (4,224). At that moment
`$C000` still holds block C's own data, so `$5F00–$6F7F` is a **static graphics
bank copied out of the game block before `$C000` is repurposed** as the shadow
screen.

**The partition is now closed.** `$1080` = 4,224 = **4 × `$420`**, and `$420` =
1,056 = **32 records of 33 bytes**: it is a master table of the four playable
characters (Warrior/red `$42`, Valkyrie/cyan `$45`, Wizard/yellow `$46`,
Elf/green `$44`). It does not survive: `$BE53`/`$BEE5`/`$BE74` immediately
overwrite the head of it with the two *chosen* sets, so in a running game
`$5F00–$631F` is player 1's 32 records and `$6320–$673F` is player 2's, and
`$BE7D`/`$BE88` then overwrite `$6740+` with captures of the **loading screen**
— which is why contact-sheeting the whole range shows sprites in some places
and screen data in others. The main object/monster bank is elsewhere, at
`$E000` on the same 33-byte grid. Full account in `notes/NOTES-engine.md`.

**Both banks are now decoded and both are drawn.** `tools/playersprite.py
--char 3 --char2 1` writes player 1's set and player 2's (under `p2`) into
`build/player_frames.json`, plus the six shared MATERIALISE records at
`$F45E + n*$21` (attribute `$06`), and gates all of it against the original:
it joins player 2 the way a second player really joins — M held for one pass,
`$9440`'s only gate — traps `$9DD2` and checks the blit destination, the 16×16
the blitter wrote, the 2×2 attribute block and the record the game chose,
12/12 per direction for each player over five poses.

The id formula is `(IX+15) + (IX+13) + phase*8` where the phase term is
`bit6 ? 8 : 0` **plus** `(bit6 && bit7) ? 8 : 0` — the second `ADD A,8` at
`$A4A7` is NESTED INSIDE the first at `$A49F`, so bits 7:6 = 00/01/10/11 give
+0/+8/+0/+16 and the walk cycle is A,B,A,C. A gate that reads A back out of
`$A4AF` cannot see a wrong phase rule at all, because the register already
holds the answer; `playersprite.py` predicts the id from the three block
bytes before the code touches them.

## 5. Level build sequence

Write-watching `$C000–$DAFF` across a level build, with the `$B4FF–$B560`
`PUSH`-clear filtered out, gives the phases in order:

| PC | writes | phase |
|----|--------|-------|
| `$B50B–$B51A` | 12,000+ | `PUSH`-based clear of the shadow bitmap |
| `$B525` / `$B540` | | clear of the rest and of the shadow attributes |
| `$9247` | 962 | the tape load itself (harness deck) |
| `$91E1` | 1,114 | an `LDIR` — see the correction below |
| `$B3ED/$B3EE` | 4,095 | a bulk fill |
| `$9EAB–$9ECD` | 704 each | a 16-way unrolled blitter — see the correction |
| `$9DDD…$9E41` | many | the tile blitter, into shadow bitmap and `$D8xx` attrs |

### CORRECTION: two attributions in that table are wrong

Both were caught by closing the pack format (`tools/packdecode.py`,
`tools/packgate.py` → **307/307**), and both matter, because a port that
believes either one looks for the level data in the wrong place.

* **`$91E1` is not "moving pack material".** It is `LDIR $6F80 → $C000`,
  1,114 bytes, and `$91E3`'s second `LDIR` brings `$DDD8 → $C45A`, 552 more.
  Together they are the **record list being re-assembled from the two RAM
  holes the pack's own stub unpacked it into**. The tape bytes never reach
  `$6F80` by any `LDIR` the game performs: the loader's last act is
  `$9278 LD HL,$C000 / PUSH HL / RET`, which **executes the block it has just
  loaded**, and the pack's own 179-byte stub at `+$006` does the copying.
  Measured: stepping from `$9283` the PC goes `$C000 $C001 … $C006 …`, and
  the writes `($84CC) ← $80` and `($84CD) ← $C0` are made from `PC=$C00D` and
  `PC=$C010` — i.e. by the PACK, not by the game.
* **`$9EAB–$9ECD` is not the expander.** It is a stack blitter, the same
  16-way unrolled `POP DE` idiom as `$9DEC`, with `ADD A,$D8` computing the
  `$D8xx` attribute row. **The expander is `$97CB`, and it writes the MAP at
  `$8000..$83FF`, not the shadow screen.** Write-watching `$8000..$83FF`
  through a whole level build reaches only `$9823/$9825` (the clear),
  `$9973` (`$9960`), `$99C5/$99D3/$99E3/$99F1/$99FA` (`$99BA`) and `$9A0F`
  (`$9A04`) — nothing else on the `$B3D0` path touches the map.

The paragraph below it — "the tape pack is not a screen dump and not a raw
tile grid: it is a compact description" — is right, and the description is now
fully decoded. See `NOTES-engine.md`, *The dungeons*.

### The map tiles are sprite records, and they are per-level

`$9F6C..$9F8A` draws the map through the **same `$7B00` pointer table** the
player and the monsters use, with `id = ((cell − 1) & $7F) + 1` — the `DEC A /
ADD A,A` at `$9F7A` has no mask, so an 8-bit index makes cell `v` and `v+$80`
share an entry, which is why the "second wall graphic" bit 7 draws identically.
`$9AB9`, called from the expander at `$97DF`, **rebuilds sixteen of those
pointers at every level start**: the sixteen wall values `$01..$10` come from
one of five 16-record banks at `$F524 + n·$210` (chosen by the record's flags
bits 3–5) and every one of them is stamped with the level's colour scheme,
`$7D9C[byte2 bits 3–5]`. `tools/maptiles.py` decodes them.

So the tape pack is **not** a screen dump and **not** a raw tile grid: it is a
compact description expanded into the shadow screen. Diffing the 962-byte pack
zero-extended to 6,912 against the live shadow buffer gives 1,077 differing
bytes, and the first difference is at `$C3D9` — just past the pack's own
length. The record walker at `$91F0` shows the shape of the pack:

```
$91F0  RR E / RET c
$91F3  LD C,(IX+0)          ; record length in C
$91F6  LD B,0
$91F8  BIT 7,(IX+2)         ; a flag in the third byte...
$91FC  JR z,$91FF
$91FE  INC B                ; ...adds 256 to the stride
$91FF  ADD IX,BC
$9201  JR $91F0
```

**A variable-length record list with a length byte at +0 and a 9th length bit
carried in bit 7 of +2.** That reading is right, and `E` is a **one-hot
selector**: `RR E` consumes one record per zero bit and stops on the one.

**CLOSED.** The expander is `$97CB` (not `$9EAB`), the closure test runs, and
it is **307/307 sub-blocks, 1024/1024 cells each**, against the grid the
original builds in live RAM — `python tools/packgate.py all`, and again from
the other side as 307 checks in `node tools/headless.js`. The format itself
is written up in `NOTES-engine.md`, *The dungeons*.
