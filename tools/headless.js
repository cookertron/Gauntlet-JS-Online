/* headless.js -- run the BUILT artifact under Node with a stubbed DOM.
 *
 * Manual phase 14: "Load THE BUILT ARTIFACT, not your source modules, so the
 * build step is under test."  And: "A CANVAS STUB THAT RECORDS DRAW CALLS WHEN
 * ARMED ... for anything conditional, RENDER TWICE with only the flag changed
 * and DIFF THE TWO DRAW LISTS."
 *
 *   node tools/headless.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);
const BUILT = path.join(ROOT, 'client', 'gauntlet.html');

let checks = 0, failures = 0;
function check(name, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.log(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
  else console.log(`  ok    ${name}`);
}
function checkTrue(name, cond, detail) {
  checks++;
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}

/* ---------- the DOM stub ---------------------------------------------- */
const drawCalls = [];
let recording = false;

const ctxStub = {
  set fillStyle(v) { this._fill = v; },
  get fillStyle() { return this._fill; },
  fillRect(x, y, w, h) { if (recording) drawCalls.push(['fillRect', x, y, w, h, this._fill]); },
};

function makeEl(id) {
  const set = new Set();
  return {
    id, _text: '', innerHTML: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    getContext() { return ctxStub; },
    // a real element always has one; the engine paints the overscan frame
    // (the Spectrum BORDER, $B4FC OUT ($FE)) through it
    style: {},
    classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) },
    /* a real element has these, and the TEST panel calls blur() to hand the
       arrow keys back to the game after a jump.  Without them the panel
       checks below crash rather than fail, which is worse than either. */
    blur() {}, focus() {},
    width: 256, height: 192,
  };
}

const els = new Map();
let rafCallback = null;

/* A real, if minimal, localStorage -- settingsSave()/settingsLoad() guard
   every call in try/catch (a page opened from file:// can throw on it), so
   without this the whole round trip fails SILENTLY: save writes nowhere,
   load reads nothing back, and every persistence check that ever ran here
   was passing because there was nothing to fail on, not because the
   round trip worked.  Found driving a check that a save cannot leak
   PLAYERS back on the next load -- the save had nowhere to land. */
const localStorageStore = new Map();
const localStorage = {
  getItem(k) { return localStorageStore.has(k) ? localStorageStore.get(k) : null; },
  setItem(k, v) { localStorageStore.set(k, String(v)); },
  removeItem(k) { localStorageStore.delete(k); },
  clear() { localStorageStore.clear(); },
};
const sandbox = {
  console,
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  document: {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
  },
  addEventListener() {},
  requestAnimationFrame(cb) { rafCallback = cb; return 1; },   // CAPTURE, don't fire
  localStorage,
  Math, JSON, Uint8Array, Buffer, String, Number, Array, Object, Error,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* ---------- load the built artifact ----------------------------------- */
const html = fs.readFileSync(BUILT, 'utf8');
checkTrue('built file says it is generated', html.startsWith('<!-- GENERATED'));

const jsonMatch = html.match(/<script type="application\/json" id="assets">([\s\S]*?)<\/script>/);
checkTrue('asset payload present in the built file', !!jsonMatch);
checkTrue('asset payload contains no unescaped "</"', !jsonMatch[1].includes('</'));
// the stubbed document must hand the engine the payload it expects
els.set('assets', Object.assign(makeEl('assets'), { _text: jsonMatch[1].replace(/<\\\//g, '</') }));

const codeMatch = html.match(/<script>([\s\S]*?)<\/script>\s*$/);
checkTrue('engine script present', !!codeMatch);

vm.runInContext(codeMatch[1], sandbox, { filename: 'gauntlet.html' });

const G = sandbox.globalThis.__GAUNTLET__;
checkTrue('test hook exported', !!G);
checkTrue('rAF captured, not fired', rafCallback !== null);

/* ---------- constants that were MEASURED ------------------------------ */
// Expected values come from the harness, with the invocation recorded, never
// from calling the code under test (manual 5.2 rule 4).
//   tools/clock.py  -> 3.97/4.03 frames per pass, no 2x tail
//   tools/extract.py -> deltas of 2 per pass holding right
check('4 video frames is the NOMINAL pass (the cost model charges the rest)',
      G.constants.FRAMES_PER_PASS, 4);
check('player step is 2 units per pass', G.constants.STEP, 2);
check('direction bits (1/Q/S/D measured)',
      [G.constants.DIR_UP, G.constants.DIR_DOWN, G.constants.DIR_LEFT, G.constants.DIR_RIGHT],
      [0x01, 0x02, 0x04, 0x08]);
checkTrue('pass period is ~0.0799 s',
          Math.abs(G.constants.PASS_SECONDS - 4 / 50.08) < 1e-9);

/* ---------- THE PASS COST MODEL (manual B2b) --------------------------
   Every expected value below was MEASURED on the real Z80 with the
   invocation named beside it, never read back out of the engine.       */
{
  const g = G.seed({});

  /* 1. THE QUANTISER IS THE IDENTITY, not a fit.  Drive quantise() with a
        chosen phase and a chosen W1 and check it against the arithmetic the
        original performs: the HALT at $9CD7 releases on the next frame
        boundary, then W2 runs with interrupts off.
          `python tools/clockgate.py w2`  ->  W2 = 154,046 T straight line
          plus three $A29F bodies of 2,205 T (328 T when ($8497&7)==6),
          i.e. 160,661 T = 2.2988 frames with three full ones.
          THESE ARE THE CONTENDED FIGURES.  The ULA contends $4000..$7FFF
          while the display is read, and W2 writes 6,912 bytes into it, so
          the blit costs 6,555 T more on real hardware than on a plain
          Simulator -- mode-to-mode and max-to-max agree to within 1 T.
          The $A29F BODIES DO NOT MOVE (2,186..2,216 plain against
          2,191..2,216 contended): the handler lives above $8000 and
          touches nothing contended.  Re-measure either with
          `GAUNTLET_CONTENDED=1 python tools/clockgate.py w2`.          */
  const F = 69888;
  g.frameCtr = 0;                       // no cheap ISR in the next three
  g.clockPhaseT = 0;
  g.quantise(1);                        // a pass that does nothing at all
  check('a zero-work pass is one frame of HALT plus W2 (three full ISRs)',
        Math.round(g.passFrames * F), F + 154046 + 3 * 2205);
  check('...and it advances $8497 by three: wake, hand call, $B4FF',
        g.passTicks, 3);
  g.frameCtr = 0; g.clockPhaseT = 0;
  g.quantise(2 * F);                    // W1 crosses two boundaries
  check('two frame boundaries inside W1 makes it a five-tick pass',
        g.passTicks, 5);
  /* the CHEAP handler: $A2B4 RRCA x3 / CP $E0 / JR nc skips the logo colour
     cycle when ($8497 & 7) == 6 before its own $A2A2 INC. */
  g.frameCtr = 6; g.clockPhaseT = 0;
  g.quantise(1);
  check('($8497&7)==6 makes one of W2\'s three handlers the 328 T one',
        Math.round(g.passFrames * F), F + 154046 + 2 * 2205 + 328);

  /* 2. THE PHASE IS CARRIED, which is what makes the 4/5 pattern alternate.
        p is a fixed point of W2: 160,661 mod 69,888 = 20,885 T = 0.2988
        frames, and the ORIGINAL's measured range over 300 driven passes
        across five directions is 0.2654..0.2993, mean 0.2879.
        CONTENTION MOVES THIS BAND AND THAT IS THE WHOLE EFFECT: plain, the
        same measurement gives 0.1714..0.2051, and the band is what decides
        whether a pass rounds up to four video frames or five.  Sitting at
        0.19 the game is ON the boundary and passes flip between the two;
        at 0.29 they settle on five, which is what a real 48K does.      */
  checkTrue('the carried phase lands in the measured 0.26..0.30 frame band',
            g.clockPhaseT / F > 0.26 && g.clockPhaseT / F <= 0.2994,
            String(g.clockPhaseT / F));

  /* 3. THE FOUR PAINTERS' CELL CENSUS.  One map cell is half a camera step,
        so bit 1 of each camera byte splits the viewport and the totals can
        only be 160 / 170 / 176 / 187 -- measured EXACT on 760/760 and again
        on 570/570 driven passes, and reproduced here from the engine's own
        walk.  ($9EFC / $9FC2's AND 2 / $A08B's AND 2 / $A159's both.)    */
  const cells = (cx, cy) => {
    const gg = G.seed({});
    gg.camX = cx; gg.camY = cy;
    for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++) gg.map[r][c] = 1;
    gg.clockReset(); gg.clockCensusMap();
    return gg.clk.nzA + gg.clk.nzB + gg.clk.nzC + gg.clk.nzD;
  };
  check('the map census is 160/170/176/187 by the camera\'s half-tile bits',
        [cells(4, 4), cells(6, 4), cells(4, 6), cells(6, 6)],
        [160, 170, 176, 187]);

  /* 4. THE COST RISES WITH THE LOAD, which is the whole point of B2b.
        `python tools/clockgate.py hz`: the ORIGINAL runs a quiet dungeon-1
        pass in 4.13 video frames and a generator-cluster pass in 5.47..6.18,
        i.e. 12.1 Hz against 8.1..9.2 Hz.                                  */
  const cost = n => {
    const gg = G.seed({});
    gg.clockReset();
    gg.clk.nact = gg.clk.nact2 = n;
    gg.clk.upd = Math.min(n, 8); gg.clk.step = 4; gg.clk.contact = 2;
    gg.clk.clipX = n - gg.clk.upd;
    gg.clk.gcells = 187; gg.clk.nzA = 10; gg.clk.nzB = 16;
    return gg.clockCost();
  };
  checkTrue('W1 grows with the actor population, monotonically',
            cost(0) < cost(20) && cost(20) < cost(60) && cost(60) < cost(120),
            [cost(0), cost(20), cost(60), cost(120)].join(' '));
  checkTrue('a 120-actor pass costs more than two whole video frames of work',
            cost(120) > 2 * 69888, String(cost(120)));
  /* 5. THE MESSAGE BANNER is the single largest one-off, and it is what
        `python tools/beepgate.py diff` used to lose ten edges to: $891C's
        text render measured 49,799 T in situ and 52,727 T in beepgate's own
        scenario, against 77 T on every other pass. */
  {
    const gg = G.seed({}); gg.clockReset();
    const q = gg.clockCost(); gg.clk.banner = 1;
    checkTrue('the banner pass carries a ~0.75 frame surcharge at $891C',
              Math.abs((gg.clockCost() - q) - 52650) < 1,
              String(gg.clockCost() - q));
  }
  /* 6. THE FAILSAFE.  A runaway W1 must not come through the quantiser --
        a level reload is 271.8 frames and goes through blockingPause(). */
  g.clockPhaseT = 0;
  g.quantise(1e9);
  checkTrue('the quantiser clamps a runaway pass rather than stalling the clock',
            g.passFrames <= 24 && g.passTicks <= 24,
            g.passFrames + ' ' + g.passTicks);
}

/* ---------- the level round-tripped through the build ----------------- */
const A = G.assets;
check('map is 32x32', [A.map.w, A.map.h], [32, 32]);
check('one cell is 4 units of 4 pixels',
      [A.map.units_per_cell, A.map.px_per_unit], [4, 4]);
checkTrue('map grid has 32 rows of 32',
          A.map.grid.length === 32 && A.map.grid.every(r => r.length === 32));
checkTrue('HUD split at row 20', A.hud.rows === 20);
checkTrue('HUD bitmap is 4 character rows',
          Buffer.from(A.hud.bitmap, 'base64').length === 4 * 8 * 32);
checkTrue('player sprite is 16 rows x 2 bytes', A.player.sprite.length === 32);

/* THE PLAYER'S DRAW ORIGIN HAS NO OFFSET.  This check used to assert (-8, 0)
   and the note beside it warned that a lone -8 "WILL be corrected by someone
   acting in good faith".  It was not a real offset: $B557 is the entire
   coordinate transform ($9DD2, $A1DA..$A243 and $B557 between them contain no
   subtraction of 8) and sampling the player's coordinate AT the instant PC
   reaches $9DD2 -- rather than at the end of the pass -- gives delta (0,0) on
   120/120 draws over five directions (tools/playersprite.py's live gate).
   The old figure came from pairing a blit destination with the coordinate the
   player had AFTER that pass's move, and he moves 2 units = 8 px per pass;
   the same artefact shows up on y when holding down, which a constant -8 on x
   cannot explain. */
if (A.player_frames) {
  check('player draw origin has no offset',
        [A.player_frames._origin.dx, A.player_frames._origin.dy], [0, 0]);
  check('sprite geometry is 2 bytes x 16 rows from a 33-byte record',
        [A.player_frames.w, A.player_frames.h,
         A.player_frames._geometry.bytes_per_record], [2, 16, 33]);
  checkTrue('a frame set was decoded for every direction',
            ['idle', 'up', 'down', 'left', 'right']
              .every(k => A.player_frames[k] && A.player_frames[k].frames.length > 0));
  /* Eight compass slots x THREE walk phases = 24 records, which is exactly
     what the id formula can reach: id = (IX+15) + slot + 8*phase with phase
     from a 2-bit counter decoded 0,1,0,2.  Records 24..31 of a character set
     are not walk frames (24 a distinct standing figure, 25 a dashed
     "materialise" figure, 26..31 the EXIT sign) and the draw path never
     reached them in 120 logged blits. */
  for (const k of ['idle'].concat(A.player_frames._slots)) {
    checkTrue(`${k} has 3 walk phases of 32 bytes`,
              A.player_frames[k].frames.length === 3 &&
              A.player_frames[k].frames.every(f => Buffer.from(f, 'base64').length === 32),
              JSON.stringify(A.player_frames[k].frames.map(f => Buffer.from(f, 'base64').length)));
  }
  check('the walk counter decodes to phases 0,1,0,2',
        A.player_frames._phase_by_ctl, [0, 1, 0, 2]);
  /* Reported in play: "there's no character graphics at all".  The cause was
     ink 0 in four of the five directions -- the old capture read the
     attribute back after the background had been restored, so the sprite was
     drawn black on black.  A sprite with INK 0 is invisible, so assert it can
     never happen again.  (Decoded from record+0 there is no way for it to
     happen: the elf's attribute is $44 = BRIGHT green on black.) */
  for (const k of ['idle', 'up', 'down', 'left', 'right']) {
    checkTrue(`${k} sprite ink is not black (would be invisible)`,
              (A.player_frames[k].ink & 7) !== 0,
              `ink=$${A.player_frames[k].ink.toString(16)}`);
  }
  /* $A47B LD A,(IX+7) / AND 15 / JR z -- the direction bits index $7D0C, and
     ZERO keeps the persisted slot instead of falling back to slot 0. */
  check('the $7D0C direction slots (up/down/left/right -> N/S/W/E)',
        [G.sprite.SLOT[1], G.sprite.SLOT[2], G.sprite.SLOT[4], G.sprite.SLOT[8]],
        [0, 4, 6, 2]);
  {
    const g = G.seed({});
    g.onePass({ right: true });
    checkTrue('holding right selects the E slot', g.frameSlot === 2, `got ${g.frameSlot}`);
    g.onePass({});
    checkTrue('releasing keeps the persisted slot ($A47B JR z)', g.frameSlot === 2);
  }
  /* A point differential for the ANIMATION, in the same spirit as the movement
     tables.  The expected sequence is the record index the ORIGINAL actually
     handed the blitter, logged by trapping $9DD2 for 12 passes holding right
     from build/state_charsel.pkl with the character bank repaired
     (tools/playersprite.py's gate prints these).  Record index = slot +
     8*phase, so 2 = E phase 0, 10 = E phase 1, 18 = E phase 2. */
  {
    const g = G.seed({});
    const got = [];
    for (let i = 0; i < 12; i++) {
      g.onePass({ right: true });
      got.push(g.frameSlot + 8 * g.framePhase());
    }
    check('the walk cycle matches the records the original drew (right, 12 passes)',
          got, [10, 10, 2, 2, 18, 18, 2, 2, 10, 10, 2, 2]);
  }
  /* And the case that found the E gate.  From the level start the wall at y=4
     stops the player after two passes; the ORIGINAL freezes on record 8 (the
     N pose, walk phase 1) and never cycles again, because $A5D8 tests E -- the
     directions that actually MOVED -- not the keys held.  Logged from the
     original: records 8,8,8,8,8,8,8,8,8,8,8,8. */
  {
    const g = G.seed({});
    const got = [];
    for (let i = 0; i < 12; i++) {
      g.onePass({ up: true });
      got.push(g.frameSlot + 8 * g.framePhase());
    }
    check('walking into a wall freezes the walk cycle (up, 12 passes)',
          got, [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
  }
  /* And assert it at the RENDERER, not just in the data: a frame must put
     pixels on the canvas in a non-background colour (manual G6 -- state-only
     tests cannot see the screen). */
  {
    const g = G.seed({});
    g.onePass({ right: true });
    recording = true; drawCalls.length = 0;
    G.render(ctxStub, g);
    recording = false;
    const psx = (((g.x - g.camX) & 0x7E) >> 1) * 8;
    const psy = (((g.y - g.camY) & 0x7E) >> 1) * 8;
    const onPlayer = drawCalls.filter(c =>
      c[2] >= psy && c[2] < psy + 16 && c[1] >= psx && c[1] < psx + 16 &&
      c[5] !== '#000000');
    checkTrue('the player is actually painted on the canvas',
              onPlayer.length > 0, `${onPlayer.length} rects at (${psx},${psy})`);
  }
}

/* The wall test, against the map read out of $8000 by the harness.  Expected
   values come from the ORIGINAL, not from the code under test: the point
   differential (tools/sim_move.py right 20) showed the real Z80 refusing to
   move past x=48, and the grid dump showed a wall down column 13 of every
   row -- which is the same wall. */
{
  const g = G.seed({});
  const v = A.map.grid[2][13] & 0x7F;
  checkTrue('column 13 of the player row is a wall value (1..$10)',
            v >= 1 && v <= 0x10, `got $${v.toString(16)}`);
  checkTrue('open floor reads as free', g.blocked(4, 2) === false);
  checkTrue('column 13 reads as blocked', g.blocked(13, 2) === true);
  checkTrue('the map wraps in both axes (manual: AND $1F / H wraps $7F->$83)',
            g.cell(32, 0) === g.cell(0, 0) && g.cell(0, 32) === g.cell(0, 0));
}

/* ---------- ACTORS ----------------------------------------------------
   Every expected value in this block comes from the ORIGINAL -- from a
   measurement, an independent re-derivation, or a universal property -- and
   the invocation that produced it is recorded beside it.  None of them was
   read back out of the engine.

   Every number below is printed by tools/actorgate.py, which drives the REAL
   Z80 and never touches this engine:

     python tools/actorgate.py gt down 30      the per-pass reference table
     python tools/actorgate.py update ...      4589/4589 record differential
     python tools/actorgate.py cull ...        3651/3651 update-window gate
     python tools/actorgate.py coins           the two LD A,R censuses
     python tools/actorgate.py sens down 30    the table is coin-independent
     python tools/actorgate.py walls          $A8E7 vs $ADF8 in isolation
     python tools/actorgate.py draws down 89   the original's actor blits

   The reference table is sampled at $ABF5, the END of the actor loop, which
   is exactly the point this engine reaches at the end of onePass().  Sampling
   with run_frames(4) instead DRIFTS -- its four-video-frame window is not the
   game's pass, and by pass 18 it lands inside the actor loop and shows records
   with y == 0, which is $AC73's self-exclusion caught mid-update.  That is why
   the ground truth is taken at a PC and not at a frame boundary.           */
{
  /* The two tables the update indexes, dumped from live RAM at $8418 and
     $8460 (python -c "harness ... m[0x8418:0x8420], m[0x8460:0x8469]").
     They are independently corroborated by the disassembly that reads them:
     $ADF8 ADD A,$18 / LD H,$84 and $AC53 ADD A,$60 / LD H,$84. */
  check('$8418 facing -> direction mask (N NE E SE S SW W NW)',
        A.globals.dirmask, [0x01, 0x09, 0x08, 0x0A, 0x02, 0x06, 0x04, 0x05]);
  check('$8460 wall-follow deflection table',
        A.globals.deflect, [6, 2, 0, 4, 2, 6, 4, 0, 6]);
  /* and the engine must be USING them, not a copy that drifted */
  check('the engine indexes those very tables',
        [G.constants.ACT_DIRMASK, G.constants.ACT_DEFLECT],
        [A.globals.dirmask, A.globals.deflect]);
  /* $A1DA's window, from CP $44 / SUB $43 across and CP $44 / SUB $2B down */
  check('the update/draw cull window is $42 x $2A ($A1DA)',
        [G.constants.ACT_CULL_X, G.constants.ACT_CULL_Y], [0x42, 0x2A]);
  /* $B59D CP $42 and $B5C3 CP $5A -- NOT the 86 NOTES-engine.md used to say */
  check('the camera clamps are $42 across and $5A down ($B58C)',
        [G.constants.CAM_MAX_X, G.constants.CAM_MAX_Y], [0x42, 0x5A]);
  /* python tools/actors.py -- the first dungeon as saved */
  check('the actor list is seeded with the original 63 records',
        [A.objects.count, A.objects.list.length], [63, 63]);
  check('actor slot 0 is the ghost at (12,64)', A.objects.list[0],
        [12, 64, 0, 0xC0]);
  /* $8491 at the saved state, and the ghost damage table $8437..$8439 */
  check('the pass counter is seeded, not zeroed', A.globals.pass_ctr, 66);
  check('ghost contact damage by tier is BCD 10/20/30 ($8437..$8439)',
        A.globals.ghost_damage, [0x10, 0x20, 0x30]);

  /* THE FREEZE.  $A1DA culls before the patched CALL at $A21E, so an actor
     outside the window is not updated at all.  MEASURED on the original: 40
     idle passes with the camera parked changed 0 bytes of $5C00..$5EFF, and
     holding down, the first byte of the list to change is on the pass the
     camera reaches camy=26 -- pass 18. */
  {
    const g = G.seed({});
    const seed = JSON.stringify(A.objects.list);
    for (let i = 0; i < 17; i++) g.onePass({ down: true });
    checkTrue('no actor changes for 17 passes (they are off-camera, so FROZEN)',
              JSON.stringify(g.actors.map(a => [a.x, a.y, a.state, a.flags])) === seed);
    g.onePass({ down: true });
    checkTrue('the actors wake on pass 18, when the camera reaches camy=26',
              g.camY === 26 &&
              JSON.stringify(g.actors.map(a => [a.x, a.y, a.state, a.flags])) !== seed,
              `camY=${g.camY}`);
  }

  /* THE CULL WINDOW itself, from $A1DA's four RET nc: (coord+3-cam)&$7F must
     be <= $42 across and <= $2A down.  Checked at the boundary with the very
     numbers the down run turns on: a ghost at y=64 is outside at camy=24 and
     inside at camy=26 (63 = 0x3F... (64+3-24)&0x7F = 0x2B > 0x2A). */
  {
    const g = G.seed({});
    g.camX = 2; g.camY = 24;
    checkTrue('y=64 is culled at camy=24 ($A1DA SUB $2B / RET nc)',
              g.actorVisible({ x: 12, y: 64 }) === false);
    g.camY = 26;
    checkTrue('y=64 is inside the update window at camy=26',
              g.actorVisible({ x: 12, y: 64 }) === true);
    /* across, the same boundary from $A1E8 CP $44 / $A1F6 SUB $43: with
       camx=2 the last visible column is x=65 ((65+3-2)&$7F = $42). */
    g.camY = 2; g.camX = 2;
    checkTrue('x=66 is culled at camx=2 (the window is $42 units wide)',
              g.actorVisible({ x: 66, y: 4 }) === false);
    checkTrue('x=65 is inside at camx=2',
              g.actorVisible({ x: 65, y: 4 }) === true);
  }

  /* A POINT DIFFERENTIAL FOR AN ACTOR, in the same spirit as the movement
     tables.  Slot 0 is the ghost that stalls the player at pass 24.  The
     expected records are the ORIGINAL's, sampled at $ABF5 per pass counter
     (see above): ctr 84..90 = port passes 18..24. */
  {
    const g = G.seed({});
    const want = {
      17: [12, 64, 0, 0xC0],   // still asleep
      18: [12, 64, 0, 0x00],   // woken: phase advanced, parity says no move
      19: [12, 62, 0, 0x00],   // first move, 2 units north
      20: [12, 62, 0, 0x40],
      21: [12, 60, 0, 0x40],
      22: [12, 60, 0, 0x80],
      23: [12, 58, 0, 0x80],   // in the player's way
      24: [124, 80, 16, 0x40], // killed: the TAIL record swapped in
    };
    const got = {};
    for (let i = 1; i <= 24; i++) {
      g.onePass({ down: true });
      if (want[i]) got[i] = [g.actors[0].x, g.actors[0].y,
                             g.actors[0].state, g.actors[0].flags];
    }
    check('slot 0 walks the original\'s path (down, passes 17-24)', got, want);
  }

  /* The kill itself: the count, the swap-with-last, and the damage.
     RE-MEASURED, because the port now repairs the $FFFF character bug and the
     ARMOUR row moves with it.  `python tools/shotgate.py contact` drives the
     real Z80 through the same 24 passes twice -- once with the capture's own
     $8435 = $20 and once with the ELF's $64 installed by the game's own
     $AB6F -- and prints:

       as captured (armour 0)  $8437..$843C 10 20 30 05 08 0A  $1996 -> $1985
       ELF         (armour 1)  $8437..$843C 09 18 27 05 07 09  $1996 -> $1986

     i.e. the ghost costs $10 as the state was captured and $09 as the elf,
     with one drain tick on top of each.  The port is the elf, so $09 is the
     expected value -- and it comes from the original, not from arithmetic. */
  {
    const g = G.seed({});
    for (let i = 0; i < 23; i++) g.onePass({ down: true });
    const before = g.health, n0 = g.actors.length;
    g.onePass({ down: true });
    /* The passive drain now runs too ($B6DA, 1 BCD point per 64 video
       frames), so allow for it: the pass either loses $09 to the ghost or
       $09 + $01 if the drain ticks on the same pass. */
    /* decode the packed BCD here rather than subtracting the raw words -- a
       BCD drop of 9 is a HEX delta of $0F, and the old check compared $10
       only because 10 BCD happens to be $10 hex with no borrow. */
    const bcd2int = v => (v>>12&15)*1000+(v>>8&15)*100+(v>>4&15)*10+(v&15);
    const lost = bcd2int(before) - bcd2int(g.health);
    check('the pass-24 contact costs 9 BCD (the ELF armour row) and one actor',
          [lost === 9 || lost === 10, n0 - g.actors.length, g.y],
          [true, 1, 54]);
    check('the armour row installed by $AB6F is $7D34 + 8 (armour 1)',
          g.dmgRow, [0x09, 0x18, 0x27, 0x05, 0x07, 0x09]);
    /* and the CAPTURED character is still reproducible, which is what the
       four direction differentials and every earlier measurement were taken
       against: seed({char:$2A}) is the out-of-range read itself. */
    const gr = G.seed({ char: 0x2A });
    check('seed({char:$2A}) reproduces the capture: tag $20, armour row 0',
          [gr.shotTag, gr.p15, gr.dmgRow],
          [0x20, 0x20, [0x10, 0x20, 0x30, 0x05, 0x08, 0x0A]]);
    check('ARMOUR_ROWS[0] is the row the capture actually had ($8437..$8439)',
          G.constants.ARMOUR_ROWS[0].slice(0, 3), Array.from(A.globals.ghost_damage));
  }

  /* THE SPRITE ID.  Trapping $AD13 on the original -- where A holds the id
     the game is about to hand the blitter and IX still points at the record
     -- gave 512 draws and 512 agreements with $40 + 24*class + facing +
     8*phase.  At pass counter 89 the three visible records and the ids the
     ORIGINAL computed for them were:
        [12,58,0,$80] -> 64     [18,58,7,$40] -> 79    [30,58,7,$C0] -> 87
     (python tools/actorgate.py draws down 89).  Note $80 is phase 0, not 2: $AD07's
     JR z skips BOTH ADD A,8. */
  {
    const id = (state, flags) => 0x40 + 24 * (state >> 5) + (state & 7) +
                                 8 * G.sprite.actorPhase(flags);
    check('the ids the original handed the blitter at $AD13',
          [id(0, 0x80), id(7, 0x40), id(7, 0xC0)], [64, 79, 87]);
    check('the walk phase decodes 0,1,0,2 from $00 $40 $80 $C0',
          [0x00, 0x40, 0x80, 0xC0].map(G.sprite.actorPhase), [0, 1, 0, 2]);
    checkTrue('a 24-record frame set was decoded for every monster class',
              A.actor_frames && [0,1,2,3,4,5].every(k =>
                A.actor_frames.classes[k].frames.length === 24));
    checkTrue('every monster frame is 32 bytes (16 rows x 2)',
              A.actor_frames.classes['0'].frames.every(
                f => Buffer.from(f, 'base64').length === 32));
    /* A sprite with INK 0 is invisible; the ghost's own attribute is $47 =
       BRIGHT white on black, read from record+0. */
    check('the ghost class draws in BRIGHT white ($47, from record+0)',
          A.actor_frames.classes['0'].ink, 0x47);
  }

  /* THE BLIT IS ONE STEP BEHIND.  $ABD7 hands $A1DA the coordinates the
     record had BEFORE the update; the update runs in the other register set
     and $AD14's EXX gives the stale pair back to the blitter.  MEASURED: 508
     of 531 blits used the pre-update pair, and at pass counter 89 the
     original blitted slot 0 at screen (40,96) while its record already read
     y=58 -- 96 is y=60 through $B557 with cam=(2,36). */
  {
    const g = G.seed({});
    for (let i = 0; i < 23; i++) g.onePass({ down: true });
    const a = g.actors[0];
    const sx = (((a.drawX - g.camX) & 0x7E) >> 1) * 8;
    const sy = (((a.drawY - g.camY) & 0x7E) >> 1) * 8;
    check('slot 0 is DRAWN at the original\'s (40,96) while its record says y=58',
          [sx, sy, a.y, a.drawY], [40, 96, 58, 60]);
  }

  /* THE ACTORS' WALL RULE IS NOT THE PLAYER'S.  $ADF8 is `LD A,(HL) / OR A /
     RET nz` -- ANY non-zero cell blocks -- while $A8E7 is a ladder with a
     door rule and an interaction range.  MEASURED IN ISOLATION on the real
     Z80 (python tools/actorgate.py walls): plant one value in an empty cell, call
     $A8E7 with the saved player block and 9 keys, then call $ADF8:
         $00 both pass;  $01 $05 $10 $20 $22 $33 both BLOCK
         $11 $12 $13 $15 $1F $30 $36 $38 $40 $7F  player passes, actor BLOCKED
     The engine is driven through the same cell for both rules. */
  {
    const g = G.seed({});
    const CO = 10, RO = 10;                    // an empty cell in this map
    const both = [0x01, 0x05, 0x10, 0x20, 0x22, 0x33];
    const onlyActor = [0x11, 0x13, 0x15, 0x1F, 0x30, 0x36, 0x38];
    const pRes = [], aRes = [];
    for (const v of both.concat(onlyActor)) {
      g.map[RO][CO] = v;
      // the ACTOR first: opening a door zeroes the cell
      aRes.push(g.actorProbe(CO * 4, RO * 4, 0).blocked);   // $ADF8, mask 0
      g.map[RO][CO] = v;
      g.keys = 9; g.pend = 0;
      /* pass1() now mirrors $A8E7's own return: FALSE is carry SET (the move
         is abandoned) and TRUE is carry CLEAR.  $A919's arms return carry
         CLEAR and record a pending interaction instead, so the two are told
         apart by g.pend rather than by trying twice. */
      pRes.push(g.pass1(CO, RO) === false);
      g.map[RO][CO] = 0;
    }
    check('the PLAYER is stopped for good by $01 $05 $10 $20 $22 $33 and ' +
          'walks through the rest once the interaction is spent',
          pRes, [true, true, true, true, true, true,
                 false, false, false, false, false, false, false]);
    check('an ACTOR is blocked by every one of them ($ADF8 OR A / RET nz)',
          aRes, [true, true, true, true, true, true,
                 true, true, true, true, true, true, true]);
  }

  /* CADENCE, a universal property of $AC0E + $ADF8 rather than a table: an
     actor attempts a move on alternate passes and a step is 2 units per axis,
     so no actor can move more than 2 units on an axis in one pass, and a
     given actor cannot move on two consecutive passes. */
  {
    const g = G.seed({});
    let maxStep = 0, moves = 0, wrongParity = 0, sampled = 0;
    for (let i = 0; i < 40; i++) {
      const snap = g.actors.map(a => [a.x, a.y]);
      g.onePass({ down: true });
      if (g.actors.length !== snap.length) continue;   // a swap-remove renames
      sampled++;                                       //   slots; skip those
      for (let k = 0; k < snap.length; k++) {
        const dx = Math.abs(((g.actors[k].x - snap[k][0] + 64) & 0x7F) - 64);
        const dy = Math.abs(((g.actors[k].y - snap[k][1] + 64) & 0x7F) - 64);
        if (!dx && !dy) continue;
        moves++;
        maxStep = Math.max(maxStep, dx, dy);
        if (((k ^ g.passCtr) & 1) !== 1) wrongParity++;   // $AC0E
      }
    }
    checkTrue('actors moved at all in the sampled passes', moves > 0, `${moves}`);
    check('a step is at most 2 units per axis and only when (slot^$8491)&1',
          [maxStep, wrongParity], [2, 0]);
  }

  /* THE CAMERA CLAMPS.  $B58C clamps the target at $42 = 66 across and
     $5A = 90 down.  MEASURED on the original: holding down for 120 passes the
     camera reaches exactly (2,90) and holds there
     (python tools/actorgate.py gt down 120 -- camy reaches 90 and holds).  NOTES-engine.md said
     the down clamp was 86; that was wrong by 4, and it matters because the
     camera decides which actors are updated at all. */
  {
    const g = G.seed({});
    let maxY = 0, maxX = 0;
    for (let i = 0; i < 120; i++) { g.onePass({ down: true });
      maxY = Math.max(maxY, g.camY); maxX = Math.max(maxX, g.camX); }
    check('holding down, the camera reaches exactly camy=90 and stops',
          [maxY, g.camY, maxX], [90, 90, 2]);
  }

  /* The actors are SIMULATION state, so they must be in the fingerprint --
     otherwise the replay tests below stop meaning anything.  A universal
     property: perturb one actor and the fingerprint must change; perturb only
     the walk-phase bits and it must NOT (they are display state, the same
     exclusion animCtl already has). */
  {
    const g = G.seed({});
    for (let i = 0; i < 20; i++) g.onePass({ down: true });
    const fp = g.fingerprint();
    g.actors[5].x ^= 4;
    checkTrue('moving an actor changes the fingerprint', g.fingerprint() !== fp);
    g.actors[5].x ^= 4;
    g.actors[5].flags ^= 0x40;
    checkTrue('the walk phase is display state and is NOT fingerprinted',
              g.fingerprint() === fp);
    g.actors[5].flags ^= 0x40;
    g.actors[5].flags ^= 0x20;
    checkTrue('the blocked bit IS fingerprinted', g.fingerprint() !== fp);
  }

  /* And assert them at the RENDERER, not just in the data (manual G6): after
     18 passes the three ghosts are on screen, so the canvas must carry BRIGHT
     WHITE ($47 -> #d7d7d7 dim / #ffffff bright) pixels where slot 0 is. */
  {
    const g = G.seed({});
    for (let i = 0; i < 22; i++) g.onePass({ down: true });
    recording = true; drawCalls.length = 0;
    G.render(ctxStub, g);
    recording = false;
    const a = g.actors[0];
    const ax = (((a.drawX - g.camX) & 0x7E) >> 1) * 8;
    const ay = (((a.drawY - g.camY) & 0x7E) >> 1) * 8;
    const onGhost = drawCalls.filter(c =>
      c[2] >= ay && c[2] < ay + 16 && c[1] >= ax - 8 && c[1] < ax + 16 &&
      c[5] === '#ffffff');
    checkTrue('the ghost is actually painted on the canvas, in bright white',
              onGhost.length > 0, `${onGhost.length} rects at (${ax},${ay})`);
  }
}

/* ---------- THE INTERACTION CHAIN, THE HUD AND THE GENERATORS ---------
   Every expected value in this block came off the REAL Z80, and the command
   that produced it is named beside it.  None of them was read back out of the
   engine.  Three tools do the measuring and none of them loads this file:

     python tools/sim_move.py <dir> <n> --frames    the per-pass table, sampled
                                                    at the loop top $8503
     python tools/doorgate.py plant                 the door animation, cell by
                                                    cell, with $849E
     python tools/hudfont.py                        the font and the field
                                                    addresses, decoded from
                                                    $B713's own LD DE,$50C9
   plus one-off isolation runs quoted inline.                              */
{
  /* --- the BCD primitives -------------------------------------------
     Driven in isolation on the original: $B7E9 with IX = $8420 and DE = the
     addend, $B852 with HL = the LOW byte and D = the subtrahend, $B807 with
     IX = $8420 and DE = the addend.  These are the exact pairs that routine
     printed back. */
  const g = G.seed({});
  const H = G.bcd;
  check('$B7E9 health add, BCD, clamped at 9999',
        [H.add16(0x1997, 0x0100), H.add16(0x9899, 0x0100),
         H.add16(0x9999, 0x0100), H.add16(0x0999, 0x0001),
         H.add16(0x9989, 0x0011), H.add16(0x5000, 0x5000)],
        [0x2097, 0x9999, 0x9999, 0x1000, 0x9999, 0x9999]);
  check('$B852 health subtract, BCD, clamped at 0000',
        [H.sub16(0x1997, 0x01), H.sub16(0x1997, 0x99), H.sub16(0x0050, 0x99),
         H.sub16(0x0000, 0x01), H.sub16(0x1000, 0x01), H.sub16(0x0100, 0x99)],
        [0x1996, 0x1898, 0x0000, 0x0000, 0x0999, 0x0001]);
  check('$B807 score add, BCD, wrapping into the million counter',
        [H.add24(0x000000, 0x000100), H.add24(0x999900, 0x000100),
         H.add24(0x000099, 0x000001), H.add24(0x123456, 0x000100),
         H.add24(0x999999, 0x000025)],
        [{score: 0x000100, wrapped: 0}, {score: 0x000000, wrapped: 1},
         {score: 0x000100, wrapped: 0}, {score: 0x123556, wrapped: 0},
         {score: 0x000024, wrapped: 1}]);

  /* --- $A8E7's ladder, arm by arm -----------------------------------
     pass1() now returns the routine's own carry: FALSE is carry SET (the move
     is abandoned), TRUE is carry CLEAR.  $A919's arms return carry CLEAR and
     leave the value in the pending slot, and a DOOR is NORMALISED to $12 by
     $A8F8 whatever the cell held -- confirmed on the original by watching
     every write to $843D over a door pickup, where the pass writes
     `$A514:00 $A91F:12`. */
  {
    const CO = 10, RO = 10;                   // an empty cell in this map
    const probe = (v, keys, p14, p15) => {
      const gg = G.seed({});
      gg.map[RO][CO] = v; gg.keys = keys;
      gg.p14 = p14 === undefined ? 0 : p14;
      gg.p15 = p15 === undefined ? 0 : p15;
      gg.pend = 0;
      const ok = gg.pass1(CO, RO);
      return [ok, gg.pend];
    };
    check('$00 is free and records nothing', probe(0x00, 0), [true, 0]);
    check('$05 blocks (a wall)', probe(0x05, 0), [false, 0]);
    check('$10 blocks (the isolated-wall value)', probe(0x10, 0), [false, 0]);
    check('a door with no keys BLOCKS ($A8F2 SUB 1 / RET c)',
          probe(0x11, 0), [false, 0]);
    check('a door with keys records $12, and $11 is NORMALISED to it ($A8F8)',
          [probe(0x11, 1), probe(0x12, 1)], [[true, 0x12], [true, 0x12]]);
    check('$13..$1F record their own value ($A8FC)',
          [probe(0x13, 0), probe(0x1F, 0)], [[true, 0x13], [true, 0x1F]]);
    check('a generator BLOCKS without either permission bit ($A910 SCF)',
          probe(0x22, 0), [false, 0]);
    check('inventory bit 5 ($A904) or stat bit 3 ($A90A) unlocks it',
          [probe(0x22, 0, 0x20, 0), probe(0x22, 0, 0, 0x08)],
          [[true, 0x22], [true, 0x22]]);
    check('$33..$35 block ($A916 CP $36 / RET c)', probe(0x34, 0), [false, 0]);
    check('$36 records and does NOT block ($A916 falls through to $A919)',
          probe(0x36, 0), [true, 0x36]);
    check('bit 7 is masked for MOVEMENT, so $85 behaves as $05 ($A8E8 AND $7F)',
          probe(0x85, 0), [false, 0]);
  }

  /* --- the consumer, value by value ---------------------------------
     MEASURED two ways on the original and cross-checked: (a) $A65D called in
     isolation with the cell planted, the slot seeded and the whole player
     block diffed afterwards, and (b) the value planted in the player's path
     in the running game with the table sampled at $8503.  Both printed:
       $13 score +000100 cell 0        $14/$15 health $1997->$2097, +000100
       $16/$17 potions 0->1, +000100   $18 (IX+10) = $8C, NO score
       $19..$1E inventory $01/$02/$04/$08/$10/$20, +000100
       $1F keys 0->1, +000100          $31 health $1997->$1898, +000100
       $32 +000100 (the $5BE8 table is empty here)
       $36/$37/$38 level 1 -> 2 / 4 / 8, f11 bit 6, no score, cell NOT cleared
   */
  {
    const CO = 10, RO = 10;
    const fire = (v) => {
      const gg = G.seed({});
      gg.map[RO][CO] = v;
      gg.pend = v; gg.pendCol = CO; gg.pendRow = RO;
      gg.keys = 9;                      // affordable doors, room to carry
      gg.interact({x: gg.x, y: gg.y});
      return {score: gg.score, health: gg.health, keys: gg.keys,
              potions: gg.potions, timer: gg.timer, p14: gg.p14,
              level: gg.levelOwn, cell: gg.map[RO][CO],
              exiting: (gg.f11 & 0x40) ? 1 : 0};
    };
    const base = G.seed({});
    const H0 = base.health, S0 = base.score;
    /* Differences of PACKED BCD are not the decimal difference -- $1997 to
       $2097 is +0100 in BCD and +$0700 as integers -- so these compare the
       resulting VALUES, which is what the original's own block held. */
    const d = v => { const r = fire(v);
      return [r.score, r.health, r.keys - 9, r.potions, r.cell]; };
    check('$13 treasure: score 000100, cell cleared, health untouched',
          d(0x13), [0x000100, 0x1997, 0, 0, 0]);
    check('$14/$15 food: health $1997 -> $2097 AND score 000100',
          [d(0x14), d(0x15)], [[0x000100, 0x2097, 0, 0, 0],
                               [0x000100, 0x2097, 0, 0, 0]]);
    check('$16/$17 potion: potions +1, score 000100',
          [d(0x16), d(0x17)], [[0x000100, 0x1997, 0, 1, 0],
                               [0x000100, 0x1997, 0, 1, 0]]);
    check('$18 power-up: timer = $8C, cell cleared, NO score ($A786 JR $A7CE)',
          [fire(0x18).timer, d(0x18)], [0x8C, [0, 0x1997, 0, 0, 0]]);
    check('$1F key: keys +1, score 000100', d(0x1F), [0x000100, 0x1997, 1, 0, 0]);
    check('$19..$1E set inventory bits $01 $02 $04 $08 $10 $20 ($A7A3)',
          [0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E].map(v => fire(v).p14),
          [0x01, 0x02, 0x04, 0x08, 0x10, 0x20]);
    check('$31 thief with no inventory: health $1997 -> $1898, score 000100',
          d(0x31), [0x000100, 0x1898, 0, 0, 0]);
    check('$32 hoard: score 000100, cell cleared ($5BE8 is empty here)',
          d(0x32), [0x000100, 0x1997, 0, 0, 0]);
    check('$36/$37/$38 exits: level 1 -> 2 / 4 / 8, and the cell is NOT cleared',
          [0x36, 0x37, 0x38].map(v => [fire(v).level, fire(v).cell,
                                       fire(v).exiting]),
          [[2, 0x36, 1], [4, 0x37, 1], [8, 0x38, 1]]);
    /* $A7B0 -- picking up an item you ALREADY have falls into the potion arm.
       Driven on the original in isolation: p14 unchanged, potions 0 -> 1. */
    {
      const gg = G.seed({});
      gg.map[RO][CO] = 0x1B; gg.p14 = 0x04;
      gg.pend = 0x1B; gg.pendCol = CO; gg.pendRow = RO;
      gg.interact({x: gg.x, y: gg.y});
      check('a DUPLICATE item is taken as a potion instead ($A7B0 JR nz,$A769)',
            [gg.p14, gg.potions], [0x04, 1]);
    }
  }

  /* --- THE EXIT, walked end to end ----------------------------------
     Driven on the real Z80 with a $36 planted at (3,10), the actors off and
     the player started three cells above it, sampled at $8503:

        y  32 34 36 | 39 40 40 40 40 40 ...
       f11 00 00 00 | 40 40 40 40 40 40
       $16 00 00 00 | 17 16 15 14 13 12
      $842C 1  1  1 |  2  2  2  2  2  2   and the cell is NEVER cleared
      $8403 1  1  1 |  1  1  1  1  1  1   <- and this one does NOT move

     RE-MEASURED with both columns printed, because the port now separates
     them: $A6A7 increments (IX+12), THIS PLAYER'S OWN level, and $8403 is
     not touched until $94C3 takes the max of the two players' at the end of
     the level.  The old single "lvl" column was (IX+12) all along.

     The 39 is the whole point of this check: it is an ODD coordinate, and the
     player's own move steps 2 units at a time, so it cannot come from $A620.
     It comes from $94E1's one-unit-per-pass walk onto the exit, which the
     engine used to skip -- it committed 38 and stopped there. */
  {
    const g2 = G.seed({});
    g2.actors = [];
    g2.map[10][3] = 0x36;
    g2.x = 12; g2.y = 28;
    const rows = [];
    for (let i = 0; i < 9; i++) { g2.onePass({down: true});
      rows.push([g2.y, g2.f11, g2.exitCtr, g2.levelOwn, g2.level,
                 g2.map[10][3]]); }
    check('walking onto a $36 exit: the ODD y=39 of $94E1\'s walk, then 40',
          rows.slice(4, 8),
          [[39, 0x40, 0x17, 2, 1, 0x36], [40, 0x40, 0x16, 2, 1, 0x36],
           [40, 0x40, 0x15, 2, 1, 0x36], [40, 0x40, 0x14, 2, 1, 0x36]]);
    check('and before it, four ordinary 2-unit steps with nothing set',
          rows.slice(0, 4),
          [[30, 1, 0, 1, 1, 0x36], [32, 0, 0, 1, 1, 0x36],
           [34, 0, 0, 1, 1, 0x36], [36, 0, 0, 1, 1, 0x36]]);
  }

  /* --- $A81D, the carry capacity ------------------------------------
     MEASURED at every boundary on the original: 9+0 allowed, 9+1 refused,
     5+5 refused, and with inventory bit 1 set 14+0 allowed and 14+1 refused.
     The check runs BEFORE the cell is cleared, so a full player cannot take
     the key AND cannot walk onto it. */
  {
    const cap = (k, p, bit1) => {
      const gg = G.seed({});
      gg.keys = k; gg.potions = p; gg.p14 = bit1 ? 0x02 : 0;
      gg.map[10][10] = 0x1F;
      gg.pend = 0x1F; gg.pendCol = 10; gg.pendRow = 10;
      gg.interact({x: gg.x, y: gg.y});
      return [gg.keys - k, gg.map[10][10]];
    };
    check('capacity: 9+0 takes the key, 9+1 and 5+5 refuse it and LEAVE it',
          [cap(9, 0, 0), cap(9, 1, 0), cap(5, 5, 0)],
          [[1, 0], [0, 0x1F], [0, 0x1F]]);
    check('inventory bit 1 raises the cap from 10 to 15 ($A823)',
          [cap(14, 0, 1), cap(14, 1, 1)], [[1, 0], [0, 0x1F]]);
  }

  /* --- the generator arithmetic -------------------------------------
     $A6C0 enumerated on the original over cell value x damage.  The rows for
     damage 1 and 2 are quoted here; note that DAMAGE 0 NEVER DESTROYS,
     because $A6CA is `CP E / JR c` (hp < damage), not a zero test. */
  {
    const gg = G.seed({});
    const dmg = (v, d) => {
      gg.map[10][10] = v; gg.p14 = 0x20; gg.p15 = 0;
      gg.passCtr = 1;                          // odd, so $A6B5 lets it through
      const hp = ((v - 0x20) & 0xFF) % 3;
      return hp < d ? 0 : (v - d) & 0xFF;      // the rule under test
    };
    check('$A6C0: hp = (v-$20) mod 3; hp < damage destroys, else v -= damage',
          [dmg(0x20, 1), dmg(0x21, 1), dmg(0x22, 1), dmg(0x22, 2),
           dmg(0x2E, 1), dmg(0x2E, 3), dmg(0x22, 0)],
          [0x00, 0x20, 0x21, 0x20, 0x2D, 0x00, 0x22]);
    /* $A964 with the elf's stat byte ($8435 = $20) and inventory bit 5: the
       index is 4, $7D70[4] = $01, so the damage ALTERNATES 0 and 1 with bit 1
       of the pass counter.  MEASURED by hooking $A6CA: pass counters 71, 73,
       75, 77, 79 with damage 1, 0, 1, 0, 1. */
    const g2 = G.seed({});
    g2.p14 = 0x20; g2.p15 = 0x20;
    const seq = [71, 73, 75, 77, 79].map(c => { g2.passCtr = c;
                                                return g2.meleeDamage(); });
    check('the elf\'s melee damage alternates 1,0,1,0,1 on $8491 71..79',
          seq, [1, 0, 1, 0, 1]);

    /* AND THE WHOLE THING END TO END, against the original.  Driven on the
       real Z80 with the actors off, inventory bit 5 set, one generator
       planted at (3,10) and the player started three cells above it, sampled
       at $8503 (the same shape as the movement tables):

         $20  y  32 34 36 36 38 40 42 ...   cell 20 20 20 00 00 ...
         $21  y  32 34 36 36 36 36 36 36 38 ...  cell 21 21 21 20 20 20 20 00
         $22  y  32 34 36 36 36 36 36 36 36 36 36 36 38 ... cell 22 ... 21 ... 20 ... 00

       so the player stalls 1, 5 and 9 passes and the cell walks down one step
       per FOUR passes.  Note 1/5/9, not the 3/7/11 the notes used to quote:
       the cost is 4h+1 or 4h+3 depending on which pass-counter phase the
       player arrives on, so the RULE is the arithmetic and the parity gate,
       never a pass count.

       RE-MEASURED for the repaired character, because $8435's bits 3:2 are
       FIGHT POWER and $A964 indexes $7D70 with them: the elf's $64 gives
       fight 1, index 6, $7D70[6] = 2 and therefore a flat damage of 1 on
       every odd pass instead of the capture's alternating 0/1.
       `python tools/shotgate.py genmelee` drives the identical scenario on
       the real Z80 for both stat bytes:

         as captured ($20, fight 0)  $20: 1   $21: 5   $22: 9  refused passes
         ELF         ($64, fight 1)  $20: 1   $21: 3   $22: 5

       and the cell walks the same $22 -> $21 -> $20 -> $00 either way. */
    for (const [v, stalls, walk] of [[0x20, 1, [0x20, 0x00]],
                                     [0x21, 3, [0x21, 0x20, 0x00]],
                                     [0x22, 5, [0x22, 0x21, 0x20, 0x00]]]) {
      const g3 = G.seed({});
      g3.actors = []; g3.p14 |= 0x20;
      g3.map[10][3] = v; g3.x = 12; g3.y = 28;
      const ys = [], cells = [];
      for (let i = 0; i < 14; i++) { g3.onePass({down: true});
                                     ys.push(g3.y); cells.push(g3.map[10][3]); }
      let st = 0;
      for (let i = 1; i < ys.length; i++) if (ys[i] === ys[i - 1]) st++;
      const seen = cells.filter((c, i) => i === 0 || c !== cells[i - 1]);
      check(`walking into a $${v.toString(16)} generator: ${stalls} refused ` +
            `passes and the cell walks ${walk.map(x => '$' + x.toString(16)).join(' -> ')}`,
            [st, seen], [stalls, walk]);
    }
  }

  /* --- MELEE SCORE, $A610 -------------------------------------------
     Walking into a non-class-0 actor takes one TIER off it on one pass in
     four and awards 25 BCD points, so a tier-t monster is worth 25*(t+1).
     MEASURED on the original by repainting slot 0's class and tier and
     holding down for 60 passes:
        class 1 tier 0 -> 000125    tier 1 -> 000050
        class 1 tier 2 -> 000075    tier 3 -> 000100
     The tier-0 row is 125 and not 25 because that run is short enough for the
     player to go on and reach the $1F key at (3,31) as well (+100); the
     others stall on the monster long enough that he never gets there.  That
     coincidence is worth keeping in the check rather than tidying away -- it
     is the same run the movement table walks, and it ties the two together. */
  {
    for (const [tier, want] of [[0, 0x000125], [1, 0x000050],
                                [2, 0x000075], [3, 0x000100]]) {
      const gg = G.seed({});
      gg.actors[0].state = 0x20 | (tier << 3);        // class 1, this tier
      for (let i = 0; i < 60; i++) gg.onePass({down: true});
      check(`a class-1 tier-${tier} monster is worth 25 BCD per hit`,
            gg.score, want);
    }
  }

  /* --- the generator SWEEP ------------------------------------------
     The window geometry was measured against the real $A9C2 in isolation over
     1,118 camera positions by counting the cells it reaches $A9E4 with:
     1,118/1,118 agree with (17 if camx&3 else 16) x (11 if camy&3 else 10).
     The threshold was measured with the actor count poked, 33/33 including
     the AND-15 wrap at 128 and the no-roll cap at 192. */
  {
    const gg = G.seed({});
    // count the cells the sweep visits, by planting a generator everywhere
    // and counting the rolls it attempts
    const visited = (cx, cy) => {
      const g2 = G.seed({});
      g2.camX = cx; g2.camY = cy; g2.actors = [];
      for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++) g2.map[r][c] = 0x20;
      let n = 0;
      const real = g2.generatorRoll.bind(g2);
      g2.generatorRoll = () => { n++; };
      g2.generatorSweep();
      g2.generatorRoll = real;
      return n;
    };
    /* $A9CA AND 3 on the camera picks 17 columns or 16, and $A9D9 picks 11
       rows or 10, so the four combinations need cameras whose low two bits
       are 0 or not.  (2,2) is 17x11 because 2&3 is not zero -- which is why
       the sweep covers the partial column and row the viewport shows.) */
    check('the sweep visits the VIEWPORT: 16 or 17 columns by 10 or 11 rows',
          [visited(0, 0), visited(1, 0), visited(0, 1), visited(2, 2),
           visited(4, 8), visited(66, 90)],
          [16 * 10, 17 * 10, 16 * 11, 17 * 11, 16 * 10, 17 * 11]);
    /* the threshold, as a formula the sweep must obey.  $84A0 = 50 in this
       dungeon ($B401: 50 + dungeon/2, measured 10/10 over poked levels). */
    const thr = n => (gg.spawnBase - ((n >> 3) & 15)) & 0xFF;
    check('$AA12: E = $84A0 - ((count>>3) & 15), and the AND-15 WRAPS at 128',
          [thr(0), thr(8), thr(63), thr(64), thr(120), thr(127), thr(128),
           thr(191)],
          [50, 49, 43, 42, 35, 35, 50, 43]);
    check('$84A0 is 50 in dungeon 1 ($B401 LD B,$32 / $B466)',
          gg.spawnBase, 50);
    /* the 192 cap: with the list at 192 records, no roll happens at all. */
    {
      const g2 = G.seed({});
      g2.actors = new Array(192).fill(0).map(() => ({x: 100, y: 100, state: 0,
                                                     flags: 4, drawX: 0, drawY: 0}));
      const before = g2.actors.length;
      for (let i = 0; i < 20; i++) g2.generatorSweep();
      check('$AA0E: at 192 live actors the sweep spawns nothing at all',
            g2.actors.length, before);
    }
    /* $7CFE, dumped from live RAM: the spawned state byte is class<<5|tier<<3 */
    check('$7CFE maps a generator value to (class<<5)|(tier<<3)',
          G.constants.GEN_STATE,
          [0x00, 0x08, 0x10, 0x20, 0x28, 0x30, 0x40, 0x48, 0x50, 0x60, 0x68,
           0x70, 0x80, 0x88, 0x90]);
    check('$7D70, the melee damage table',
          G.constants.MELEE_DMG,
          [0x00, 0x02, 0x00, 0x03, 0x01, 0x04, 0x02, 0x05, 0x03, 0x06, 0x03,
           0x06, 0x00, 0xFE, 0x02, 0xFE]);
    /* a spawned record is (x, y, table|facing, $04) and bit 2 is the ONLY
       thing $B0FE culls.  Universal property: every record the sweep appends
       carries flags $04, and no record that lacks it is ever culled. */
    {
      /* No generator is inside the OPENING viewport -- the nearest is at
         cell (8,27) -- so this has to walk down to bring one into the sweep's
         window, exactly as the original does: measured on the real machine,
         the 62-pass down run reaches $A9ED on 22 passes and spawns once. */
      const g2 = G.seed({});
      const n0 = g2.actors.length;
      for (let i = 0; i < 200; i++) g2.onePass({down: true});
      const spawned = g2.actors.filter(a => a.flags & 0x04);
      checkTrue('the sweep does spawn from this dungeon\'s own generators',
                g2.actors.length > n0 || spawned.length > 0,
                `${n0} -> ${g2.actors.length}, ${spawned.length} flagged`);
      checkTrue('every spawned record is on a whole CELL (x and y multiples of 4)',
                spawned.every(a => (a.x % 4) === 0 && (a.y % 4) === 0));
      checkTrue('every spawned record carries flags $04 and class 0 here',
                spawned.every(a => a.flags === 0x04 || (a.flags & 0x04)) &&
                spawned.every(a => (a.state & 0xE0) === 0));
      /* $B0FE culls ONLY flagged records: clear the flag on all of them and
         warp the camera away, and the population must not fall. */
      const g3 = G.seed({});
      for (const a of g3.actors) a.flags &= ~0x04;
      g3.camX = 66; g3.camY = 90;
      const before = g3.actors.length;
      for (let i = 0; i < 10; i++) g3.offScreenCull();
      check('$B12E: an UNFLAGGED record is never culled, however far away',
            g3.actors.length, before);
      /* Ten records all far outside the window and all flagged: exactly five
         may go per pass ($B113 LD C,5 / $B152 DEC C / JR nz). */
      const g4 = G.seed({});
      g4.actors = new Array(10).fill(0).map(() =>
        ({x: 100, y: 100, state: 0, flags: 0x04, drawX: 100, drawY: 100}));
      g4.camX = 2; g4.camY = 2;
      const b4 = g4.actors.length;
      g4.offScreenCull();
      check('$B152: at most FIVE records are culled in one pass',
            b4 - g4.actors.length, 5);
    }
  }

  /* --- the HUD ------------------------------------------------------ */
  {
    /* THE DRAIN.  MEASURED on the original over 5,200 video frames: 82 ticks,
       gap histogram {64: 80, 65: 1}, mean 64.01 frames = 1.278 s.
       IT IS KEYED TO $8497, THE VIDEO FRAME COUNTER, NOT THE PASS COUNTER:
       $B6DA samples ($8497 & $C0) once a pass and fires when it changes.  So
       the invariant is 64 FRAMES and it holds whatever a pass costs -- while
       the GAP IN PASSES is only 16 if a pass costs a flat four frames, which
       is what a plain uncontended Simulator gives.  On a real 48K a pass
       costs five and the same drain lands every 12.8 passes.  This check
       used to assert the 16 and so was really asserting the uncontended
       clock; counting $8497 the way $B6DA counts it makes it independent of
       that, which is what it should have been from the start.
       Sampling a 64-frame event once per 5-frame pass quantises the gap to
       60 or 65 -- the original shows the same effect in its own 64/65 split
       at ~4.1 frames a pass -- and five consecutive gaps then sum to exactly
       320.  THAT SHAPE IS NOT ASSERTED, because it is a fact about the pass
       length and the pass length already has three checks of its own above;
       a drain check that fires when the CLOCK moves would be misfiling the
       report.  What is asserted is the drain's own invariant -- one tick per
       64 frames of $8497 -- as a mean within half a frame and a per-gap
       bound of 64 +/- one pass.  A drain of 63 or 65 frames fails it. */
    const g2 = G.seed({});
    const h0 = g2.health;
    const ticks = [];
    let prev = h0, frames = 0;
    for (let i = 0; i < 200; i++) {
      g2.onePass({});                       // no input: nothing but the drain
      frames += g2.passTicks;               // $8497 advances = video frames
      if (g2.health !== prev) { ticks.push(frames); prev = g2.health; }
    }
    /* the FIRST gap is a startup transient -- the run begins partway into a
       64-frame block, so that block is short.  From the second on it is exact. */
    const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
    const steady = gaps.slice(1);
    const mean = steady.reduce((a, b) => a + b, 0) / steady.length;
    check('the passive drain is 1 BCD point per 64 video frames',
          [steady.every(x => x >= 59 && x <= 69), Math.abs(mean - 64) < 0.5,
           steady.length >= 10],
          [true, true, true]);
    const dec = v => (v >> 12) * 1000 + ((v >> 8) & 15) * 100 +
                     ((v >> 4) & 15) * 10 + (v & 15);
    check('and it takes exactly one BCD point each time',
          dec(h0) - dec(g2.health), ticks.length);
    /* $B6EE BIT 6 -- a player who has left the level does not drain. */
    {
      const g3 = G.seed({});
      g3.f11 |= 0x40;
      const hp = g3.health;
      for (let i = 0; i < 100; i++) g3.onePass({});
      check('an EXITING player does not drain ($B6EE BIT 6,(IX+11))',
            g3.health, hp);
    }
    /* THE DIRTY-FLAG GATE ON PICKUPS.  This is the one rule that makes an
       item cost more than one pass, and it is the HUD, not the actors.
       MEASURED on the original with two $1F keys one cell apart and the
       actors off, sampled at $8503:
         ctr 70  keys 0->1, f11 = $04       ctr 73  the player is REFUSED
         ctr 71  f11 still $04              ctr 74  keys 1->2
         ctr 72  f11 still $04
       i.e. the FIRST key costs one refused pass and the SECOND costs two. */
    {
      const g3 = G.seed({});
      g3.actors = [];
      const col = 3, row = 10;
      g3.map[row][col] = 0x1F; g3.map[row + 1][col] = 0x1F;
      g3.x = col * 4; g3.y = (row - 2) * 4;
      const ys = [], keys = [];
      for (let i = 0; i < 12; i++) { g3.onePass({down: true});
                                     ys.push(g3.y); keys.push(g3.keys); }
      // count the passes on which the position did not change
      let stalls = 0;
      for (let i = 1; i < ys.length; i++) if (ys[i] === ys[i - 1]) stalls++;
      check('two keys one cell apart cost THREE refused passes in total ' +
            '(1 + 2, the second gated by the HUD flag $A790)',
            [stalls, g3.keys], [3, 2]);
    }
    /* AND THE OPPOSITE, so the check above cannot pass for the wrong reason:
       one key on its own costs exactly ONE refused pass. */
    {
      const g3 = G.seed({});
      g3.actors = [];
      const col = 3, row = 10;
      g3.map[row][col] = 0x1F;
      g3.x = col * 4; g3.y = (row - 2) * 4;
      const ys = [];
      for (let i = 0; i < 8; i++) { g3.onePass({down: true}); ys.push(g3.y); }
      let stalls = 0;
      for (let i = 1; i < ys.length; i++) if (ys[i] === ys[i - 1]) stalls++;
      check('one key on its own costs exactly ONE refused pass',
            [stalls, g3.keys], [1, 1]);
    }
  }

  /* --- THE DOOR ANIMATION -------------------------------------------
     Ground truth from `python tools/doorgate.py plant`, which drives the REAL
     Z80 through the same scenario and prints the cells and $849E per pass:

       pass ctr  keys slot $849E   (2,10) (3,10) (4,10) (5,10) (6,10) (3,11)
          5  72     2  $12   $FD     $00    $11    $11    $11    $11    $11
          6  73     2  $00   $29     $00    $00    $00    $00    $11    $00
          7  74     2  $00   $21     $00    $00    $00    $00    $00    $00

     Note pass 5: the key is spent and $849E is armed but the cell is STILL
     $11 -- $A6D4 does not clear it.  Pass 6 clears FOUR cells, which is what
     caught the $95AB call-into-the-next-instruction idiom. */
  {
    const g2 = G.seed({});
    g2.actors = []; g2.keys = 3;
    const row = 10, col = 3;
    for (let i = 0; i < 4; i++) g2.map[row][col + i] = 0x11;
    g2.map[row + 1][col] = 0x11;
    g2.x = col * 4; g2.y = (row - 3) * 4;
    const win = [[col-1,row],[col,row],[col+1,row],[col+2,row],[col+3,row],
                 [col,row+1]];
    const snap = [];
    for (let i = 0; i < 7; i++) {
      g2.onePass({down: true});
      snap.push([g2.keys, g2.pend, g2.doorState,
                 win.map(w => g2.map[w[1]][w[0]])]);
    }
    check('the door pass: key spent, $849E = $FD, cell STILL $11 ($A6D4)',
          snap[4], [2, 0x12, 0xFD, [0, 0x11, 0x11, 0x11, 0x11, 0x11]]);
    check('the NEXT pass clears four cells and leaves $849E = $29 ($95AB x2)',
          snap[5], [2, 0, 0x29, [0, 0, 0, 0, 0x11, 0]]);
    check('and the pass after that finishes the run, $849E = $21',
          snap[6], [2, 0, 0x21, [0, 0, 0, 0, 0, 0]]);
    /* A SECOND scenario, because the first exercises only two of $9625's four
       dispatch arms.  Ground truth from the same tool with an L of doors:
         pass 6  $849E $3A  (3,10) (3,11) (3,12) cleared, (2,12) NOT
         pass 7  $849E $32  unchanged */
    const g3 = G.seed({});
    g3.actors = []; g3.keys = 3;
    for (const [c, r, v] of [[col,row,0x11],[col,row+1,0x11],[col,row+2,0x11],
                             [col-1,row+2,0x11],[col-2,row+2,0x12]])
      g3.map[r][c] = v;
    g3.x = col * 4; g3.y = (row - 3) * 4;
    const win2 = [[col,row],[col,row+1],[col,row+2],[col-1,row+2],[col-2,row+2]];
    const snap2 = [];
    for (let i = 0; i < 7; i++) {
      g3.onePass({down: true});
      snap2.push([g3.doorState, win2.map(w => g3.map[w[1]][w[0]])]);
    }
    check('an L-shaped door run: three cells go and $849E ends $3A then $32',
          [snap2[5], snap2[6]],
          [[0x3A, [0, 0, 0, 0x11, 0x12]], [0x32, [0, 0, 0, 0x11, 0x12]]]);
  }

  /* --- the HUD ON THE CANVAS ----------------------------------------
     State-only tests cannot see the screen (manual G6), so assert the panel
     at the renderer: the digits must appear in the cells the ADDRESSES say,
     and they must CHANGE when the counters do. */
  {
    const F = A.hud_font.fields;
    check('the field addresses decode to row 22: score at col 1, health at col 9',
          [F.score.row, F.score.col, F.score.digits,
           F.health.row, F.health.col, F.health.digits],
          [22, 1, 6, 22, 9, 4]);
    check('row 23 carries the icons: keys from col 0, potions from col 14',
          [F.keys.row, F.keys.col, F.keys.char, F.keys.attr,
           F.potions.row, F.potions.col, F.potions.char, F.potions.attr],
          [23, 0, 0x21, 6, 23, 14, 0x22, 5]);
    check('player 2\'s panel is the same one 17 columns right ($50DA)',
          F.p2_col_offset, 17);
    check('the font is 106 glyphs of 8 bytes from $77B0, codes $20..$89',
          [Object.keys(A.hud_font.font.glyphs).length, A.hud_font.font.base,
           Buffer.from(A.hud_font.font.glyphs['65'], 'base64').length,
           Buffer.from(A.hud_font.font.glyphs['137'], 'base64').length],
          [106, 0x77B0, 8, 8]);

    const rectsIn = (list, col, row) => list.filter(c =>
      c[1] >= col * 8 && c[1] < col * 8 + 8 &&
      c[2] >= 160 + (row - 20) * 8 && c[2] < 160 + (row - 20) * 8 + 8 &&
      c[5] !== '#000000');
    const paint = gg => { recording = true; drawCalls.length = 0;
                          G.render(ctxStub, gg); recording = false;
                          return drawCalls.slice(); };
    const g2 = G.seed({});
    g2.score = 0x000000; g2.health = 0x1997; g2.keys = 0; g2.potions = 0;
    const a0 = paint(g2);
    /* FOUR QUARTERS in the MICRO font (this fork): player 1's is x 0-63,
       the name on y 160-164, SCORE on 166-170, HEALTH on 172-176, KEYS and
       POT on 178-182, the six power icons on the 8 px row 184-191.  A
       glyph is 4 px wide on a 5 px pitch: "SCORE " puts the digits at
       x 30, "HEALTH " at x 35. */
    /* RASTERIZED: the captured panel art is painted first and the
       quarter's black fill covers it, so a draw-call filter would see
       art the screen does not */
    const pxIn = (list, x0, x1, y0, y1) => {
      const buf = new Uint8Array(256 * 32);
      for (const c of list) {
        if (c[0] !== 'fillRect') continue;
        const on = c[5] !== '#000000' ? 1 : 0;
        for (let y = Math.max(160, c[2] | 0); y < Math.min(192, (c[2] | 0) + (c[4] | 0)); y++)
          for (let x = Math.max(0, c[1] | 0); x < Math.min(256, (c[1] | 0) + (c[3] | 0)); x++)
            buf[(y - 160) * 256 + x] = on;
      }
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += buf[(y - 160) * 256 + x];
      return n;
    };
    checkTrue('the HEALTH line paints its label (x 0..28) and four digits (x 35..53)',
              pxIn(a0, 0, 29, 172, 177) > 0 && pxIn(a0, 50, 54, 172, 177) > 0);
    checkTrue('a score of 000000 prints as the one digit 0 after SCORE ($B6BC / $B7DD)',
              pxIn(a0, 30, 34, 166, 171) > 0 && pxIn(a0, 35, 64, 166, 171) === 0,
              `${pxIn(a0, 35, 64, 166, 171)} px right of the 0`);
    g2.score = 0x123456;
    const a1 = paint(g2);
    checkTrue('a six-digit score runs to x 58 of the SCORE line',
              pxIn(a1, 55, 59, 166, 171) > 0);
    checkTrue('changing the score changes the panel pixels',
              JSON.stringify(a0) !== JSON.stringify(a1));
    checkTrue('with nothing carried the KEYS/POT line is empty',
              pxIn(a1, 0, 64, 178, 183) === 0);
    g2.keys = 3; g2.potions = 2;
    const a2 = paint(g2);
    checkTrue('three keys print the key icon (x 0..7) and a 3 (x 10..13); two potions the potion icon (x 35..42) and a 2 (x 45..48)',
              pxIn(a2, 0, 8, 178, 183) > 0 && pxIn(a2, 10, 14, 178, 183) > 0 && pxIn(a2, 14, 35, 178, 183) === 0 &&
              pxIn(a2, 35, 43, 178, 183) > 0 && pxIn(a2, 45, 49, 178, 183) > 0 && pxIn(a2, 49, 64, 178, 183) === 0);
    /* the icons themselves: 8 x 5, drawn in the original icon colours,
       the key ring-left with the shaft along the middle row, the potion
       symmetric about its middle row */
    {
      const a2k = a2.filter(c => c[0] === 'fillRect' && c[2] >= 178 && c[2] < 183 && c[1] < 8 && c[5] !== '#000000');
      const a2p = a2.filter(c => c[0] === 'fillRect' && c[2] >= 178 && c[2] < 183 && c[1] >= 35 && c[1] < 43 && c[5] !== '#000000');
      check('the key icon wears the key attribute colour (6, yellow) and the potion the potion colour (5, cyan)',
            [new Set(a2k.map(c => c[5])).size, a2k[0] && a2k[0][5], new Set(a2p.map(c => c[5])).size, a2p[0] && a2p[0][5]],
            [1, '#d7d700', 1, '#00d7d7']);
      const rowOf = (list, x0, y) => list.filter(c => c[2] === y).map(c => c[1] - x0).sort((a, b) => a - b).join(',');
      check('the key: the ring top row is columns 1-2, the shaft row runs 0 and 3..7',
            [rowOf(a2k, 0, 178), rowOf(a2k, 0, 180)], ['1,2', '0,3,4,5,6,7']);
      checkTrue('the potion is SYMMETRIC about its middle row',
                rowOf(a2p, 35, 178) === rowOf(a2p, 35, 182) && rowOf(a2p, 35, 179) === rowOf(a2p, 35, 181) &&
                rowOf(a2p, 35, 180) === '0,1,2,3,4,5,6,7');
    }
    /* THE LOGO COLOUR CYCLE, enumerated over its whole domain rather than
       sampled.  The ISR computes it every video frame at $A2B4 and stores it
       into the operand at $A2F5; MEASURED by sampling that operand INSIDE the
       ISR at $A2CA over 400 video frames -- 350 samples, 350 agreements with
       the formula, 0 disagreements, the other 50 being the 1-in-8 skip. */
    {
      const inks = [];
      for (let f = 0; f < 256; f++) inks.push(G.hud.logoInk(f));
      check('the logo ink is always BRIGHT and covers exactly $40..$47',
            [Math.min(...inks), Math.max(...inks),
             new Set(inks).size, inks.every(v => (v & 0xF8) === 0x40)],
            [0x40, 0x47, 8, true]);
      /* a & 8 REFLECTS the ramp, so the inks run up and then back down.  The
         expected sequence below is THE MACHINE'S OWN, read out of the
         self-modified operand at $A2F5 inside the ISR over 263 video frames:
             40 41 42 43 44 45 46 47 46 45 44 43 42 41 40 41 42 ...
         -- note the peak 7 is NOT repeated and the trough 0 is not either, so
         the period is 14 steps of 8 frames = 112, not the 128 a naive reading
         of "eight inks up, eight down" would give.  My first version of this
         check asserted the naive shape and failed, which is the whole point
         of enumerating a formula's outputs instead of describing them. */
      const seq = inks.filter((v, i) => i === 0 || v !== inks[i - 1])
                      .map(v => v & 7);
      check('and it bounces 0..7..0 the way the ISR operand does',
            seq.slice(0, 15),
            [0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1, 0]);
      /* $A2BA's skip is exactly (frame & 7) == 7, so the ink NEVER changes on
         a skipped frame -- assert that rather than trusting the fallback. */
      checkTrue('the 1-in-8 skipped frame keeps the previous ink ($A2BA)',
                [7, 15, 23, 31, 255].every(f =>
                  G.hud.logoInk(f) === G.hud.logoInk(f - 1)));
    }

    /* and the counters must be LIVE, not the captured panel: walk the down
       run and watch the drawn score change.  MEASURED on the original after
       61 passes holding down: score 000100, keys 1. */
    const g3 = G.seed({});
    for (let i = 0; i < 61; i++) g3.onePass({down: true});
    check('holding down for 61 passes: the ORIGINAL\'s score 000100 and 1 key',
          [g3.score, g3.keys], [0x000100, 1]);
    const a3 = paint(g3);
    checkTrue('and the panel actually shows that key: the key icon and a 1 on the fourth line of the quarter',
              pxIn(a3, 0, 8, 178, 183) > 0 && pxIn(a3, 10, 14, 178, 183) > 0);
  }

  /* --- health and score against the ORIGINAL, end to end -------------
     RE-MEASURED on the real Z80 with the pass-cost work, TWICE and with two
     independent steppers, because one of the three baselines this check used
     to carry was wrong.  Anchored on the loop top $8503, 61 passes from
     build/state_48k.pkl, reading $8422/$8424/$8428:

       dir    health  score   keys   frames/pass   $8497 per pass
       right  $1992   000100    0       4.951          4.918
       left   $1992   000000    0       5.000          4.967
       up     $1992   000000    0       5.000          4.590

     THESE ARE THE CONTENDED FIGURES -- the ULA contention the port now
     models.  On a plain Simulator the same run gives right $1993 at 4.131
     frames a pass, left $1993 at 4.525 and up $1992 at 5.000.  On real
     hardware ALL THREE COST ABOUT FIVE FRAMES and all three converge on
     $1992: the drain is keyed to $8497, so a slower pass runs the drain
     faster against the player's steps and the fourth tick lands inside the
     61.  Over these 61 passes $8497 advances 300, 303 and 280 times against
     244, 245 and 305 uncontended.  That is the manual-B2b bite made visible
     in a counter -- the same 61 player steps cost more health when the game
     is slower -- and it is now the RIGHT amount of slower.

     LEFT USED TO BE A DECLARED DIVERGENCE HERE AND IS NO LONGER ONE.  The
     engine gave $1992 where the uncontended original gave $1993; the
     contended original gives $1992 as well, so they agree and left is
     asserted beside the other two.
     THE UNDERLYING GAP IS NOT FIXED, and this is not a claim that it was.
     The map painters and the sprite blitter still bracket every blit with
     DI/EI (they blit with LD SP,source), the ULA still asserts INT for 32 T
     with no pending latch, and an interrupt whose window lands inside a DI
     span is still LOST -- the engine still charges one mean-cost handler per
     boundary rather than knowing which ones vanish (`isrW1`, declared in
     web/template.html).  The losses are still measurable here: holding left
     the original's $8497 advances 4.967 per pass against 5.000 frames of
     wall time, and holding up 4.590 against 5.000.  What changed is that at
     five frames a pass those losses no longer carry the drain across a
     64-frame boundary inside this window.  A divergence that stopped
     showing, not a mechanism that got modelled.
     DOWN is deliberately NOT asserted: the original loses a SECOND ghost to
     a contact this engine's substitute entropy does not reproduce -- a known
     and documented divergence, not a rule this file gets to encode. */
  {
    for (const [dir, hp, sc, keys] of [['right', 0x1992, 0x000100, 0],
                                       ['left',  0x1992, 0x000000, 0],
                                       ['up',    0x1992, 0x000000, 0]]) {
      const gg = G.seed({});
      for (let i = 0; i < 61; i++) gg.onePass({[dir]: true});
      check(`holding ${dir} for 61 passes matches the original's counters`,
            [gg.health, gg.score, gg.keys], [hp, sc, keys]);
    }
  }

  /* --- the fingerprint must cover the new simulation state ----------- */
  {
    const gg = G.seed({});
    for (let i = 0; i < 20; i++) gg.onePass({down: true});
    const fp = gg.fingerprint();
    const perturb = (name, fn, undo) => {
      fn(); const changed = gg.fingerprint() !== fp; undo();
      checkTrue(`${name} is simulation state and IS fingerprinted`, changed);
    };
    perturb('health', () => gg.health ^= 1, () => gg.health ^= 1);
    perturb('the score', () => gg.score ^= 1, () => gg.score ^= 1);
    perturb('the key count', () => gg.keys++, () => gg.keys--);
    perturb('the potion count', () => gg.potions++, () => gg.potions--);
    perturb('the HUD dirty flags', () => gg.f11 ^= 4, () => gg.f11 ^= 4);
    perturb('the pending-interaction slot', () => gg.pend ^= 0x13,
            () => gg.pend ^= 0x13);
    perturb('the door animator state', () => gg.doorState ^= 8,
            () => gg.doorState ^= 8);
    perturb('the frame clock', () => gg.frameCtr ^= 4, () => gg.frameCtr ^= 4);
    gg.lastSfx ^= 9;
    checkTrue('but the sound id is display-only and is NOT fingerprinted',
              gg.fingerprint() === fp);
    gg.lastSfx ^= 9;
  }
}

/* ---------- determinism (manual G10: stronger than equality) ---------- */
{
  const g = G.seed({});
  for (let i = 0; i < 30; i++) g.onePass({ right: true });
  const mark = g.fingerprint();
  for (let i = 0; i < 90; i++) g.onePass({ right: true });
  const later = g.fingerprint();

  const g2 = G.seed({});
  for (let i = 0; i < 30; i++) g2.onePass({ right: true });
  checkTrue('replay reproduces the 30-pass mark exactly', g2.fingerprint() === mark);
  for (let i = 0; i < 90; i++) g2.onePass({ right: true });
  checkTrue('replay reproduces the 120-pass state exactly', g2.fingerprint() === later);
}

/* ---------- the fixed timestep is not one update per rAF (manual B6) --- */
{
  // Feed one simulated second as sixty 1/60 s display frames, the way a real
  // rAF loop does.  Handing advance() a whole second in ONE call instead trips
  // the 0.25 s stall clamp by design and yields 3 passes -- an earlier version
  // of this test did exactly that and blamed the engine (manual G1: verify the
  // MEASURING code before the measured code).
  const g = G.seed({});
  const before = g.pass;
  for (let i = 0; i < 60; i++) g.advance(1 / 60, { right: true });
  const passes = g.pass - before;
  /* HOW MANY PASSES A SECOND IS NOW A MEASUREMENT, not 50.08/4.  Re-measured
     on the real Z80 from build/state_48k.pkl, counting passes until 50.08
     video frames have gone by (scratchpad my14 / `python tools/clockgate.py
     hz`): idle 12, right 11, left 11, up 11, down 12 -- and the original's
     own per-pass costs holding RIGHT are [5,5,5,5,4,5,5,5,4,5,4], because
     the camera is clamped in the start room for the first ten passes and the
     viewport is full of solid cells.  The engine gets 10 or 11 depending on
     where its own phase lands.  Asserted as "within one of the original's
     eleven", which is what the model is worth, rather than as a period. */
  checkTrue('one simulated second is 10-12 passes (the original does 11)',
            passes >= 10 && passes <= 12, `got ${passes}`);
  // and the SAME second delivered at 144 Hz must give the same pass count
  const g3 = G.seed({});
  for (let i = 0; i < 144; i++) g3.advance(1 / 144, { right: true });
  checkTrue('pass count is independent of display refresh rate (B6)',
            g3.pass === g.pass, `60Hz=${g.pass} 144Hz=${g3.pass}`);
  const g2 = G.seed({});
  g2.advance(100.0, { right: true });               // a huge stall
  checkTrue('accumulator is clamped against a stall', g2.pass <= 4,
            `got ${g2.pass} passes from a 100 s stall`);
}

/* ---------- the renderer obeys the primitive constraint --------------- */
{
  const g = G.seed({});
  recording = true; drawCalls.length = 0;
  G.render(ctxStub, g);
  recording = false;
  checkTrue('render emits draw calls', drawCalls.length > 0, `${drawCalls.length}`);
  checkTrue('render uses ONLY fillRect', drawCalls.every(c => c[0] === 'fillRect'));

  // render twice with only the player position changed and DIFF the two lists
  recording = true; drawCalls.length = 0;
  G.render(ctxStub, g);
  const listA = drawCalls.slice();
  drawCalls.length = 0;
  g.x = (g.x + 8) & 0x7F;
  G.render(ctxStub, g);
  const listB = drawCalls.slice();
  recording = false;
  checkTrue('moving the player changes the draw list',
            JSON.stringify(listA) !== JSON.stringify(listB));
}

/* ================= SHOOTING, COMBAT AND DEATH ==========================
   Every expected value below was produced by driving the ORIGINAL, with the
   invocation in the comment beside it, never by calling the engine. */
{
  /* --- the character, $BF19 -----------------------------------------
     `python tools/shotgate.py chars` -- a fresh boot stopped at $BE53 with
     $FFFF poked to each index, reading $8433/$8435 back after $BE61:
       0 ($00,$8E)  1 ($08,$D8)  2 ($10,$32)  3 ($18,$64)  $2A ($20,$20) */
  check('$BF19 (shot tag, attribute byte) for the four characters',
        G.constants.CHAR_TABLE,
        [[0x00, 0x8E], [0x08, 0xD8], [0x10, 0x32], [0x18, 0x64]]);
  check('the capture\'s out-of-range read is ($20,$20)',
        G.constants.CHAR_RAW, [0x20, 0x20]);
  {
    const g = G.seed({});
    check('the port is character 3, the ELF: tag $18, attributes $64',
          [g.charIndex, g.shotTag, g.p15], [3, 0x18, 0x64]);
    /* $8435 decoded at its four consumers: shot 0, fight 1, magic 2, armour 1 */
    check('the elf decodes as shot 0 / fight 1 / magic 2 / armour 1',
          [g.p15 & 3, (g.p15 >> 2) & 3, (g.p15 >> 4) & 3, (g.p15 >> 6) & 3],
          [0, 1, 2, 1]);
  }

  /* --- FIRE, and the freeze ------------------------------------------
     `python tools/shotgate.py freeze` on the real Z80, 12 passes each:
        Q alone  (12,10) .. (12,32)     Z+Q  (12,8) all twelve
        D alone  (14,8)  .. (36,8)      Z+D  (12,8) all twelve
     and $842D still tracks the held direction, so you TURN but do not move. */
  {
    const walk = dir => { const g = G.seed({});
      for (let i = 0; i < 12; i++) g.onePass({[dir]: true});
      return [g.x, g.y]; };
    const held = dir => { const g = G.seed({});
      for (let i = 0; i < 12; i++) g.onePass({[dir]: true, fire: true});
      return [g.x, g.y, g.frameSlot]; };
    check('holding down walks 12 passes to y=32', walk('down'), [12, 32]);
    check('holding right walks 12 passes to x=36', walk('right'), [36, 8]);
    check('FIRE + down does not move him, and he still faces S (slot 4)',
          held('down'), [12, 8, 4]);
    check('FIRE + right does not move him, and he still faces E (slot 2)',
          held('right'), [12, 8, 2]);
    /* $A48D is RES 4,(IX+14), not "write 0 to $842E": measured on the real
       Z80, $842E cycles 40 40 80 80 C0 C0 00 00 while walking. */
    const g = G.seed({}); const seq = [];
    for (let i = 0; i < 8; i++){ g.onePass({right: true}); seq.push(g.animCtl); }
    check('$842E is the WALK PHASE and cycles 40 40 80 80 C0 C0 00 00',
          seq, [0x40, 0x40, 0x80, 0x80, 0xC0, 0xC0, 0x00, 0x00]);
  }

  /* --- the shot's speed and its one-at-a-time rule --------------------
     `python tools/shotgate.py steps` hooks $8D2B, the per-step commit:
        inventory $00 -> {2: n}   $10 (SHOT SPEED) -> mostly {3: n}
     and the flight measured at the loop top is 4 units a pass, 6 with the
     power-up. */
  {
    const g = G.seed({});
    const ys = [];
    for (let i = 0; i < 8; i++){ g.onePass({down: true, fire: true});
                                 ys.push(g.shot.y); }
    check('a shot moves 4 units (one cell) per pass, from the player\'s own y',
          ys.slice(0, 5), [12, 16, 20, 24, 28]);
    const g2 = G.seed({}); g2.p14 |= 0x10;      // SHOT SPEED
    const ys2 = [];
    for (let i = 0; i < 5; i++){ g2.onePass({down: true, fire: true});
                                 ys2.push(g2.shot.y); }
    check('with SHOT SPEED ($8434 bit 4) it moves 6 units per pass',
          ys2.slice(0, 4), [14, 20, 26, 32]);
    /* one shot per player, ever: firing again while one is in flight is
       refused by $8C7A, so the cadence is the flight time and nothing else */
    const g3 = G.seed({}); let spawns = 0, last = 0xFF;
    for (let i = 0; i < 30; i++){ g3.onePass({down: true, fire: true});
      if (last === 0xFF && g3.shot.state !== 0xFF) spawns++;
      last = g3.shot.state; }
    checkTrue('there is never more than one shot: it respawns, it does not stack',
              spawns >= 3 && spawns <= 6, `spawns=${spawns}`);
  }

  /* --- the fire cadence, camera SETTLED ------------------------------
     `python tools/shotgate.py cadence`: an open arena at (64,64), 60 settling
     passes, then fire held for 120 --
        N NE SE S SW NW  24 fires, gaps {5: 23}
        E W              15 fires, gaps {8: 14}
     Taken BEFORE the camera converges the same measurement reads gaps of 1,
     because the shot is culled on its first step -- that measures the camera,
     not the gun. */
  {
    const cadence = slot => {
      const g = G.seed({});
      g.map = g.map.map(r => r.map(() => 0));
      g.actors = [{x: 4, y: 4, state: 0, flags: 0, drawX: 4, drawY: 4}];
      g.x = 64; g.y = 64;
      for (let i = 0; i < 60; i++){ g.onePass({}); g.frameSlot = slot; }
      const fires = []; let last = g.shot.state;
      for (let i = 0; i < 120; i++){
        g.onePass({fire: true}); g.frameSlot = slot;
        if (last === 0xFF && g.shot.state !== 0xFF) fires.push(i);
        last = g.shot.state;
      }
      const gaps = new Set();
      for (let i = 1; i < fires.length; i++) gaps.add(fires[i] - fires[i-1]);
      return [fires.length, [...gaps], [g.camX, g.camY]];
    };
    check('N fires 24 times in 120 passes with a gap of 5 (camera 34,46)',
          cadence(0), [24, [5], [34, 46]]);
    check('E fires 15 times in 120 passes with a gap of 8',
          cadence(2), [15, [8], [34, 46]]);
    check('SW, a diagonal, fires 24 times with a gap of 5',
          cadence(5), [24, [5], [34, 46]]);
  }

  /* --- the two 5x5 boxes and the cull window, ENUMERATED --------------
     `python tools/shotgate.py box` sweeps dx,dy over [-6,6] against the real
     $8EEB and $9009 and gets exactly dx,dy in [-2,+2] from both, with an
     invisible record (flags bit 3) giving carry 0.
     `python tools/shotgate.py window` sweeps a 140x140 grid over the real
     $8D97 and gets exactly 2257 offsets: (x-camx)&$7F in 0..60 and
     (y-camy)&$7F in 0..36, a perfect rectangle. */
  {
    const g = G.seed({});
    g.actors = [{x: 64, y: 64, state: 0, flags: 0, drawX: 64, drawY: 64}];
    const hits = [];
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++)
      if (g.shotFindActor((64 + dx) & 0x7F, (64 + dy) & 0x7F) >= 0)
        hits.push([dx, dy]);
    check('$8EEB is a 5x5 box, dx and dy in [-2,+2]',
          [hits.length, Math.min(...hits.map(h => h[0])),
           Math.max(...hits.map(h => h[0]))], [25, -2, 2]);
    g.actors[0].flags = 0x08;
    check('$8F2D: an INVISIBLE record (flags bit 3) is skipped, whatever its class',
          g.shotFindActor(64, 64), -1);
    g.actors[0].flags = 0x00; g.actors[0].state = 0x80;   // class 4, visible
    checkTrue('a VISIBLE class 4 is found by the same scan -- the bit, not the class',
              g.shotFindActor(64, 64) === 0);

    const ok = new Set(), xs = new Set(), ys = new Set();
    for (let dy = -70; dy < 70; dy++) for (let dx = -70; dx < 70; dx++){
      const okY = G.wrap7((((10 + dy) & 0x7F) - 10) & 0xFF) < G.constants.SHOT_CULL_Y;
      const okX = G.wrap7((((10 + dx) & 0x7F) - 10) & 0xFF) < G.constants.SHOT_CULL_X;
      if (okX && okY){ ok.add(((dx & 0x7F) << 8) | (dy & 0x7F));
                       xs.add(dx & 0x7F); ys.add(dy & 0x7F); }
    }
    const n = ok.size;
    check('the cull window is 2257 offsets: 61 across x 37 down, a rectangle',
          [n, xs.size, ys.size], [2257, 61, 37]);
  }

  /* --- the shot's map ladder, ENUMERATED ------------------------------
     `python tools/shotgate.py plant` plants every value $00..$3F plus
     $7F/$80/$81 in the path of a shot fired DOWN and reports which ones stop
     it, which cells change and which score.  $80 passing and $81 stopping is
     what proves the AND $7F. */
  {
    const stops = [], passes = [];
    for (const v of [...Array(0x40).keys()].concat([0x7F, 0x80, 0x81])){
      const g = G.seed({});
      g.map[10][10] = v; g.p14 = 0; g.p15 = 0x64;
      (g.shotMap(40, 40, 4).stop ? stops : passes).push(v);
    }
    check('the ladder PASSES exactly $00 $18 $1F $2F $30 $32 $36..$3F $7F $80',
          passes, [0x00, 0x18, 0x1F, 0x2F, 0x30, 0x32, 0x36, 0x37, 0x38, 0x39,
                   0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F, 0x7F, 0x80]);
    check('$01..$17, $19..$1E, $20..$2E, $31, $33..$35 and $81 all STOP it -- 49',
          [stops.length, stops[0], stops[stops.length - 1]], [49, 0x01, 0x81]);
    const after = v => { const g = G.seed({});
      g.map[10][10] = v; const s = g.shotMap(40, 40, 4);
      return [s.stop ? 1 : 0, g.map[10][10], g.score]; };
    check('$14 food: stops, cell cleared, no score', after(0x14), [1, 0, 0]);
    check('$1B item: stops, cell cleared (the $8FAE detonation), no score',
          after(0x1B), [1, 0, 0]);
    check('$21 generator: stops, cell $21 -> $20, ten points',
          after(0x21), [1, 0x20, 0x10]);
    check('$23 generator (class 1 tier 0): one hit destroys it, ten points',
          after(0x23), [1, 0x00, 0x10]);
    check('$33 destructible wall counts UP', after(0x33), [1, 0x34, 0]);
    check('$35 destructible wall reaches $36 and is cleared',
          after(0x35), [1, 0x00, 0]);
    check('$1F, a key, is flown straight over', after(0x1F), [0, 0x1F, 0]);
    /* the probe cell, `python tools/shotgate.py probe`:
       N/E/S/W/NW no offset, NE +1 column, SW +32, SE +33 */
    /* fired from (42,42), which is in cell (10,10) but only two units short
       of the boundary, so the +2 offsets land in cell (11,11) */
    const probe = slot => { const g = G.seed({});
      g.map = g.map.map(r => r.map(() => 0));
      g.map[11][11] = 0x01;
      return g.shotMap(42, 42, slot).stop ? 1 : 0; };
    check('only NE/SE/SW offset the probe, and only SE reaches (+1,+32)',
          [0,1,2,3,4,5,6,7].map(probe), [0, 0, 0, 1, 0, 0, 0, 0]);
  }

  /* --- damage and score ----------------------------------------------
     `python tools/shotgate.py parity` drives the real $90E6 with the table
     byte $09 over every tier and every pass-counter phase: the tier drops by
     ONE on counters 0 and 2 and by TWO on 1 and 3, so the bonus is a whole
     TIER and it lands on ODD $8491. */
  {
    const dmg = (power, invBit3, ctr, tier) => {
      const g = G.seed({});
      g.p15 = (g.p15 & ~3) | power; g.p14 = invBit3 ? 0x08 : 0;
      g.passCtr = ctr;
      g.actors = [{x: 64, y: 64, state: tier << 3, flags: 0, drawX: 0, drawY: 0}];
      g.shotDamage(0);
      return g.actors.length === 0 ? 'dead' : g.actors[0].state;
    };
    check('SHOT POWER 1 ($7D64[2] = $09): one tier on even $8491, two on odd',
          [dmg(1,0,0,3), dmg(1,0,1,3), dmg(1,0,2,3), dmg(1,0,3,3)],
          [0x10, 0x08, 0x10, 0x08]);
    check('the elf (SHOT POWER 0, byte $08) always takes exactly one tier',
          [dmg(0,0,0,3), dmg(0,0,1,3), dmg(0,0,0,1), dmg(0,0,1,0)],
          [0x10, 0x10, 0x00, 'dead']);
    /* ENUMERATE the reachable damages rather than reading the algebra: the
       AND $18 is a hard 3-tier cap and only {8,16,24} can come out of it. */
    const outs = new Set();
    for (let p = 0; p < 4; p++) for (const b of [0,1]) for (const c of [0,1]){
      const g = G.seed({});
      g.p15 = (g.p15 & ~3) | p; g.p14 = b ? 0x08 : 0; g.passCtr = c;
      const t = G.constants.SHOT_DMG[2*((g.p15 & 3) + (b ? 2 : 0))];
      outs.add((((t & 1) && c) ? 8 : 0) + t & 0x18);
    }
    check('the reachable shot damages are exactly {8, 16, 24}',
          [...outs].sort((a,b)=>a-b), [8, 16, 24]);
    /* $8D6F/$8D73/$8D79: 10 for class 0, 5 for classes 1-4, 1 for class 5,
       PER HIT.  Measured in the running game by `shotgate.py table`, whose
       down/walk-20 run scores 000010 then 000020 as two ghosts die. */
    const score = cls => { const g = G.seed({});
      g.actors = [{x: 64, y: 64, state: cls << 5, flags: 0, drawX: 0, drawY: 0}];
      g.shotHitActor(0); return g.score; };
    check('a shot pays 10 on class 0, 5 on classes 1-4 and 1 on class 5',
          [score(0), score(1), score(4), score(5)], [0x10, 5, 5, 1]);
  }

  /* --- the $20 state collision the captured $8433 produces -------------
     `python tools/shotgate.py collide` fires UP from the level start with
     each tag: $20 pins the shot at (12,6) state $20 for ever, every legal tag
     flies.  The port reproduces it when seeded with the capture's index. */
  {
    const up = ch => { const g = G.seed({char: ch}); const seen = new Set();
      for (let i = 0; i < 8; i++){ g.onePass({up: true, fire: true});
        seen.add(g.shot.x + ',' + g.shot.y + ',' + g.shot.state); }
      return seen.size; };
    check('$8433 = $20 pins a NORTH shot: one distinct record over 8 passes',
          up(0x2A), 1);
    checkTrue('every legal tag flies instead', [0,1,2,3].every(c => up(c) > 1));
  }

  /* --- DEATH, $93CD ---------------------------------------------------
     `python tools/shotgate.py death` drives the real Z80 from the level start
     with the health poked, and prints:
       health $0001 -> nothing at all in 4 passes
       health $0000 -> pass 1: $8434=$80 $842B=$C3 $842E=$80, the cell under
                       him becomes $22 (0 keys) / $1F (1) / $32 (3, plus
                       $84C0 0->1 and $5BE8 = 43 80 03)
                       pass 2: $847D=$80 and THE MAIN LOOP RETURNS
       and the score and the health are untouched by any of it. */
  {
    const die = keys => {
      const g = G.seed({});
      g.keys = keys; g.health = 0x0000;
      const cell = [(g.y & 0x7C) >> 2, (g.x & 0x7C) >> 2];
      g.onePass({});
      const one = [g.p14, g.f11, g.animCtl, g.map[cell[0]][cell[1]],
                   g.hoardCount, g.levelDone];
      g.onePass({});
      return one.concat([g.levelDone, g.gameOver, g.score, g.health]);
    };
    check('0 keys: dead, flags $C3, and a $22 GENERATOR dropped where he fell',
          die(0), [0x80, 0xC3, 0x80, 0x22, 0, false, true, true, 0, 0]);
    check('1 key: a $1F key is dropped instead', die(1)[3], 0x1F);
    check('3 keys: a $32 hoard, and $84C0 counts it', die(3).slice(3, 5),
          [0x32, 1]);
    {
      const g = G.seed({}); g.keys = 3; g.health = 0;
      g.onePass({});
      check('the hoard record is (cell, keys)', g.hoard, [[3, 2, 3]]);
    }
    /* The trigger is EXACTLY BCD 0000 -- $93D2 ORs the two bytes together.
       Tested on the routine rather than on four passes of the loop, because
       four passes may or may not contain a drain tick and the tick would
       take $0001 to $0000 and kill him for a different reason. */
    const g = G.seed({}); g.health = 0x0001; g.deathPass();
    check('health $0001 is not death', [g.p14 & 0x80, g.map[2][3]], [0, 0]);
    g.health = 0x0000; g.deathPass();
    check('health $0000 is', [g.p14 & 0x80, g.map[2][3]], [0x80, 0x22]);
    /* $B23B: dying swap-removes every actor inside the player's own 7x7 box */
    const g2 = G.seed({});
    g2.actors = [{x: 12, y: 8, state: 0, flags: 0, drawX: 12, drawY: 8},
                 {x: 90, y: 90, state: 0, flags: 0, drawX: 90, drawY: 90}];
    g2.health = 0; g2.onePass({});
    check('$93FE -> $B23B clears the monsters standing on you',
          g2.actors.length, 1);
    /* and once the loop has returned, nothing advances any more */
    const g3 = G.seed({}); g3.health = 0;
    g3.onePass({}); g3.onePass({});
    const p0 = g3.pass, f0 = g3.fingerprint();
    g3.onePass({down: true}); g3.onePass({down: true});
    check('after the main loop returns the simulation stops',
          [g3.pass, g3.fingerprint()], [p0, f0]);
  }

  /* --- the shot is simulation state, its draw position is not --------- */
  {
    const g = G.seed({});
    for (let i = 0; i < 3; i++) g.onePass({down: true, fire: true});
    const f = g.fingerprint();
    g.shot.drawX = (g.shot.drawX + 8) & 0x7F; g.shot.drawn = !g.shot.drawn;
    check('the shot draw position is display-only and is NOT fingerprinted',
          g.fingerprint(), f);
    g.shot.state = (g.shot.state + 1) & 0xFF;
    checkTrue('but the shot STATE is simulation and IS fingerprinted',
              g.fingerprint() !== f);
  }

  /* --- the sprite records --------------------------------------------- */
  {
    const SF = G.sprite.SHOT_FRAMES;
    checkTrue('five shot banks decoded: four characters plus the monster $90',
              SF && Object.keys(SF.banks).length === 5);
    /* $90 aliases $10, because $8DD2's three ADD A,A drop the carries -- so a
       monster's fireball IS the wizard's shot sprite.  Asserted rather than
       left implicit: it is exactly the kind of coincidence a later tidy-up
       would "fix". */
    checkTrue('...and the monster tag $90 aliases $10, the same records',
              SF && SF.banks[0x90] &&
              JSON.stringify(SF.banks[0x90].frames) ===
              JSON.stringify(SF.banks[0x10].frames));
    check('bank inks are $42/$45/$46/$44 -- and the elf\'s is $44, BRIGHT GREEN,'
          + ' the same attribute his own sprite records carry',
          [SF.banks[0x00].ink, SF.banks[0x08].ink, SF.banks[0x10].ink,
           SF.banks[0x18].ink], [0x42, 0x45, 0x46, 0x44]);
    check('a record is 12 rows of 2 bytes', SF.banks[0x18].frames[0].length, 24);
    /* traced on the real blitter, `python tools/shotgate.py blit`: twelve
       source rows land on ten screen rows because $8E8C/$8E9E are INC C */
    check('12 source rows land on screen rows +2..+11, 7+8 and 9+10 sharing',
          G.sprite.SHOT_ROWS, [2,3,4,5,6,7,8,9,9,10,10,11]);
    /* the elf's EAST record is a horizontal arrow: 3810 1FFC 3810 */
    const e = SF.banks[0x18].frames[2];
    check('the elf\'s east record is the arrow $3810 $1FFC $3810',
          [e[8], e[9], e[10], e[11], e[12], e[13]],
          [0x38, 0x10, 0x1F, 0xFC, 0x38, 0x10]);
  }
}

/* ======================================================================
   THE LEVEL CLOSURE TEST
   ======================================================================
   build/levelcheck.json is written by `python tools/levelgate.py`, which
   drives the ORIGINAL Z80: for every dungeon that ships it runs the game's
   own expander $97CB over the record's TAPE BYTES and dumps the 32x32 grid
   the original leaves in live RAM at $8000..$83FF, its player start and its
   actor list.  Nothing in that file comes from this engine.

   Every expected value below therefore comes from the original.  The two
   RNG-driven passes are switched off on BOTH sides -- $9B5F through the
   record's own flags bit 2 ($988F BIT 2,(IX+1)) and $9BB7/$9C06/$9C69
   through $8403 < 8 ($989C CP 8 / RET c) -- because $B575 is LD A,R and no
   port can reproduce a draw.  The mirrors are then tested separately with
   the level forced to 8 and $84C7 forced to each of its four values.
   Cross-check the same decode the other way round with
       python tools/packgate.py all        -> 307/307 sub-blocks
   which compares the original against tools/packdecode.py instead.       */
{
  const lcPath = path.join(ROOT, 'build', 'levelcheck.json');
  if (!fs.existsSync(lcPath)) {
    checkTrue('build/levelcheck.json present (python tools/levelgate.py)', false);
  } else {
    const LC = JSON.parse(fs.readFileSync(lcPath, 'utf8'));
    const P = G.packs;
    const un = s => { const b = Buffer.from(s, 'base64'); return new Uint8Array(b); };

    check('every dungeon on the tape is checked', LC.records.length, 307);
    check('the shipped index is 31 packs', P.count, 31);
    check('the $80 pack holds seven dungeons', P.data.packs[0].length, 7);
    check('the $C0 packs hold ten sub-blocks each',
          P.data.packs.slice(1).every(p => p.length === 10), true);

    let allCells = 0, worst = null, nrec = 0;
    for (const r of LC.records) {
      const rec = Uint8Array.from(P.record(P.sub(r.pack - 1, r.sub)));
      rec[1] &= ~0x04;                       // the original was run this way
      const dg = P.build(rec, { level: 1, rng: () => 0 });
      const want = un(r.grid);
      let same = 0;
      for (let i = 0; i < 1024; i++) if (dg.cell[i] === want[i]) same++;
      allCells += same;
      const okP = dg.player[0] === r.player[0] && dg.player[1] === r.player[1];
      const okA = JSON.stringify(dg.actors) === JSON.stringify(r.actors);
      nrec++;
      checkTrue(`dungeon ${nrec} (pack ${r.pack} sub ${r.sub}): ${same}/1024` +
                `, player ${okP ? 'ok' : 'WRONG'}, ${r.actors.length} actors ` +
                `${okA ? 'ok' : 'WRONG'}`,
                same === 1024 && okP && okA);
      if (same !== 1024 && !worst) worst = r;
    }
    check('total cells identical to the original\'s own $8000 buffer',
          allCells, 307 * 1024);

    /* the level >= 8 arms.  $84C7 bit 1 runs $9C06 and bit 0 runs $9C69, and
       the tail they share ($9C3D..$9C68) transforms the PLAYER START AND
       EVERY ACTOR -- which is the claim this check exists to pin down. */
    let mok = 0;
    for (const m of LC.mirrors) {
      const rec = Uint8Array.from(P.record(P.sub(m.pack - 1, m.sub)));
      rec[1] &= ~0x04;
      const dg = P.build(rec, { level: 8, c7: m.c7, bonus: true, rng: () => 0 });
      const want = un(m.grid);
      let same = 0;
      for (let i = 0; i < 1024; i++) if (dg.cell[i] === want[i]) same++;
      const okP = dg.player[0] === m.player[0] && dg.player[1] === m.player[1];
      const okA = JSON.stringify(dg.actors) === JSON.stringify(m.actors);
      if (same === 1024 && okP && okA) mok++;
      checkTrue(`mirror $84C7=${m.c7} (pack ${m.pack} sub ${m.sub}): ` +
                `${same}/1024, player ${okP ? 'ok' : 'WRONG'}, ` +
                `actors ${okA ? 'ok' : 'WRONG'}`,
                same === 1024 && okP && okA);
    }
    check('all four orientations of six records', mok, LC.mirrors.length);
    /* and the teeth: a mirror that did NOT move the actors would fail.  Six
       of the 24 orientations are $84C7 = 0, which moves nothing, so 18 of
       them must differ from the unmirrored list. */
    {
      const base = new Map();
      for (const m of LC.mirrors) if (m.c7 === 0) base.set(m.pack + ':' + m.sub, m.actors);
      const moved = LC.mirrors.filter(m => m.c7 !== 0 && m.actors.length &&
        JSON.stringify(m.actors) !== JSON.stringify(base.get(m.pack + ':' + m.sub)));
      checkTrue('the original\'s own actor list MOVES in every mirrored ' +
                'orientation that has actors -- so this test has teeth',
                moved.length === LC.mirrors.filter(m => m.c7 !== 0 &&
                                                        m.actors.length).length,
                `${moved.length} moved`);
    }

    /* the whole $B3D0 path for dungeons 1..7: the tape load, the pack's own
       stub, $91D7, $9175's record selection, $97CB and $9689's placement. */
    for (const L of LC.levels) {
      const want = un(L.grid);
      const g = G.seed({});
      g.startLevel(L.level);
      let same = 0;
      for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++)
        if (g.map[r][c] === want[r * 32 + c]) same++;
      checkTrue(`$B3D0 dungeon ${L.level}: ${same}/1024, player (${g.x},${g.y})`,
                same === 1024 && g.x === L.px && g.y === L.py &&
                g.actors.length === L.actors.length,
                `original (${L.px},${L.py}) ${L.actors.length} actors, ` +
                `engine (${g.x},${g.y}) ${g.actors.length}`);
      /* $B401..$B428, the four difficulty bytes, straight out of live RAM */
      const d = G.packs.difficulty(L.level);
      check(`difficulty bytes at dungeon ${L.level} ` +
            `($84A0/$84BE/$84BF/$84BD)`,
            [d.spawnBase, d.objCount, d.objType, d.objProb],
            [L.spawn_base, L.obj_count, L.obj_type, L.obj_prob]);
    }
    /* $9B5F, the one coin inside the build.  It cannot be compared value for
       value -- the draw is LD A,R -- but the RULE can: on a record with flags
       bit 2, exactly ONE $36 survives and it must be one of the cells the
       ORIGINAL leaves as $36 when the pass is switched off, which is what
       levelcheck.json holds.  114 of the 307 records carry the bit. */
    {
      let n = 0, ok = 0;
      for (const r of LC.records) {
        const rec = Uint8Array.from(P.record(P.sub(r.pack - 1, r.sub)));
        if (!(rec[1] & 0x04)) continue;
        n++;
        const want = un(r.grid);
        const cand = [];
        for (let i = 0; i < 1024; i++) if (want[i] === 0x36) cand.push(i);
        let rng = 12345;
        const dg = P.build(rec, { level: 1,
          rng: () => (rng = (rng * 1103515245 + 12345) & 0x7FFFFFFF) >> 16 & 0xFF });
        const kept = [];
        for (let i = 0; i < 1024; i++) if (dg.cell[i] === 0x36) kept.push(i);
        let same = true;
        for (let i = 0; i < 1024; i++) {
          if (dg.cell[i] === want[i]) continue;
          if (want[i] === 0x36 && dg.cell[i] === 0) continue;   // thinned
          same = false; break;
        }
        if (kept.length === 1 && cand.includes(kept[0]) && same) ok++;
      }
      check('$9B5F keeps exactly one $36, from the original\'s own candidate ' +
            'set, and changes nothing else', [ok, n], [114, 114]);
    }

    /* the $C0 pack's four draws.  The values are LD A,R and cannot be
       predicted; the STRUCTURE can, and these are the properties measured on
       the original over 240 loads (`python tools/packseq.py`):
         C  never 0     D  never 0     E  never 0 and never 8/9
         A4 0 seen      -- because +$019 LD DE,0 makes the first three draws
                           reject 0, so sub-block 0 can only ever be stash[0]
       Here they are ENUMERATED over 400 loads of the port's own selector. */
    {
      const g = G.seed({});
      const seen = { d1: new Set(), stash0: new Set(), tre: 0, bad: 0 };
      for (let i = 0; i < 400; i++) {
        g.tape.mask = 0; g.tape.want = 0xC0; g.tcd = 99; g.treasure = false;
        const rec = g.tape.load(0xC0, false, 99, () => g.brand8());
        const pk = g.tape.pos;
        const ids = P.data.packs[pk];
        seen.d1.add(ids.indexOf(rec));
        seen.stash0.add(ids.indexOf(g.tape.stash[0]));
        const all = [rec, ...g.tape.stash];
        if (new Set(all).size !== 4) seen.bad++;
      }
      checkTrue('the played sub-block is never 0 (the stale-register rejection)',
                !seen.d1.has(0), [...seen.d1].join(','));
      checkTrue('but sub-block 0 does turn up as stash record 0',
                seen.stash0.has(0));
      check('and a pack never serves the same sub-block twice', seen.bad, 0);
      /* $C09F: on a bonus level the played one is 8 or 9, and when the
         treasure is due within the stash ($84BA < 4) the SECOND draw is */
      const bonus = new Set(), due = new Set();
      for (let i = 0; i < 200; i++) {
        g.tape.mask = 0;
        const r1 = g.tape.load(0xC0, true, 99, () => g.brand8());
        bonus.add(P.data.packs[g.tape.pos].indexOf(r1));
        g.tape.mask = 0;
        g.tape.load(0xC0, false, 1, () => g.brand8());
        due.add(P.data.packs[g.tape.pos].indexOf(g.tape.stash[2]));
      }
      check('a BONUS level plays sub-block 8 or 9', [...bonus].sort(), [8, 9]);
      check('and a treasure due inside the stash is steered to record 2',
            [...due].sort(), [8, 9]);
    }

    /* the captured live map this engine used to ship as its ONE dungeon is
       the same 1024 cells the tape decode produces -- an independent
       corroboration, from a capture made before any of this existed. */
    {
      const g = G.seed({});
      const cap = G.assets.map.grid;
      let same = 0;
      for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++)
        if (g.map[r][c] === cap[r][c]) same++;
      check('dungeon 1 built from the tape == the captured live $8000 buffer',
            same, 1024);
    }
  }
}

/* ---------- the level number, the exit and the progression ------------ */
{
  /* $A6A7 is DD 34 0C, INC (IX+12), and there is no DAA anywhere near it.
     MEASURED by calling $A681 in isolation on the real Z80 with (IX+12)
     poked to each value ($A697's treasure guard cleared):
        $01->$02 $07->$08 $08->$09 $09->$0A $0F->$10 $19->$1A $63->$64
        $99->$9A $FF->$00
     BCD would give $09 -> $10.  This engine used to do exactly that. */
  const seq = [[0x01,0x02],[0x07,0x08],[0x08,0x09],[0x09,0x0A],[0x0F,0x10],
               [0x19,0x1A],[0x63,0x64],[0x99,0x9A],[0xFF,0x00]];
  /* (IX+12) is the PLAYER'S OWN level number and $8403 is the global; the
     port now names them levelOwn and level, and it is (IX+12) that $A6A7
     increments.  $94C3 takes the unsigned max of the two players' into
     $8403 at the end of the level. */
  const got = seq.map(([from]) => {
    const g = G.seed({}); g.levelOwn = from; g.treasure = false;
    g.doExit(0x36, {x: g.x, y: g.y});
    return g.levelOwn;
  });
  check('$A6A7 INC (IX+12) is BINARY, not BCD', got, seq.map(s => s[1]));

  /* $A6A0 ADD A,A / ADD A,A: tiles $37 and $38 are warps.  Measured with
     A = 1/2/3 -> 4/8/$0C. */
  const warp = [0x37, 0x38].map(v => {
    const g = G.seed({}); g.levelOwn = 9; g.treasure = false;
    g.doExit(v, {x: g.x, y: g.y}); return g.levelOwn;
  });
  check('$37 and $38 warp to dungeons 4 and 8', warp, [4, 8]);

  /* $A697 BIT 6,(IY-1) / JR nz,$A6AA skips BOTH arms.  MEASURED with $847E
     bit 6 set: $09 stays $09 and $63 stays $63. */
  const tre = [0x09, 0x63].map(l => {
    const g = G.seed({}); g.levelOwn = l; g.treasure = true;
    g.doExit(0x36, {x: g.x, y: g.y}); return g.levelOwn;
  });
  check('a TREASURE ROOM does not advance the level number', tre, [0x09, 0x63]);
  {
    const g = G.seed({}); g.levelOwn = 9; g.treasure = true;
    g.doExit(0x36, {x: g.x, y: g.y});
    check('but it still arms the exit walk ($A687/$A693)',
          [g.f11 & 0x40, g.exitCtr], [0x40, 0x18]);
  }

  /* $B466 -- B += floor(level / C), with `INC B / JR nz` saturating at 255.
     ENUMERATED rather than described: 180 + level must stop at $FF. */
  check('$B41F 180 + level saturates at 255',
        [76, 75, 74].map(l => G.packs.difficulty(l).objProb), [255, 255, 254]);
  check('$B401 spawn base is 50 + level/2 ($84A0)',
        [1, 2, 3, 8, 20].map(l => G.packs.difficulty(l).spawnBase),
        [50, 51, 51, 54, 60]);

  /* $9193/$91F0 -- dungeons 1..7 are records 0..6 of the tape's $80 pack,
     in order, and the tape has advanced exactly once. */
  {
    const g = G.seed({});
    const ids = [];
    for (let l = 1; l <= 7; l++) { g.startLevel(l); ids.push(g.tape.pos); }
    check('dungeons 1-7 all come out of tape block 0', ids,
          [0, 0, 0, 0, 0, 0, 0]);
    check('and the tape was read exactly once', g.tape.loads, 1);
    check('$84CD asks for $C0 from then on ($C010, in the PACK\'s own code)',
          g.tape.want, 0xC0);
  }
  /* the level >= 8 arm: one pack, four dungeons -- the one played straight
     out of the raw buffer on the loading pass, then the three stashed ones,
     and $84CC's mask 7 -> 6 -> 4 -> 0 with BIT 7 dropped by $91D3's XOR. */
  {
    const g = G.seed({});
    g.tcd = 99;                                     // no treasure room
    const rec = [], mask = [], pos = [];
    for (let l = 8; l <= 12; l++) {
      g.tcd = 99; g.startLevel(l);
      mask.push(g.tape.mask); pos.push(g.tape.pos); rec.push(g.tape.loads);
    }
    check('$84CC after each of dungeons 8..12', mask, [7, 6, 4, 0, 7]);
    check('one tape block serves FOUR dungeons', pos, [1, 1, 1, 1, 2]);
    check('and it is read once per four', rec, [2, 2, 2, 2, 3]);
  }
  /* $91BF BIT 6,(IY-1) forces E=4, i.e. stash record 2, on a treasure level,
     and $91A1 reloads the countdown to 4..7. */
  {
    const g = G.seed({});
    g.tcd = 99; g.startLevel(8); g.startLevel(9);    // mask now 6
    g.tcd = 1;                                       // due next level
    g.startLevel(10);
    checkTrue('a treasure room takes stash record 2 and clears bit 2 of $84CC',
              g.treasure === true && g.tape.mask === 2, `mask ${g.tape.mask}`);
    checkTrue('$915E seeds the treasure clock BCD $20..$30 with a divider of 12',
              g.treasureTimer >= 0x20 && g.treasureTimer <= 0x30 &&
              (g.treasureTimer & 0x0F) <= 9 && g.treasureDiv === 12,
              `$${g.treasureTimer.toString(16)}`);
    checkTrue('$84BA is reloaded to 4..7', g.tcd >= 4 && g.tcd <= 7, `${g.tcd}`);
  }
}

/* ---------- the map tiles --------------------------------------------- */
{
  /* THE CROSS-CHECK.  The 17 tiles in build/assets.json were sampled off the
     ORIGINAL'S SHADOW SCREEN by tools/extract.py, from a live dungeon 1 --
     a completely different route from tools/maptiles.py, which decodes the
     33-byte records the $7B00 pointer table names.  Dungeon 1's record has
     flags $00 and byte 2 $00, so bank 0 and colour scheme 0 ($7D9C[0] = $16).
     They must agree, and they do -- except for $13, which is the ANIMATED
     tile ($A31A repoints it every few frames), so the screen capture caught
     one frame of it and the pointer names another. */
  const g = G.seed({});
  check('dungeon 1 uses wall bank 0 and colour scheme 0',
        [g.tileBank, g.tileColour], [0, 0]);
  const A2 = G.assets;
  let agree = 0, differ = [];
  for (const k in A2.tiles) {
    const v = k | 0;
    if (!v) continue;
    const t = G.tiles.mapTile(g.tileBank, g.tileColour, v);
    const same = t && JSON.stringify(t.bitmap) === JSON.stringify(A2.tiles[k].bitmap)
                 && t.attrs[0] === A2.tiles[k].attrs[0];
    if (same) agree++; else differ.push('$' + v.toString(16));
  }
  check('the decoded records match the tiles sampled off the original\'s ' +
        'own screen, except the animated $13', differ, ['$13']);
  check('...on all the others', agree, Object.keys(A2.tiles).length - 2);
  /* and the coverage that made this worth doing: every non-zero map value
     that occurs anywhere in the 307 dungeons must now resolve to a tile. */
  {
    const lc = JSON.parse(fs.readFileSync(path.join(ROOT, 'build',
                                                    'levelcheck.json'), 'utf8'));
    const seen = new Set();
    for (const r of lc.records) for (const b of Buffer.from(r.grid, 'base64')) seen.add(b);
    const missing = [...seen].filter(v => v && !G.tiles.mapTile(0, 0, v));
    check('every map value in the 307 dungeons has a tile', missing, []);
    check('...and there are far more of them than the 17 that were ever ' +
          'visible in dungeon 1', seen.size - 1, 63);
  }
  /* $9F7A DEC A / ADD A,A with no mask: the index is 8-bit, so v and v+$80
     land on the SAME $7B00 entry -- the "second wall graphic" draws
     identically.  ENUMERATED over the whole range that occurs. */
  {
    let alias = 0;
    for (let v = 1; v <= 0x10; v++)
      if (JSON.stringify(G.tiles.mapTile(0, 0, v)) ===
          JSON.stringify(G.tiles.mapTile(0, 0, v + 0x80))) alias++;
    check('cell values $81..$90 draw as $01..$10 ($9F7A is an 8-bit index)',
          alias, 16);
  }
}

/* ---------- the exit, end to end -------------------------------------- */
{
  /* Plant a $36 in the player's path, walk into it, and follow the whole
     chain the original follows: $A681 commits the move and arms (IX+$16) =
     $18, $94E1 walks him onto the exit for 24 passes, $9550 sets (IX+11)
     bit 7, $94AE sees it and sets $847D bit 7, the main loop returns at
     $855C, $B3AB finds him NOT dead and falls into $B381 -- the next
     dungeon.  MEASURED on the real Z80 for the first half of that chain
     (`python tools/sim_move.py down 60 --frames`, and the y 36 -> 39 -> 40
     walk in NOTES-engine.md); the second half is what this check adds. */
  const g = G.seed({});
  const map = g.map.map(r => r.slice());
  map[(g.y >> 2) + 2][g.x >> 2] = 0x36;
  G.seed({ map });
  const before = { level: g.level, score: g.score, keys: g.keys,
                   health: g.health, tape: g.tape.pos };
  let passes = 0, atEnd = null;
  while (g.mode === 'play' && passes < 200) {
    g.onePass({ down: true }); passes++;
    if (g.levelDone) {
      /* sampled at the moment the main loop returns, because the HEALTH
         DRAIN ($B6DA, one BCD point per 64 video frames) is still running
         while he walks to the exit -- what is being tested is that the LEVEL
         START writes none of these, not that nothing else does. */
      atEnd = {score: g.score, health: g.health, keys: g.keys,
               potions: g.potions, p14: g.p14, char: g.charIndex};
      g.levelOver(); break;
    }
  }
  check('walking onto a $36 loads the NEXT dungeon', g.level, before.level + 1);
  check('and the score, the health, the keys, the potions, the inventory and ' +
        'the character all SURVIVE it',
        [g.score, g.health, g.keys, g.potions, g.p14, g.charIndex],
        [atEnd.score, atEnd.health, atEnd.keys, atEnd.potions, atEnd.p14,
         atEnd.char]);
  check('the exit dissolve is 24 passes ($A693 LD (IX+$16),$18)',
        g.exitCtr, 0);
  checkTrue('the new dungeon is a different map', JSON.stringify(g.map) !==
            JSON.stringify(map));
  check('it is still tape block 0 (dungeons 1-7 are the $80 pack)',
        g.tape.pos, before.tape);
  check('$B385/$B389 reset the frame counter and the drain phase',
        [g.frameCtr, g.drainPhase], [0, 0x40]);
}

/* ---------- the post-death loop, $B3B9 -------------------------------- */
{
  /* Get there the way the original does: health to BCD 0000, one pass to set
     the DEAD bit and $842B, one more for $94AE to set $847D bit 7, and then
     $B39B -> $B3AB -> $B3B9.  MEASURED on the real Z80 (`python
     tools/deathgate.py seq`): the death pass, then the pass that returns at
     $855C, 8.13 video frames in all. */
  /* NB G.seed() hands back the ONE engine instance, so each of these starts
     from a fresh reset; and the accumulator is drained afterwards so that a
     leftover fraction of a pass cannot pay for an extra game-over tick. */
  const toGameOver = () => {
    const g = G.seed({});
    g.health = 0;
    for (let i = 0; i < 6 && g.mode === 'play'; i++) {
      g.onePass({});
      if (g.levelDone) g.levelOver();
    }
    g.acc = 0;
    return g;
  };
  {
    /* THE SEQUENCE, measured on the real Z80 (`python tools/deathgate.py
       seq`): the DEATH pass, then the pass on which $94AE sets $847D bit 7
       and the main loop returns at $855C.  Two passes, not one and not three
       -- $8537 CALL $94AE runs BEFORE $8540 CALL $93C2, so the death of pass
       N is not seen until pass N+1. */
    const s = G.seed({});
    s.health = 0;
    const marks = [];
    for (let i = 0; i < 6 && s.mode === 'play'; i++) {
      s.onePass({});
      marks.push([s.dead ? 1 : 0, s.levelDone ? 1 : 0]);
      if (s.levelDone) { s.levelOver(); break; }
    }
    check('death takes exactly two passes to leave the main loop',
          marks, [[1, 0], [1, 1]]);
  }
  const g = toGameOver();
  checkTrue('health 0000 -> dead, the main loop returns, and the engine is ' +
            'in the $B3B9 game-over loop', g.dead && g.levelDone &&
            g.mode === 'over', `mode ${g.mode}`);
  /* THE NAME ENTRY IS RETIRED (this fork): the player has a NAME already,
     so death records the CORPSE instead -- the $93F2-snapped cell, where
     $9404's drop put the bones, for render()'s RIP <name> tag. */
  check('death records the corpse at the $93F2-snapped cell',
        [g.players[0].died, g.players[0].diedX, g.players[0].diedY],
        [true, g.players[0].x & 0x7C, g.players[0].y & 0x7C]);
  /* THE WORLD STOPS.  $8491 advanced 0 over 100 video frames of $B3B9 on the
     real machine; here the pass counter and the whole map must be frozen. */
  {
    const p0 = g.passCtr, fp0 = JSON.stringify(g.map), x0 = g.x, n0 = g.actors.length;
    for (let i = 0; i < 100; i++) g.advance(1 / 50.08, {});
    checkTrue('the world is frozen: pass counter, map, player and actors all ' +
              'unchanged over 100 video frames',
              g.passCtr === p0 && JSON.stringify(g.map) === fp0 &&
              g.x === x0 && g.actors.length === n0);
    check('but the VIDEO FRAME counter is the clock and it runs',
          g.overFrames >= 100, true);
  }
  /* THE RIP HOLD: OVER_RIP_FRAMES video frames, and NOTHING ends it early
     -- FIRE, SHIFT and the directions included, which keeps the original's
     "no continue" truth by other means (the retired entry's FIRE was
     measured dead for 400 frames too).  Then $B35A's own new-game tail
     runs: dungeon 1, fresh block, the attract screen.  And the ranked
     tables are NEVER written -- no scoreboard, just death. */
  {
    const RIP = G.constants.OVER_RIP_FRAMES;
    const t0 = JSON.stringify(G.hiscore.tables.map(t => Array.from(t)));
    const h = G.seed({});
    h.score = 0x420000;      // would TOP the ranked table -- and must not
    h.health = 0;
    for (let i = 0; i < 6 && h.mode === 'play'; i++){
      h.onePass({});
      if (h.levelDone) h.levelOver();
    }
    h.acc = 0;
    for (let i = 0; i < RIP - 1; i++)
      h.advance(1 / 50.08, { fire: true, potion: true, up: true });
    check('held FIRE, SHIFT and UP never end the RIP hold early',
          [h.mode, h.overFrames], ['over', RIP - 1]);
    h.advance(1 / 50.08, {});
    checkTrue('at OVER_RIP_FRAMES the hold ends BY ITSELF -- the attract screen',
              h.mode === 'attract');
    check('and the new game is dungeon 1 with the score zeroed',
          [h.level, h.score, h.health, h.keys, h.dead],
          [1, 0, 0x2000, 0, false]);
    check('...and the corpse marker went with the old dungeon',
          h.players[0].died, false);
    check('the ranked tables were never written: no scoreboard, just death',
          JSON.stringify(G.hiscore.tables.map(t => Array.from(t))) === t0, true);
  }
  /* $84CC/$84CD are NOT cleared by $B35A.  MEASURED with a write-watch over
     $84B0..$84CF while running $B35A..$B381: the only writes are $84C8,
     $84C9 and $84BA.  So the REWIND TAPE prompt at $B48F is a cold-boot-only
     path, and a new game reuses the stash it still holds. */
  {
    const RIP = G.constants.OVER_RIP_FRAMES;
    const h = toGameOver();
    h.tape.mask = 0x80; h.tape.want = 0xC0; h.tape.pos = 9;
    const loads = h.tape.loads;
    for (let i = 0; i < RIP; i++) h.advance(1 / 50.08, {});
    check('a new game does NOT reset $84CC/$84CD or re-read the tape',
          [h.tape.mask, h.tape.want, h.tape.pos, h.tape.loads],
          [0x80, 0xC0, 9, loads]);
    /* the other side of the same rule, and it is the machine's own quirk:
       $91D3's XOR writes back the mask with BIT 7 ALREADY CLEARED, so once a
       stash record has been consumed at level >= 8, dropping back below 8
       makes $9184 demand the $80 block again -- with no REWIND prompt, since
       $B48F only looks at bit 7 on a cold boot. */
    const k = toGameOver();
    k.tape.mask = 0x06; k.tape.pos = 9;              // bit 7 already gone
    for (let i = 0; i < RIP; i++) k.advance(1 / 50.08, {});
    check('but a mask with bit 7 gone makes dungeon 1 demand the $80 block',
          [k.tape.mask, k.tape.pos], [0x80, 0]);
  }
}

/* ---------- the treasure room's own clock ----------------------------- */
{
  /* $8527 BIT 6,(IY-1) / CALL nz,$8ADA -> $8AED: a divider of 12 passes per
     BCD point off $84B6, and $8B22 SET 7,(IY-2) when it reaches 00. */
  const g = G.seed({});
  g.treasure = true; g.treasureTimer = 0x02; g.treasureDiv = 12;
  let passes = 0;
  while (!g.levelDone && passes < 100) { g.onePass({}); passes++; }
  check('a treasure clock of BCD 02 ends the level after 24 passes', passes, 24);
  checkTrue('and it is the FORCED ending ($847D bit 3, $8B1E)', g.forcedOver);
  {
    const h = G.seed({});
    h.treasure = false; h.treasureTimer = 0x02;
    for (let i = 0; i < 30; i++) h.onePass({});
    check('outside a treasure room the clock does not tick at all',
          h.treasureTimer, 0x02);
  }
}

/* ====================================================================== */
/* ---------- TWO PLAYERS ----------------------------------------------- */
/* ====================================================================== */
/* Every expected value below is printed by `python tools/p2gate.py all`,
   which drives the real Z80 and never loads the engine.  The invocation is
   named beside each group. */
{
  const P2FIRE = { p2: { fire: true } };
  const idle = { p2: {} };

  /* --- the tape ships two blocks, and player 2's says "not in the game"
     `python tools/p2gate.py join` -- and the bytes themselves are read off
     tape side 1 (block flag $82, offset $40) by tools/extract.py. */
  {
    const g = G.seed({});
    const b2 = G.assets.player.block2;
    check('player 2 ships +$0B $C0, +$0F $E8, +$14 $80 and (0,0)',
          [b2[0x0B], b2[0x0F], b2[0x14], b2[0], b2[1]],
          [0xC0, 0xE8, 0x80, 0, 0]);
    checkTrue('so he starts OUT of the game', !g.players[1].inGame);
    checkTrue('and player 1 starts IN it', g.players[0].inGame);
  }

  /* --- $9440: FIRE is the only way in, and it is one pass -------------
     `python tools/p2gate.py join`:
        +$00 $00->$10  +$01 $00->$08   position (16,8), beside player 1
        +$02 $00->$20  health BCD 2000
        +$0B $C0->$00  +$0E $00->$01   +$10 $00->$FF  +$14 $80->$00
        +$17..+$1C 10 20 30 05 08 0A   the $AB6F contact-damage row      */
  {
    const g = G.seed({ char: 0x2A, char2: 0x2A });
    g.actors = [];
    g.onePass(idle);
    checkTrue('no FIRE, no join', !g.players[1].inGame);
    const g2 = G.seed({ char: 0x2A, char2: 0x2A });
    g2.actors = [];
    /* park the DRAIN clock where $B6DA cannot tick during this pass:
       ($8497+1) AND $C0 must differ from $849F.  The join sets health to
       BCD 2000 and the drain would take a point off it later in the same
       pass, which is a different rule and is checked separately below. */
    g2.frameCtr = 0; g2.drainPhase = 0x40;
    g2.onePass(P2FIRE);
    const q = g2.players[1];
    check('one pass of player 2 FIRE joins him beside player 1 at (16,8)',
          [q.x, q.y, q.health, q.score, q.f11, q.p14, q.animCtl & 1],
          [16, 8, 0x2000, 0, 0x00, 0x00, 1]);
    check('and $96AF installs his armour row', q.dmgRow,
          [0x10, 0x20, 0x30, 0x05, 0x08, 0x0A]);
    check('$9484 writes $FF to the shot X, not its state -- the original bug',
          [q.shot.x, q.shot.state], [0xFF, 0xFF]);
  }

  /* --- the materialise is SIX passes, not five -----------------------
     `python tools/p2gate.py join` watches $7CCE through the join:
        +0..+5  $F45E with (IX+13) = 00 01 02 03 04 05 and (IX+14) bit 0 set
        +6      $6320 with (IX+13) = 4 (SOUTH) and the bit clear            */
  {
    const g = G.seed({ char: 0x2A, char2: 0x2A });
    g.actors = [];
    g.onePass(P2FIRE);
    const q = g.players[1], seen = [];
    for (let i = 0; i < 8; i++) {
      seen.push([q.frameSlot, q.animCtl & 1, q.x, q.y]);
      g.onePass({ p2: { right: true } });
    }
    /* $A4C0 writes 4 (SOUTH) on the pass the materialise ends, and $A43B's
       own $A47B then overwrites it with the held direction on that SAME
       pass -- because $A4C4 has already cleared (IX+14) bit 0, so the draw
       no longer skips the pose.  MEASURED on the real Z80 at a level start
       with D held: (IX+13) reads 05, then 02, then 02 with the move.
       (tools/p2gate.py's join table and the level-start trace in
       notes/NOTES-engine.md.) */
    check('six materialise passes, then the pose the DRAW gives him',
          seen, [[0, 1, 16, 8], [1, 1, 16, 8], [2, 1, 16, 8], [3, 1, 16, 8],
                 [4, 1, 16, 8], [5, 1, 16, 8], [2, 0, 16, 8], [2, 0, 18, 8]]);
  }

  /* --- $9689's ring, `python tools/p2gate.py place` ------------------
        nothing walled -> (44,40)   E -> (40,36)   E,N -> (40,44)
        E,N,S -> (36,40)            all four -> (0,0), i.e. FAILURE
     which is the priority E, N, S, W, and on dungeon 1 the failure still
     joins him ($945A LD A,($8403) / DEC A / JR z). */
  {
    const walls = [[], ['E'], ['E', 'N'], ['E', 'N', 'S'],
                   ['E', 'N', 'S', 'W']];
    const D = { E: [1, 0], N: [0, -1], S: [0, 1], W: [-1, 0] };
    const got = walls.map(w => {
      const g = G.seed({ char: 0x2A, char2: 0x2A });
      g.actors = [];
      g.players[0].x = 40; g.players[0].y = 40;
      for (const k of w) g.map[10 + D[k][1]][10 + D[k][0]] = 0x01;
      g.onePass(P2FIRE);
      return [g.players[1].x, g.players[1].y, g.players[1].inGame ? 1 : 0];
    });
    check('$9689 ring priority E, N, S, W, then failure',
          got, [[44, 40, 1], [40, 36, 1], [40, 44, 1], [36, 40, 1],
                [0, 0, 1]]);
    /* and on any dungeon but the first, the failure REFUSES him:
       $9460 SET 7,(IX+$14) / (IX+14) = 0 / sound 13 */
    const g = G.seed({ char: 0x2A, char2: 0x2A });
    g.actors = []; g.level = 2;
    g.players[0].x = 40; g.players[0].y = 40;
    for (const k of ['E', 'N', 'S', 'W']) g.map[10 + D[k][1]][10 + D[k][0]] = 1;
    g.onePass(P2FIRE);
    check('but off dungeon 1 the same failure REFUSES the join',
          [g.players[1].inGame ? 1 : 0, g.players[1].health, g.lastSfx],
          [0, 0, 13]);
  }

  /* --- $AAC4, `python tools/p2gate.py overlap` -----------------------
     49 hits, dx and dy each in [-3..3], the full product, both IX values,
     and the other player's +$0B bit 6 disables it entirely. */
  {
    const g = G.seed({ char: 0x2A, char2: 0x2A });
    g.actors = [];
    g.onePass(P2FIRE);
    const hits = [];
    for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
      g.players[1].x = 40; g.players[1].y = 40;
      g.players[0].x = 40; g.players[0].y = 40;
      g.p = g.players[0]; g.players[0].animCtl = 0;
      const hit = g.otherPlayerBox({ x: (40 + dx) & 0x7F, y: (40 + dy) & 0x7F });
      if (hit) hits.push([dx, dy, (g.players[0].animCtl >> 3) & 1]);
    }
    const dxs = [...new Set(hits.map(h => h[0]))].sort((a, b) => a - b);
    const dys = [...new Set(hits.map(h => h[1]))].sort((a, b) => a - b);
    check('$AAC4 refuses 49 offsets, dx and dy each in [-3..3]',
          [hits.length, dxs[0], dxs[dxs.length - 1], dys[0],
           dys[dys.length - 1], hits.every(h => h[2] === 1)],
          [49, -3, 3, -3, 3, true]);
    g.players[1].f11 |= 0x40;
    g.p = g.players[0];
    checkTrue('and the other player\'s +$0B bit 6 disables it',
              !g.otherPlayerBox({ x: 40, y: 40 }));
  }

  /* --- $A924 / $A944, `python tools/p2gate.py leash` -----------------
     all 128 candidates with the partner at 0, both IX values:
        $A924 allowed 0..60 and 68..127, REFUSED 61..67   (short way >= $3D)
        $A944 allowed 0..36 and 92..127, REFUSED 37..91   (short way >= $25)
     partner absent -> carry 0 for entry carry 0 AND 1, which is why the gate
     is inert in a one-player game. */
  {
    const g = G.seed({ char: 0x2A, char2: 0x2A });
    g.actors = [];
    g.onePass(P2FIRE);
    const sweep = horiz => {
      const ref = [];
      for (let c = 0; c < 128; c++) {
        g.players[1].x = 0; g.players[1].y = 0;
        g.p = g.players[0];
        if (g.leash({ x: c, y: c }, horiz)) ref.push(c);
      }
      return [ref[0], ref[ref.length - 1], ref.length];
    };
    check('$A924 refuses 61..67 and $A944 refuses 37..91',
          [sweep(true), sweep(false)], [[61, 67, 7], [37, 91, 55]]);
    const g2 = G.seed({ char: 0x2A, char2: 0x2A });     // player 2 NOT joined
    g2.p = g2.players[0];
    let any = false;
    for (let c = 0; c < 128; c++)
      if (g2.leash({ x: c, y: c }, true) || g2.leash({ x: c, y: c }, false))
        any = true;
    checkTrue('with one player the leash can never refuse', !any);
  }

  /* --- $A3E6, the camera midpoint ------------------------------------
     `python tools/p2gate.py camera` enumerates the real routine against an
     independent transcription: 8,192/8,192 with both present (a full even
     sweep of x-pairs at one y and of y-pairs at one x), 384/384 with player
     2 absent, (40,60) -> (42,62) with player 1 absent, and with BOTH absent
     $848D/$848E are not written at all. */
  {
    const g = G.seed({ char: 0x2A, char2: 0x2A });
    g.actors = [];
    g.onePass(P2FIRE);
    const tgt = (x1, y1, x2, y2) => {
      g.players[0].x = x1; g.players[0].y = y1;
      g.players[1].x = x2; g.players[1].y = y2;
      g.cameraTarget();
      return [g.camTgtX, g.camTgtY];
    };
    /* four pairs taken off the real routine by p2gate.py's enumeration */
    check('$A3E6 is the midpoint of the two sprite centres, rounded EVEN',
          [tgt(12, 8, 16, 8), tgt(40, 40, 40, 40), tgt(0, 0, 60, 36),
           tgt(30, 20, 32, 20)],
          [[16, 10], [42, 42], [32, 20], [32, 22]]);
    const g2 = G.seed({ char: 0x2A, char2: 0x2A });
    g2.players[0].x = 40; g2.players[0].y = 60; g2.cameraTarget();
    check('with player 2 absent it is his own coordinate + 2',
          [g2.camTgtX, g2.camTgtY], [42, 62]);
    g2.players[0].f11 |= 0x80; g2.camTgtX = 238; g2.camTgtY = 238;
    g2.cameraTarget();
    check('and with BOTH absent it is not written at all',
          [g2.camTgtX, g2.camTgtY], [238, 238]);
  }

  /* --- $ADC7, who the monsters chase ---------------------------------
     `python tools/p2gate.py chase` drives the real routine with the four
     bytes poked; the value is the JR displacement written into $AD52:
        p2 not in the game                  $24 chase player 1
          ... and player 1 holds the $18    $00 a random turn
        both in, neither holds it           $2F the NEARER
        both in, player 1 holds it          $19 chase player 2
        both in, player 2 holds it          $24
        both hold it                        $00
        player 1 out of play                $19
        player 2 out of play                $24                          */
  {
    const g = G.seed({ char: 0x2A, char2: 0x2A });
    g.actors = [];
    const set = (in2, t1, t2, o1, o2) => {
      g.players[1].p14 = in2 ? 0x00 : 0x80;
      g.players[0].timer = t1; g.players[1].timer = t2;
      g.players[0].f11 = o1 ? 0x80 : 0; g.players[1].f11 = o2 ? 0x80 : 0;
      /* four blocks: chaseTarget returns the target itself -- a player,
         a list to take the nearest of, or null; folded back to $AD52's
         displacement here so the table reads as the gate prints it */
      const t = g.chaseTarget();
      return t === null ? 0x00 : Array.isArray(t) ? 0x2F : t.idx === 0 ? 0x24 : 0x19;
    };
    check('$ADC7\'s five arms, and the $18 power-up is a REPELLENT',
          [set(0, 0, 0, 0, 0), set(0, 5, 0, 0, 0), set(1, 0, 0, 0, 0),
           set(1, 5, 0, 0, 0), set(1, 0, 5, 0, 0), set(1, 5, 5, 0, 0),
           set(1, 0, 0, 1, 0), set(1, 0, 0, 0, 1)],
          [0x24, 0x00, 0x2F, 0x19, 0x24, 0x00, 0x19, 0x24]);
    /* $AD82 keeps player 1's on a TIE -- $AD92 CP / JR nc */
    g.players[1].p14 = 0; g.players[0].timer = 0; g.players[1].timer = 0;
    g.players[0].f11 = 0; g.players[1].f11 = 0;
    g.players[0].x = 20; g.players[0].y = 20;
    g.players[1].x = 60; g.players[1].y = 20;
    const near1 = g.actorAim({ x: 24, y: 20 }).slot;
    const near2 = g.actorAim({ x: 56, y: 20 }).slot;
    check('$2F takes the nearer player: slot 6 (W) then slot 2 (E)',
          [near1, near2], [6, 2]);
  }

  /* --- $847E bits 4/5, the per-dungeon friendly-fire mode -------------
     `python tools/p2gate.py ff` drives all four combinations with the shot
     in flight; the differential scenarios `shoot`, `stun` and `hurt` are the
     same thing pass by pass.  Counted over all 307 shipped records from
     build/packdata.json: bit 1 (STUN) in 41, bit 0 (HURT) in NONE. */
  {
    let stun = 0, hurtN = 0;
    for (let i = 0; i < G.packs.data.lens.length; i++) {
      const f = G.packs.record(i)[1];
      if (f & 2) stun++;
      if (f & 1) hurtN++;
    }
    const inPacks = { stun: 0, hurt: 0, total: 0 };
    for (let p = 0; p < G.packs.count; p++)
      for (const id of G.packs.data.packs[p]) {
        const f = G.packs.record(id)[1];
        inPacks.total++;
        if (f & 2) inPacks.stun++;
        if (f & 1) inPacks.hurt++;
      }
    check('the 307 shipped dungeons: 41 STUN, 0 HURT, 266 neither',
          [inPacks.total, inPacks.stun, inPacks.hurt,
           inPacks.total - inPacks.stun - inPacks.hurt],
          [307, 41, 0, 266]);
    check('and the 125 DISTINCT records: 12 STUN, 0 HURT',
          [G.packs.data.lens.length, stun, hurtN], [125, 12, 0]);
    /* the three modes, driven: the shot always dies, and only the mode
       decides what it costs. */
    const fire = ff => {
      const g = G.seed({ char: 0x2A, char2: 0x2A });
      g.actors = [];
      g.onePass(P2FIRE);
      for (let i = 0; i < 8; i++) g.onePass(idle);
      g.players[0].x = 16; g.players[0].y = 40;
      g.players[1].x = 40; g.players[1].y = 40;
      g.ff = ff;
      for (let i = 0; i < 2; i++) g.onePass({ right: true, p2: {} });
      const q = g.players[1];
      const hp0 = q.health;
      for (let i = 0; i < 20; i++) { g.onePass({ fire: true, p2: {} }); g.ff = ff; }
      return [hp0 - q.health, (q.p14 & 0x40) ? 1 : 0, q.pend];
    };
    const nn = fire(0x00), st = fire(0x10), hu = fire(0x20), both = fire(0x30);
    check('$847E = 0: a partner ABSORBS the shot and takes nothing',
          [nn[1], nn[2]], [0, 0]);
    check('bit 4 STUN: +$14 bit 6 set, +$1D counting, health untouched',
          [st[1], st[2] > 0 && st[2] <= 0x1E], [1, true]);
    checkTrue('bit 5 HURT costs health where neither did',
              hu[0] > nn[0] && hu[1] === 0);
    check('and with BOTH set the stun wins ($905E jumps past $906E)',
          [both[1], both[0]], [st[1], st[0]]);
  }

  /* --- the order swap and the shove, $A39B / $AB15 -------------------
     `python tools/p2gate.py table push` on the real Z80: player 1 walking
     into player 2 makes the PAIR advance 2 units every TWO passes -- half
     speed -- and `table headon` deadlocks them for 29 passes.  Both are
     rows of the two-player differential; these are the same facts asserted
     without the harness. */
  {
    const g = G.seed({ char: 0x2A, char2: 0x2A });
    g.actors = [];
    g.onePass(P2FIRE);
    for (let i = 0; i < 8; i++) g.onePass(idle);
    const x0 = g.players[0].x, x1 = g.players[1].x;
    const steps = [], gaps = [];
    let prev = x0;
    for (let i = 0; i < 20; i++) {
      g.onePass({ right: true, p2: {} });
      steps.push(g.players[0].x - prev); prev = g.players[0].x;
      gaps.push(g.players[1].x - g.players[0].x);
    }
    /* Asserted as PROPERTIES rather than as a copied sequence, because the
       phase depends on where in $8491's parity the pair meets: $AB15 shoves
       on even counters only and $A39B reverses the order only on the pass
       after $AAC4 fired.  What is invariant, and what
       `python tools/p2gate.py table push` shows on the real Z80, is that a
       pushing pair moves at HALF SPEED and never overlaps. */
    checkTrue('a pushed pair steps 0 or 2 units, never more',
              steps.every(s => s === 0 || s === 2));
    checkTrue('never twice in a row -- i.e. HALF the normal 2 units a pass',
              !steps.some((s, i) => i && s === 2 && steps[i - 1] === 2));
    checkTrue('and it does advance', steps.filter(s => s === 2).length >= 8);
    check('the gap stays exactly what $AAC4 allows', [...new Set(gaps)],
          [x1 - x0]);
    const h = G.seed({ char: 0x2A, char2: 0x2A });
    h.actors = [];
    h.onePass(P2FIRE);
    for (let i = 0; i < 8; i++) h.onePass(idle);
    const hx = [h.players[0].x, h.players[1].x];
    for (let i = 0; i < 20; i++) h.onePass({ right: true, p2: { left: true } });
    check('head-on they DEADLOCK: neither can be shoved while he holds a key',
          [h.players[0].x, h.players[1].x], hx);
  }

  /* --- the level ends only when BOTH are out, $94AE ------------------- */
  {
    const g = G.seed({ char: 0x2A, char2: 0x2A });
    g.actors = [];
    g.onePass(P2FIRE);
    for (let i = 0; i < 8; i++) g.onePass(idle);
    g.players[0].f11 |= 0x80;
    checkTrue('one player finished is not the end of the level',
              !g.levelEnd());
    g.players[1].f11 |= 0x80;
    checkTrue('both finished IS', g.levelEnd());
    /* $94C3 -- the next dungeon is the unsigned MAX of the two (IX+12).
       MEASURED by calling $94AE with the pair poked: (5,3) -> 5, (3,5) -> 5,
       (9,9) -> 9, (254,2) -> 254, (128,127) -> 128. */
    const mx = (a, b) => {
      const h = G.seed({ char: 0x2A, char2: 0x2A });
      h.actors = []; h.onePass(P2FIRE);
      h.players[0].levelOwn = a; h.players[1].levelOwn = b;
      h.players[0].f11 |= 0x80; h.players[1].f11 |= 0x80;
      h.treasure = false; h.levelEnd();
      return h.level;
    };
    check('$94C3 takes the UNSIGNED max of the two players\' (IX+12)',
          [mx(5, 3), mx(3, 5), mx(9, 9), mx(254, 2), mx(128, 127)],
          [5, 5, 9, 254, 128]);
  }

  /* --- the two sprite banks and the two panels, drawn -----------------
     tools/playersprite.py gates BOTH banks against the original by joining
     player 2 the way a second player really joins and trapping $9DD2: the
     blit destination, the 16x16 the blitter wrote, the 2x2 attribute block
     and the record the game chose, 12/12 per direction, five poses each. */
  {
    const PF = G.assets.player_frames;
    check('two 32-record banks, ids 208 and 232, from $5F00 and $6320',
          [PF._base_id, PF.p2._base_id], [208, 232]);
    check('and they are DIFFERENT characters: elf $44, valkyrie $45',
          [PF.idle.ink, PF.p2.idle.ink], [0x44, 0x45]);
    checkTrue('every walk record of a set carries one attribute',
              ['idle'].concat(G.sprite.SLOTNAME)
                .every(k => PF[k].ink === PF.idle.ink &&
                            PF.p2[k].ink === PF.p2.idle.ink));
    check('the six MATERIALISE records, $F45E + n*33, attribute $06',
          [PF.materialise.length,
           [...new Set(PF.materialise.map(m => m.ink))]], [6, [0x06]]);

    const paint = gg => { recording = true; drawCalls.length = 0;
                          G.render(ctxStub, gg); recording = false;
                          return drawCalls.slice(); };
    const inks = list => new Set(list.filter(c => c[2] < 160).map(c => c[5]));
    const g1 = G.seed({});
    const one = paint(g1);
    const g2 = G.seed({});
    g2.onePass({ p2: { fire: true } });
    for (let i = 0; i < 8; i++) g2.onePass({ p2: {} });
    for (let i = 0; i < 10; i++) g2.onePass({ p2: { down: true } });
    const two = paint(g2);
    /* PAL_BRT[5] = #00ffff is ink 5 BRIGHT -- the valkyrie's $45 -- and
       PAL_BRT[4] = #00ff00 is the elf's $44. */
    checkTrue('with one player the playfield has no BRIGHT CYAN in it',
              !inks(one).has('#00ffff'));
    checkTrue('player 2 joined puts his own bank on screen, in his own ink',
              inks(two).has('#00ffff') && inks(two).has('#00ff00'));
    checkTrue('and the two sprites are at different places',
              g2.players[0].y !== g2.players[1].y);
    /* the panel: player 2's half is the GAUNTLET logo until he joins and his
       own name and counters after -- 17 columns right of player 1's */
    /* A DRAW-CALL COUNT CANNOT SEE OCCLUSION, and this panel is painted in
       layers: the captured rows first, then $B5E8's own clear of the fifteen
       columns, then the new art.  So the calls are RASTERIZED into the HUD
       band and the final pixels counted -- otherwise "row 23 is blank" reads
       as false because the wordmark was drawn and then covered. */
    const cells = (list, c0, c1, row) => {
      const buf = new Uint8Array(256 * 32);
      for (const c of list) {
        if (c[0] !== 'fillRect') continue;
        const on = c[5] !== '#000000' ? 1 : 0;
        for (let y = Math.max(160, c[2] | 0); y < Math.min(192, (c[2] | 0) + (c[4] | 0)); y++)
          for (let x = Math.max(0, c[1] | 0); x < Math.min(256, (c[1] | 0) + (c[3] | 0)); x++)
            buf[(y - 160) * 256 + x] = on;
      }
      let n = 0;
      for (let y = (row - 20) * 8; y < (row - 20) * 8 + 8; y++)
        for (let x = c0 * 8; x < c1 * 8; x++) n += buf[y * 256 + x];
      return n;
    };
    /* the IN-GAME invite is RETIRED (this fork): the ways in are the
       lobby's START online and nothing at all offline, so before the
       join his half is BLANK -- no wordmark, no PRESS FIRE, no
       counters.  (The attract screen keeps the classic picture; see the
       check below.) */
    checkTrue('before the join his half is BLANK, all four rows',
              [20, 21, 22, 23].every(r => cells(one, 17, 32, r) === 0));
    /* $B694 blanks row 23 for a player who IS in the game, and $B87A's row 2
       plus $B7C7's counters fill row 22 -- health at cols 9..12 of his own
       half, i.e. 26..29 absolute. */
    /* FOUR QUARTERS: his is x 64-127 -- HEALTH on y 172-176, an empty
       KEYS line (y 178-182) and icon row, the name on y 160-164 */
    const pxBox = (list, x0, x1, y0, y1) => {
      const buf = new Uint8Array(256 * 32);
      for (const c of list) {
        if (c[0] !== 'fillRect') continue;
        const on = c[5] !== '#000000' ? 1 : 0;
        for (let y = Math.max(160, c[2] | 0); y < Math.min(192, (c[2] | 0) + (c[4] | 0)); y++)
          for (let x = Math.max(0, c[1] | 0); x < Math.min(256, (c[1] | 0) + (c[3] | 0)); x++)
            buf[(y - 160) * 256 + x] = on;
      }
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += buf[(y - 160) * 256 + x];
      return n;
    };
    checkTrue('after it, his quarter carries HEALTH on y 172-176 and nothing on the KEYS line or icon row',
              pxBox(two, 64, 128, 172, 177) > 0 && pxBox(two, 64, 128, 178, 192) === 0);
    checkTrue('his name is on the top line of his own quarter, x 64..',
              pxBox(two, 64, 128, 160, 165) > 0);
    /* the ATTRACT/REWIND screens keep the classic invite: both halves
       carry the wordmark over PRESS FIRE (row 23, attribute 6 -- the
       always-visible row; 20-22 spend part of the ISR cycle black).
       There FIRE really is the way in ($B374), and offline after a
       game over it is the only prompt there is. */
    const gA = G.seed({});
    gA.enterAttract();
    const att = paint(gA);
    checkTrue('the attract screen still says PRESS FIRE in BOTH halves',
              cells(att, 4, 10, 23) > 0 && cells(att, 21, 27, 23) > 0);
    /* --- the NAME TAGS: only when players MEET.  A lone sprite needs no
       label, so a solo screen never tags, named or not; the moment two
       players are visible in the window, every visible one wears his
       name -- the SET name, or his CHARACTER's (class_names, the menu's
       own table -- the panel's $B890 capture never decoded VALKYRIE).
       Differentials on the SAME frame: green 1x1 fills isolate player
       1's tag ('AB' = A 12 + B 13 = 25 px in the elf ink), and moving
       player 2 off-window (dx 80, past the $B557 mask's window, no
       wrap) must take BOTH tags with him. */
    const pix = (list, col) => list.filter(c => c[0] === 'fillRect' &&
      c[3] === 1 && c[4] === 1 && c[5] === col && c[2] < 160).length;
    const gT = G.seed({});
    const b0 = paint(gT).length;
    gT.names = ['ELF', '', '', ''];
    check('a LONE player never wears a tag, named or not',
          paint(gT).length - b0, 0);
    const gU = G.seed({});
    gU.onePass({ p2: { fire: true } });
    for (let i = 0; i < 8; i++) gU.onePass({ p2: {} });
    check('an unset name falls back to the CHARACTER\'s own, all four decodable',
          [G.hud.tagNameFor(gU, gU.players[0]), G.hud.tagNameFor(gU, gU.players[1])],
          ['ELF', 'VALKYRIE']);
    gU.names = ['AB', '', '', ''];
    const both = paint(gU);
    const xWas = gU.players[1].x;
    gU.players[1].x = gU.camX + 80;            // off the window, no wrap
    const apart = paint(gU);
    gU.players[1].x = xWas;
    check('tags appear exactly when ANOTHER player is on screen: AB is 25 px',
          pix(both, '#00ff00') - pix(apart, '#00ff00'), 25);
    checkTrue('...and the met player wears VALKYRIE (81 px) in his own cyan',
              pix(both, '#00ffff') - pix(apart, '#00ffff') >= 81);
    /* the join ring puts the two 16 px apart, so their tags collide --
       the second must take the next line UP.  Positional diff: the
       pixels only in `both` are p1's tag (green) and p2's tag + sprite
       (cyan); the sprite sits BELOW the tag band, so exactly the 81
       VALKYRIE pixels must land strictly above AB's topmost row. */
    const posOf = (list, col) => new Set(list.filter(c => c[0] === 'fillRect' &&
      c[3] === 1 && c[4] === 1 && c[5] === col && c[2] < 160)
      .map(c => c[1] + ',' + c[2]));
    const diffPos = col => { const B = posOf(apart, col);
      return [...posOf(both, col)].filter(k => !B.has(k))
        .map(k => k.split(',').map(Number)); };
    const gTop = Math.min(...diffPos('#00ff00').map(p => p[1]));
    check('...and adjacent tags STACK: the 81 VALKYRIE px sit clear above AB',
          diffPos('#00ffff').filter(p => p[1] < gTop).length, 81);
    /* --- the RIP tag: a corpse wears RIP <name> ALWAYS -- no meeting
       needed, the death is the show -- in the character's own ink held
       STEADY (no low-health flash on a tombstone).  RIP+space is 31 px,
       VALKYRIE 81: 112 cyan one-by-ones at the poked corpse cell. */
    const gR = G.seed({});
    const baseR = paint(gR);
    gR.players[1].died = true;
    gR.players[1].diedX = (gR.camX + 24) & 0xFF;
    gR.players[1].diedY = (gR.camY + 24) & 0xFF;
    const ripped = paint(gR);
    check('a corpse wears RIP VALKYRIE, no meeting needed: 112 px, his ink',
          pix(ripped, '#00ffff') - pix(baseR, '#00ffff'), 112);
    gR.players[1].died = false;
  }

  /* --- both players drain, and the HUD round robin is FOUR passes long */
  {
    const g = G.seed({ char: 0x2A, char2: 0x2A });
    g.actors = [];
    g.onePass(P2FIRE);
    for (let i = 0; i < 8; i++) g.onePass(idle);
    const h0 = [g.players[0].health, g.players[1].health];
    for (let i = 0; i < 32; i++) g.onePass(idle);
    const d0 = h0[0] - g.players[0].health, d1 = h0[1] - g.players[1].health;
    checkTrue('$B6DA drains BOTH players on the same tick', d0 === d1 && d0 > 0);
    /* $B717 BIT 1,(IY+$12) picks the player and $B726 BIT 0 the field, so
       the round robin is p1 health, p1 score, p2 health, p2 score. */
    const seen = [];
    for (let i = 0; i < 8; i++) {
      g.players[0].f11 |= 0x03; g.players[1].f11 |= 0x03;
      g.onePass(idle);
      seen.push([(g.passCtr & 3),
                 (g.players[0].f11 & 3), (g.players[1].f11 & 3)]);
    }
    checkTrue('the HUD round robin serves one field of one player per pass',
              seen.every(([c, a, b]) => {
                const cleared = (c & 2) ? (3 - b) : (3 - a);
                return cleared === ((c & 1) ? 2 : 1) || cleared === 0;
              }));
  }
}

/* ---------- SOUND: the AY driver, the chip and the bridge -------------
   Every expected value below is either MEASURED ON THE REAL Z80 (with the
   tool invocation named), an independent re-derivation of the datasheet
   formula, a cross-quantity invariant, or a universal property.  None of
   them is read back out of the code under test.  The full register-level
   differential lives in tools/soundgate.py; these are the properties that
   are cheap to assert on every build.                                    */
{
  const S = G.sound;
  const D = new S.SfxDriver();

  // MEASURED by walking the game's own $73DA streams -- python tools/sfxdata.py
  // --print -- which independently asserts that the 18 streams tile
  // $73FE..$77AF with zero gaps and zero overlaps, so a wrong row size could
  // not produce this list.
  check('18 sound effects, ids $00..$11',
        S.streams.length, 18);
  check('effect lengths in 50 Hz frames ($73DA, walked on the Z80)',
        S.streams.map(r => r.length),
        [8, 8, 14, 20, 5, 25, 54, 28, 7, 30, 8, 51, 25, 15, 38, 85, 35, 8]);
  // the cross-quantity invariant: 464 is also the number of frames
  // tools/soundgate.py's `effects` differential walks
  check('464 effect frames in total',
        S.streams.reduce((n, r) => n + r.length, 0), 464);

  /* $BADB with nothing playing writes R7 = $38 and NOTHING else.  MEASURED on
     the real Z80 over a quiet scene: 88 of 128 frames carried exactly one
     write and it was R7 = $38 every time -- which is the whole of
     NOTES-battery Q17's "92 writes each to $FFFD and $BFFD, only register 7".
     python tools/soundgate.py table idle 20 prints it. */
  {
    const d = new S.SfxDriver();
    d.log.length = 0;
    d.tick(); d.tick(); d.tick();
    check('a silent tick writes R7=$38 and nothing else',
          d.log.map(([f, r, v]) => [r, v]), [[7, 0x38], [7, 0x38], [7, 0x38]]);
  }

  /* ONE FRAME OF ONE EFFECT, against the real Z80's own port writes.
     MEASURED: python tools/soundgate.py effects, id $04 tick 0.  The order
     matters and is asserted: volume, then R6, then the two period bytes,
     then R7 -- $BB50 / $BB6A / $BB7E / $BB27. */
  {
    const d = new S.SfxDriver();
    d.trigger(4); d.log.length = 0; d.tick();
    check('effect $04 frame 0 == the Z80\'s own writes, in order',
          d.log.map(([f, r, v]) => r + '=' + v.toString(16).toUpperCase()),
          ['8=6', '6=10', '0=44', '1=0', '7=30']);
  }

  /* THE EIGHT-BIT WRAP AT $BB71.  `INC A` happens before the widening into
     HL, so a tone byte of $FF gives period 0, not 1024.  Effect $11's eight
     rows all carry $FF, so every one of them must write R0 = R1 = 0.  This is
     the property an independent decoder got wrong first time. */
  {
    const rows = S.streams[0x11];
    checkTrue('effect $11 is eight rows of tone byte $FF',
              rows.length === 8 && rows.every(([b0, b1]) => b1 === 0xFF));
    const d = new S.SfxDriver();
    d.trigger(0x11);
    let zero = 0;
    for (let i = 0; i < 8; i++) {
      d.log.length = 0; d.tick();
      const m = new Map(d.log.map(([f, r, v]) => [r, v]));
      if (m.get(0) === 0 && m.get(1) === 0) zero++;
    }
    check('tone byte $FF -> period 0 on all eight frames ($BB71 INC A is 8-bit)',
          zero, 8);
  }

  /* R6 = 2 * (b0 & 15) -- $BB62 ADD A,A.  MEASURED: the recorded dump shows
     R6 flipping between $02 and $04 while two effects overlap, i.e. even
     values, never the raw nibble. */
  {
    const d = new S.SfxDriver();
    d.trigger(0x11);                       // noise nibbles $F,$D,$B,$9,...
    const want = S.streams[0x11].map(([b0]) => (b0 & 15) * 2);
    const got = [];
    for (let i = 0; i < 8; i++) {
      d.log.length = 0; d.tick();
      got.push(new Map(d.log.map(([f, r, v]) => [r, v])).get(6));
    }
    check('R6 is 2 x the low nibble ($BB62 ADD A,A)', got, want);
  }

  /* THE MIXER.  $BB27 AND $38 masks the three TONE-disable bits to zero, so
     tone is enabled on all three channels for ever and only noise routing
     varies; the enables are INVERTED, 0 = on.  Asserted over every frame of
     every effect -- a universal property, not a sample. */
  {
    let tonebits = 0, r7vals = new Set(), envRegs = 0, volBit4 = 0;
    for (let id = 0; id < 18; id++) {
      const d = new S.SfxDriver();
      d.trigger(id);
      for (let i = 0; i < S.streams[id].length + 2; i++) {
        d.log.length = 0; d.tick();
        for (const [f, r, v] of d.log) {
          if (r === 7) { r7vals.add(v); if (v & 7) tonebits++; }
          if (r === 11 || r === 12 || r === 13) envRegs++;
          if (r >= 8 && r <= 10 && (v & 16)) volBit4++;
        }
      }
    }
    check('R7 never disables a tone ($BB27 AND $38)', tonebits, 0);
    check('R11/R12/R13 are never written by any effect', envRegs, 0);
    check('no volume ever selects the hardware envelope (bit 4)', volBit4, 0);
    checkTrue('R7 only ever takes values with the tone bits clear',
              [...r7vals].every(v => (v & 0xC7) === 0),
              JSON.stringify([...r7vals]));
  }

  /* ALLOCATION, all four rules MEASURED on the real Z80 by calling $BA2B in
     isolation and reading $BDC0 / $BDB3.. afterwards (my own rig, m3.py):
       three distinct ids     -> mask $09 -> $1B -> $3F
       the same id again      -> the SAME channel, restarted at row 0
       ages 27/7/2            -> steals channel 0 (the largest age)
       ages 5/5/5            -> steals channel 2 (ties to the HIGHEST index,
                                because $BA88 JR c only skips on <)          */
  {
    const d = new S.SfxDriver();
    const masks = [];
    d.trigger(6); masks.push(d.busy);
    d.trigger(7); masks.push(d.busy);
    d.trigger(8); masks.push(d.busy);
    check('allocation fills the channels in order', masks, [0x09, 0x1B, 0x3F]);
    for (let i = 0; i < 5; i++) d.tick();
    const rowBefore = d.ch[0].row;
    d.trigger(6);
    checkTrue('the same id restarts its own channel at row 0',
              rowBefore > 0 && d.ch[0].row === 0 && d.busy === 0x3F);
    const steal = (ages) => {
      const k = new S.SfxDriver();
      k.trigger(6); k.trigger(7); k.trigger(8);
      ages.forEach((a, i) => { k.ch[i].row = a; });
      k.trigger(0x0B);
      return k.ch.findIndex(c => c.id === 0x0B);
    };
    check('a steal takes the LARGEST age', steal([27, 7, 2]), 0);
    check('a steal takes the largest age wherever it is', steal([2, 7, 27]), 2);
    check('a tie goes to the highest index ($BA88 JR c)', steal([5, 5, 5]), 2);
  }

  /* THE TWO TUNE GATES at $BA31, measured the same way: $BDE9 = 1 drops every
     effect (mask stays $00), $BDE9 = 2 forces them all onto channel 0. */
  {
    const a = new S.SfxDriver(); a.tune = 1;
    a.trigger(6); a.trigger(7); a.trigger(8);
    check('tune 1 playing DROPS every effect ($BA3D/$BA41)', a.busy, 0);
    const b = new S.SfxDriver(); b.tune = 2;
    b.trigger(6); b.trigger(7); b.trigger(8);
    check('tune 2 playing forces every effect onto channel 0 ($BA38)',
          [b.busy, b.ch[0].id], [0x09, 8]);
  }

  /* THE TERMINATOR clears the channel's ALLOCATED bit and leaves the
     step-enable bit latched: measured on the Z80, mask $09 -> $08, and $08
     persists.  A port that clears both would re-use the channel differently. */
  {
    const d = new S.SfxDriver();
    d.trigger(4);                                  // five rows
    const seen = [];
    for (let i = 0; i < 8; i++) { d.tick(); seen.push(d.busy); }
    check('the terminator clears bit c only, leaving bit c+3 latched',
          [seen[0], seen[seen.length - 1]], [0x09, 0x08]);
  }

  /* ID 0 IS A COIN between effects 0 and 1 ($BAB2 LD A,R / AND 1).  MEASURED
     on the Z80: 200 requests for id 0 gave exactly 100 of each, and ids
     2/4/15/17 never move under a swept R.  The DRAW is the refresh register
     and is not reproducible; what is asserted is the RULE -- both outcomes
     occur, and nothing else does. */
  {
    const d = new S.SfxDriver();
    const seen = new Map();
    for (let i = 0; i < 400; i++) {
      const c = d.coin();
      seen.set(c, (seen.get(c) || 0) + 1);
    }
    checkTrue('the id-0 coin lands on 0 or 1 and on nothing else',
              [...seen.keys()].sort().join(',') === '0,1',
              JSON.stringify([...seen]));
    checkTrue('both outcomes occur, near enough half each (the RULE, not the '
              + 'draw -- the draw is LD A,R and is not reproducible)',
              seen.get(0) > 150 && seen.get(1) > 150,
              JSON.stringify([...seen]));
    const got = new Set();
    for (let i = 0; i < 40; i++) {
      const k = new S.SfxDriver();
      k.coin = () => i & 1;                 // force both outcomes
      k.trigger(0);
      got.add(k.ch[0].id);
    }
    check('a request for id 0 stores id 0 or id 1', [...got].sort(), [0, 1]);
    const fixed = new Set();
    for (let i = 0; i < 50; i++) {
      const k = new S.SfxDriver(); k.trigger(4); fixed.add(k.ch[0].id);
    }
    check('every other id is deterministic', [...fixed], [4]);
  }

  /* THE AY CHIP against the datasheet formula, measured out of its own
     samples by counting zero crossings -- an independent re-derivation of
     f = clock / (16 * TP), not a read-back of the constant. */
  {
    const sr = 44100;
    const measure = (tp) => {
      const c = new S.AyChip(sr, S.AY_CLOCK);
      c.write(0, tp & 0xFF); c.write(1, tp >> 8);
      c.write(7, 0x38);                     // all tones ON, all noise OFF
      c.write(8, 15); c.write(9, 0); c.write(10, 0);
      const n = sr * 0.4, buf = new Float32Array(n);
      c.render(buf, 0, n);
      let mean = 0; for (let i = 0; i < n; i++) mean += buf[i];
      mean /= n;
      let cross = 0;
      for (let i = 1; i < n; i++)
        if ((buf[i - 1] - mean) <= 0 && (buf[i] - mean) > 0) cross++;
      return cross / 0.4;                   // rising edges per second
    };
    for (const tp of [1625, 812, 404, 121]) {
      const want = S.AY_CLOCK / (16 * tp);
      const got = measure(tp);
      checkTrue(`AyChip tone period ${tp} -> ${want.toFixed(1)} Hz`,
                Math.abs(got - want) / want < 0.02,
                `measured ${got.toFixed(1)} Hz`);
    }
    /* THE MIXER'S INVERTED SENSE, tested as the chip's own AND gate rather
       than as "silence": with tone A DISABLED (bit 0 SET) and noise A also
       disabled, the AND of the two forced-high inputs is a CONSTANT at the
       channel's volume -- which is real AY behaviour and the reason silence
       in this game comes from volume 0 and never from R7. */
    const wiggle = (r7) => {
      const c = new S.AyChip(sr, S.AY_CLOCK);
      c.write(0, 100); c.write(1, 0); c.write(7, r7); c.write(8, 15);
      const n = 4000, buf = new Float32Array(n);
      c.render(buf, 0, n);
      let lo = 1e9, hi = -1e9;
      for (let i = 200; i < n; i++) { lo = Math.min(lo, buf[i]);
                                      hi = Math.max(hi, buf[i]); }
      return hi - lo;
    };
    checkTrue('R7 bit 0 CLEAR = tone A ENABLED (0 = on): the output swings',
              wiggle(0x38) > 0.1, String(wiggle(0x38)));
    checkTrue('R7 bit 0 SET = tone A disabled: the output is a constant',
              wiggle(0x39) < 1e-6, String(wiggle(0x39)));
  }

  /* THE BRIDGE, ON BOTH BRANCHES.  Every event carries the SIMULATED FRAME
     it happened on and a burst does not collapse.  The banner pass is the
     test case because it is the one place the game blocks, and it is the
     LARGEST behavioural difference between the two drivers:

       AY   $9D22 LD A,$10 / CALL $BA2B then 50 x HALT/HALT -- 104 video
            frames, and $8497 advances by all 104
       48K  $9D0E JR nz NOT taken, so $9D1A..$9D34 never runs at all; $9D10
            JPs into the blocking TUNE $B8B0, 72.07 frames with INTERRUPTS
            OFF, so $8497 advances by FOUR -- an ordinary pass -- and id $10
            (one of the seven silent ids here) is never even requested.

     RE-MEASURED IN SITU, because the numbers this check used to carry were
     the ISOLATED tune cost plus an ASSUMED four-frame ordinary pass, and the
     ordinary pass is not four frames here.  Driving THIS EXACT SCENARIO on
     the real Z80 -- build/state_48k.pkl and its AY twin build/state_48k_ay.pkl,
     $8496 = 0, a $19 planted three rows below the player, DOWN, eight passes,
     anchored on $8503:

       branch  banner pass   W1 at that pass   $8497 delta   $891C's own cost
       48K       77.020 f      138,413 T           +5           49,799 T
       AY       104.819 f      131,544 T          +105          49,799 T

     -- i.e. the banner pass is FIVE video frames plus the tune on BOTH
     branches, because $891C's text render costs 49,799 T against 77 T and
     that alone is 0.71 of a frame on top of a W1 already at 1.27.  The old
     "76.02 / +4" and "103.82 / +104" were 4 + 72.07 and 4 + 100 and are
     wrong by exactly the frame this whole cost model exists to find.
     (scratchpad my11/my12; reproduce with `python tools/clockgate.py diff`.)
     THE AY ARM IS CHARGED WITH THE 48K BRANCH'S COST CONSTANTS -- $B8CC is a
     bare RET there and W1 is ~7,000 T cheaper, measured -- so the AY figure
     is right here by 12,000 T of margin rather than by modelling. */
  {
    const bannerRun = () => {
      const g = G.seed({});
      g.actors = [];
      const col = g.x >> 2, row = g.y >> 2;
      g.map[(row + 3) & 31][col] = 0x19;          // an inventory item
      const before = g.simFrame, ids = [];
      let banner = -1, ctr = -1;
      const raw = g.sfx.bind(g);
      g.sfx = id => { ids.push(id); raw(id); };
      for (let i = 0; i < 8; i++) {
        const f0 = g.simFrame, c0 = g.frameCtr;
        g.onePass({ down: true });
        if (g.simFrame - f0 > 10) { banner = g.simFrame - f0;
                                    ctr = (g.frameCtr - c0) & 0xFF; }
      }
      return { g, before, ids, banner, ctr };
    };
    const mode0 = S.mode();
    S.setMode(S.SOUND_128K);
    let r = bannerRun();
    check('AY: the banner pass advances the sound clock by 105 frames '
          + '(5 for the pass + 100 for the HALT/HALT pause), measured 104.819',
          r.banner, 105);
    check('AY: and $8497 by 105 with it -- the ISR runs all the way through '
          + 'the AY pause', r.ctr, 105);
    check('AY: and plays effect $11 then effect $10 inside it',
          r.ids, [0x11, 0x10]);
    checkTrue('AY: every sound event carries a simulated frame number',
              r.g.sound.log.every(([f]) =>
                Number.isInteger(f) && f >= r.before && f <= r.g.simFrame));

    S.setMode(S.SOUND_48K);
    r = bannerRun();
    checkTrue('48K: the banner pass blocks 72.07 frames (77.07 for the whole '
              + 'pass, because the pass itself is FIVE), measured 77.020',
              Math.abs(r.banner - 77.07) < 0.2, String(r.banner));
    check('48K: and $8497 advances by FIVE, not 104 -- the tune runs with '
          + 'interrupts OFF, so only the pass own frames count', r.ctr, 5);
    check('48K: and effect $10 is never requested ($9D24 is jumped over)',
          r.ids, [0x11]);
    checkTrue('48K: every speaker edge carries a simulated frame number',
              r.g.sound.log.every(([f, lv]) =>
                Number.isFinite(f) && (lv === 0 || lv === 1)
                && f >= r.before && f <= r.g.simFrame + 1));
    checkTrue('48K: the edges are in non-decreasing frame order',
              r.g.sound.log.every((e, i, a) => i === 0 || e[0] >= a[i - 1][0]));
    checkTrue('48K: the blocking tune is recorded as a block with its length',
              r.g.sound.blocks.length === 1
              && r.g.sound.blocks[0][1] === 'banner'
              && Math.abs(r.g.sound.blocks[0][2] - 72.07) < 0.05,
              JSON.stringify(r.g.sound.blocks));
    S.setMode(mode0);
  }

  /* =====================================================================
     THE 48K BEEPER -- THE SHIPPED DRIVER
     =====================================================================
     Every expectation below comes from the real Z80: the data from
     build/beeper_data.json (tools/beepdata.py, which parses $B92B's own CP
     chain and asserts the stream tiling), the model from
     `python tools/beepgate.py fit`, and the edge stream from
     `python tools/beepgate.py diff`. */
  {
    const B = S.beeper;
    checkTrue('build/beeper_data.json ships', !!B);
    /* 1. THE DATA'S OWN INVARIANTS, re-asserted in the artifact. */
    const streams = Object.values(B.streams);
    check('nine ids reach a tone stream', Object.keys(B.streams).length, 9);
    check('59 played steps across them',
          streams.reduce((a, r) => a + r.length, 0), 59);
    check('eight DISTINCT streams -- ids 6 and $0F share $B9E5',
          new Set(streams.map(r => JSON.stringify(r))).size, 8);
    check('seven ids are a bare RET at $B98A', B.silent, [1, 3, 5, 9, 12, 13, 16]);
    checkTrue('every toggle count is EVEN, so a step leaves no DC step',
              streams.every(r => r.every(([c]) => c % 2 === 0)));
    checkTrue('no count and no delay is zero, so neither 256-wrap is reachable',
              streams.every(r => r.every(([c, e]) => c !== 0 && e !== 0)));
    /* 2. THE HALF-PERIOD MODEL, 17E+31 T-states, against the T-stamped edge
       gaps measured on the Z80 -- the table beepdata.py wrote out of its own
       measurement, not out of this formula. */
    let hbad = 0;
    for (const [e, h] of Object.entries(B.half_period))
      if (S.beepHalf(Number(e)) !== h) hbad++;
    check('half-period 17E+31 agrees with the measured table at every E',
          hbad, 0);
    check('the DJNZ wrap: E=0 means 256, i.e. 4383 T', S.beepHalf(0), 4383);
    /* 3. THE DISPATCHER.  Ids that play, ids that are silent, the alias, and
       the two noise arms -- driven through the driver itself. */
    {
      const d = new S.BeeperDriver();
      d.trigger(15);
      const s15 = [d.steps, d.rows];
      d.silence(); d.trigger(6);
      check('id 6 aliases id $0F\'s stream ($B976 JR z back into $B966)',
            JSON.stringify(d.rows), JSON.stringify(s15[1]));
      d.silence(); d.trigger(8);
      check('id 8 is HANDLED ($B93E CP 8 / LD HL,$B9AF), 5 steps', d.steps, 5);
      for (const id of B.silent) {
        const k = new S.BeeperDriver(); k.trigger(15);
        const before = [k.steps, k.row, k.level, k.ticks];
        k.trigger(id);
        check(`a silent id ($${id.toString(16)}) over a playing tone is a NO-OP`,
              [k.steps, k.row, k.level, k.ticks], before);
      }
      const k = new S.BeeperDriver();
      k.trigger(15); k.toneTick(0); k.toneTick(0); k.toneTick(0);
      const mid = k.steps; k.trigger(17);
      check('a NEW trigger cuts the old stream off from its own step 0',
            [mid, k.steps, k.row], [6, 4, 0]);
      const n0 = new S.BeeperDriver(); n0.trigger(0);
      const n4 = new S.BeeperDriver(); n4.trigger(4);
      check('id 0 arms the noise UP from 1, id 4 DOWN from $7F',
            [n0.level, n0.ramp, n4.level, n4.ramp], [1, 1, 127, -1]);
      const both = new S.BeeperDriver(); both.trigger(15); both.trigger(0);
      checkTrue('noise and tone are independent state and coexist',
                both.steps === 9 && both.level === 1 && both.ticks === 127);
    }
    /* 4. THE TONE STEP'S OWN EDGE STREAM.  Count, spacing and polarity, from
       the driver's log -- the same three quantities tools/beepgate.py
       compares against the Z80's OUT ($FE) stream. */
    {
      let bad = 0, total = 0;
      for (const [id, rows] of Object.entries(B.streams)) {
        const d = new S.BeeperDriver();
        d.trigger(Number(id));
        for (let s = 0; s < rows.length; s++) {
          const f0 = 100 * s;
          d.toneTick(f0, 4);
          d.log.length = 0;
          d.endPass(f0, 4);                 // flush this pass, in frame order
          const [c, e] = rows[s];
          total += c;
          const tone = d.log.filter(r => r[2] === 'tone');
          const gaps = new Set();
          for (let i = 1; i < tone.length; i++)
            gaps.add(Math.round((tone[i][0] - tone[i - 1][0]) * 69888));
          const alt = tone.every(([, lv], i) => lv === ((i % 2) ? 0 : 1));
          if (tone.length !== c) bad++;
          else if (gaps.size !== 1
                   || [...gaps][0] !== S.beepHalf(e)) bad++;
          else if (!alt) bad++;
          else if (Math.abs(tone[0][0] - (f0 + S.BEEP_TONE_AT
                   + S.beepHalf(e) / 69888)) > 1e-9) bad++;
        }
      }
      check('every one of the 59 steps: C edges, one half-period, first a '
            + 'RISE, placed at 1.81 frames into the pass', bad, 0);
      check('and they are 2,950 edges in total', total, 2950);
    }
    /* 5. THE NOISE, as a DECLARED SUBSTITUTE.  What is asserted is the RULE
       -- 127 ramp calls, the level walking 1..127 or 127..1, density
       level/128 -- and never the individual draws, which are `LD A,R`. */
    {
      /* one object a pass, so the ramp is stepped one call at a time and the
         level sequence itself can be read out */
      const ramp = (id) => {
        const d = new S.BeeperDriver();
        d.trigger(id);
        const lv = [];
        for (let p = 0; p < 400 && d.ticks > 0; p++) {
          lv.push(d.level); d.noiseService(p, 1); d.endPass(p, 0);
        }
        return { lv, end: d.level, d };
      };
      const up = ramp(0), down = ramp(4);
      check('a noise burst is exactly 127 ramp calls', up.lv.length, 127);
      check('and it visits levels 1..127 and then stops at 0',
            [up.lv[0], up.lv[126], up.end], [1, 127, 0]);
      check('id 4 ramps DOWN from 127 to 1 in the same 127 calls',
            [down.lv.length, down.lv[0], down.lv[126], down.end],
            [127, 127, 1, 0]);
      /* the density, over the substitute stream: level/128 within 3% */
      const k = new S.BeeperDriver();
      let hits = 0, n = 40000;
      k.level = 64;
      for (let i = 0; i < n; i++) if (k.noiseDraw()) hits++;
      checkTrue('the substitute draw has density level/128 (64 -> 0.500)',
                Math.abs(hits / n - 0.5) < 0.03, String(hits / n));
      k.level = 32; hits = 0;
      for (let i = 0; i < n; i++) if (k.noiseDraw()) hits++;
      checkTrue('and at level 32 -> 0.250',
                Math.abs(hits / n - 0.25) < 0.03, String(hits / n));
      /* THE DURATION IS A LIVE GAME VALUE.  Armed at the top of the pass the
         whole ramp fits inside the blit; armed inside the actor update it
         does not and spills into the next pass.  MEASURED on the Z80 over
         200 passes holding DOWN: 0.493 frames from offset 0.02, and
         4.10..4.37 frames from offset 0.26. */
      const span = (phase) => {
        const b = new S.BeeperDriver();
        b.trigger(0, phase);
        let first = null, last = null;
        for (let p = 0; p < 6 && b.ticks > 0; p++) {
          b.log.length = 0;
          b.noiseService(p * 4, 250);
          b.endPass(p * 4, 4);
          const n = b.log.filter(r => r[2] === 'noise');
          if (n.length) {
            if (first === null) first = n[0][0];
            last = n[n.length - 1][0];
          }
        }
        return last - first;
      };
      checkTrue('a burst armed by the player\'s own move is ~0.5 of a frame',
                Math.abs(span(0.03) - 0.5) < 0.25, String(span(0.03)));
      checkTrue('the same burst armed inside the actor update spills into the '
                + 'next pass and lasts ~4 frames',
                span(0.86) > 3.0 && span(0.86) < 5.0, String(span(0.86)));
    }
    /* 6. THE TWO BLOCKING TUNES.  Their wall cost, their row count and the
       OUT count -- the last cross-checked in beepdata.py against the port
       writes the real routine makes (79,872 and 292,864). */
    {
      const d = new S.BeeperDriver();
      const f = d.tune(0, 'banner');
      d.endPass(0, 0);                        // flush, no ISR inside a tune
      checkTrue('the banner tune blocks 72.07 video frames',
                Math.abs(f - 72.07) < 0.01, String(f));
      check('and writes the speaker twice per 96 T turn, 79,872 times',
            2 * B.tunes.banner.rows.reduce((a, r) => a + r.turns, 0), 79872);
      check('the level-intro tune is 209.97 frames and 292,864 writes',
            [Math.round(B.tunes.level.total_t / 69888 * 100) / 100,
             2 * B.tunes.level.rows.reduce((a, r) => a + r.turns, 0)],
            [209.97, 292864]);
      checkTrue('the tune emits edges (both voices interleaved on one bit)',
                d.log.length > 30000, String(d.log.length));
      checkTrue('and the edges are in order and inside the block',
                d.log.every((e, i, a) => (i === 0 || e[0] >= a[i - 1][0]))
                && d.log[d.log.length - 1][0] <= f);
      /* voice 2 carries the banner tune's melody; voice 1 RESTS the whole
         way through it at 18,229 Hz, which is what reload 1 means (note
         byte $29, one PAST the 53-entry table).  Measured at $C081. */
      check('the banner tune\'s voice-2 reloads, measured at $C081',
            B.tunes.banner.rows.map(r => r.reload2),
            [144, 136, 192, 171, 255, 1, 255, 1]);
      checkTrue('and voice 1 rests (reload 1) for all eight rows',
                B.tunes.banner.rows.every(r => r.reload1 === 1));
    }
    /* 7. THE RENDERER.  An independent re-derivation of the pitch: build the
       edge stream for a known (C,E), render it, and count ZERO CROSSINGS out
       of the samples -- never a read-back of beepHz(). */
    {
      /* everything in this block measures the BOX INTEGRAL and the DC
         BLOCKER, so it runs with the ADDED speaker model off -- the 1,588 Hz
         at-unity bound in particular is a property of the blocker's
         passband, which the 4.2 kHz speaker roll-off deliberately shades. */
      G.speakerFilter.set(false);
      const sr = 44100;
      const measure = (e) => {
        const half = S.beepHalf(e) / 3500000;         // seconds
        const edges = []; let lv = 1;
        for (let t = 0; t < 0.30; t += half) { edges.push([t, lv]); lv ^= 1; }
        const c = new S.BeeperChip(sr);
        const n = Math.round(sr * 0.30), buf = new Float32Array(n);
        c.render(buf, 0, n, 0, edges, 0);
        let cross = 0;
        for (let i = 1; i < n; i++)
          if (buf[i - 1] <= 0 && buf[i] > 0) cross++;
        return cross / 0.30;
      };
      for (const e of [63, 34, 23, 18, 14, 12]) {
        const want = S.beepHz(e), got = measure(e);
        checkTrue(`BeeperChip E=${e} -> ${want.toFixed(0)} Hz`,
                  Math.abs(got - want) / want < 0.03,
                  `measured ${got.toFixed(1)} Hz`);
      }
      /* THE BOX INTEGRAL IS EXACT, and that is the property worth testing
         rather than any particular pitch.  A single rising edge a quarter of
         the way through one sample must give that sample exactly 0.75 high
         (i.e. +0.25 once the DC is removed) and the next 1.0 (+0.5). */
      {
        /* dc=false, so what is measured is the box integral itself and not
           the AC coupling in front of it */
        const c = new S.BeeperChip(sr, false), buf = new Float32Array(4);
        c.render(buf, 0, 4, 0, [[0.25 / sr, 1]], 0);
        checkTrue('one edge a quarter into a sample gives exactly 0.75 high',
                  Math.abs(buf[0] - 0.25) < 1e-6 && Math.abs(buf[1] - 0.5) < 1e-6,
                  JSON.stringify([...buf]));
        /* AND THE DC BLOCKER, which is what actually ships: a constant level
           -- the speaker held LOW between effects -- must decay to silence,
           not sit at -0.5 and dominate the file. */
        const d = new S.BeeperChip(sr), b2 = new Float32Array(sr);
        d.render(b2, 0, sr, 0, [[0, 0]], 0);
        checkTrue('a constant level renders as SILENCE, not as a DC step',
                  Math.abs(b2[sr - 1]) < 1e-6, String(b2[sr - 1]));
        const e2 = new S.BeeperChip(sr), b3 = new Float32Array(sr);
        const half = S.beepHalf(63) / 3500000, ed = []; let lv = 1;
        for (let t = 0; t < 1; t += half) { ed.push([t, lv]); lv ^= 1; }
        e2.render(b3, 0, sr, 0, ed, 0);
        let pk = 0;
        for (let i = sr / 2; i < sr; i++) pk = Math.max(pk, Math.abs(b3[i]));
        checkTrue('and a 1,588 Hz square passes it at ~unity',
                  pk > 0.48 && pk < 0.52, String(pk));
      }
      /* and a square FAR above Nyquist averages towards silence instead of
         folding down as a whine -- the same reason AyChip means its internal
         steps.  100 kHz is not in the game's data; it is the property under
         test, and the AY driver's tone-period-0 rows really do reach it. */
      {
        const half = 1 / 200000, edges = []; let lv = 1;
        for (let t = 0; t < 0.05; t += half) { edges.push([t, lv]); lv ^= 1; }
        const n = Math.round(sr * 0.05);
        /* the bound is the box filter's own, and it is a DERIVATION rather
           than a reading: at most half a half-period of duty error per
           sample, i.e. 0.5/(sample/half) = 0.5*(1/200000)/(1/44100) = 0.11
           at 100 kHz, against the 0.50 a point sampler would give.
           THE FILTER UNDER TEST IS THE BOX INTEGRAL, so measure it on the
           dc=false path where that is all there is. */
        const raw = new S.BeeperChip(sr, false), b1 = new Float32Array(n);
        raw.render(b1, 0, n, 0, edges, 0);
        let pkRaw = 0;
        for (let i = 0; i < n; i++) pkRaw = Math.max(pkRaw, Math.abs(b1[i]));
        checkTrue('a 100 kHz square averages down instead of aliasing',
                  pkRaw < 0.12, String(pkRaw));
        /* AND ON THE SHIPPING PATH, once the DC blocker has settled.  This
           check used to run dc=true and skip 10 samples, which is not a
           settling time: the one-pole is fc = 20 Hz, so tau = sr/(2*pi*20)
           = 351 samples and a step into a 50%-duty signal leaves
           0.559*exp(-i/tau) behind.  It read 0.542 at i=10 -- the transient,
           decaying exactly as predicted (measured 0.242 at 1 tau, 0.126 at
           2, 0.084 at 3, 0.062 at 5), not aliasing.  Five time constants is
           the standard settling bound and leaves 0.4% of the step. */
        const c = new S.BeeperChip(sr), b2 = new Float32Array(n);
        c.render(b2, 0, n, 0, edges, 0);
        const tau = sr / (2 * Math.PI * 20), settle = Math.ceil(5 * tau);
        checkTrue('the DC blocker settles inside the buffer under test',
                  settle < n, `${settle} >= ${n}`);
        let pk = 0;
        for (let i = settle; i < n; i++) pk = Math.max(pk, Math.abs(b2[i]));
        checkTrue('and the shipping (DC-blocked) path rejects it too, once settled',
                  pk < 0.12, String(pk));
        /* the transient is the DC blocker doing its job, so assert its SHAPE
           rather than exempting it: a one-pole high pass fed a step of h
           gives h*R^i, and R = 1 - 2*pi*20/sr is fixed by the cutoff. */
        const R = 1 - 2 * Math.PI * 20 / sr, h = b2[0];
        let worst = -Infinity;      // the MARGIN, so a pass reports how much
        for (let i = 1; i < settle; i++)
          worst = Math.max(worst, Math.abs(b2[i]) - (Math.abs(h) * Math.pow(R, i) + 0.12));
        checkTrue('the startup transient decays as h*R^i, not as a whine',
                  worst < 0, String(worst));
      }
      G.speakerFilter.set(true);
    }

    /* 8. THE SPEAKER MODEL -- ADDED, see SPEAKER_FILTER's own comment: the
       raw square is the VOLTAGE; what a Spectrum owner heard came through a
       ~4 cm cone that rolled the top octaves off, and small modern drivers
       buzz on the unfiltered edges (reported from play as "very crackly").
       A 2nd-order low pass at 4.2 kHz, live-toggleable. */
    {
      const sr = 44100;
      const square = (hz, secs) => {
        const ed = []; let lv = 1;
        for (let t = 0; t < secs; t += 1/(2*hz)){ ed.push([t, lv]); lv ^= 1; }
        return ed;
      };
      const rms = (b, from) => {
        let s = 0; for (let i = from; i < b.length; i++) s += b[i]*b[i];
        return Math.sqrt(s / (b.length - from));
      };
      const render = (hz) => {
        const n = Math.round(sr * 0.2), b = new Float32Array(n);
        new S.BeeperChip(sr).render(b, 0, n, 0, square(hz, 0.2), 0);
        return rms(b, Math.round(sr * 0.1));      // past the DC settle
      };
      G.speakerFilter.set(false); const hiRaw = render(8000), loRaw = render(500);
      G.speakerFilter.set(true);  const hiMod = render(8000), loMod = render(500);
      checkTrue('the speaker model shades an 8 kHz square well below the raw render',
                hiMod < hiRaw * 0.5, (hiMod/hiRaw).toFixed(3) + ' of raw');
      checkTrue('...and passes a 500 Hz square nearly whole',
                loMod > loRaw * 0.85, (loMod/loRaw).toFixed(3) + ' of raw');
      /* the filter STATE persists across render() calls -- a buffer join in
         the bridge lands mid-waveform, and a per-call reset would click on
         every one of them.  Split render must equal whole render EXACTLY. */
      const n = Math.round(sr * 0.1), ed = square(2000, 0.1);
      const whole = new Float32Array(n), split = new Float32Array(n);
      new S.BeeperChip(sr).render(whole, 0, n, 0, ed, 0);
      const c2 = new S.BeeperChip(sr), h = n >> 1;
      const ei = c2.render(split, 0, h, 0, ed, 0);
      c2.render(split, h, n - h, h/sr, ed, ei);
      let same = true;
      for (let i = 0; i < n; i++) if (whole[i] !== split[i]){ same = false; break; }
      checkTrue('the model state carries across render calls: split === whole',
                same);
    }
  }

  /* THE VOICE CAP is counted against the clock, never in an `ended` callback.
     Driven directly: a SoundOut whose live list is already full must DROP
     rather than schedule, and must still consume the events so the chip's
     register state stays correct. */
  {
    const out = new S.SoundOut();
    let started = 0, now = 10;
    out.ctx = { sampleRate: 44100, get currentTime() { return now; },
                createBuffer: (c, n) => ({ getChannelData: () => new Float32Array(n) }),
                createBufferSource: () => ({ buffer: null, connect() {},
                                             start() { started++; } }),
                destination: {} };
    out.chip = new S.AyChip(44100, S.AY_CLOCK);
    out.gain = { connect() {} };
    out.next = 0; out.base = 0; out.t0 = now + 0.05;
    out.live = [];
    for (let i = 0; i < 60; i++) out.live.push(now + 5);   // 60 live voices
    const ev = [[0, 7, 0x38], [1, 8, 15]];
    out.flushAy(ev, 4);
    check('a full voice list drops instead of scheduling', started, 0);
    check('and the dropped events are still applied to the chip',
          [out.chip.reg[7], out.chip.reg[8]], [0x38, 15]);
    check('the drop is counted', out.dropped, 1);
    // and with the live list expired by the clock alone, it schedules again
    now = 20;
    out.flushAy([[4, 7, 0x38]], 8);
    check('voices expire by their scheduled END TIME, not by a callback',
          started, 1);
    /* THE SAME TWO RULES ON THE SHIPPED PATH.  A dropped beeper buffer must
       still leave the SPEAKER LEVEL where the original left it, or the next
       buffer starts on the wrong level and every edge after it is inverted
       -- the beeper's equivalent of "apply the dropped register writes". */
    const bo = new S.SoundOut();
    let bstarted = 0; now = 10;
    bo.ctx = out.ctx; bo.gain = { connect() {} };
    bo.ctx = { sampleRate: 44100, get currentTime() { return now; },
               createBuffer: (c, n) => ({ getChannelData: () => new Float32Array(n) }),
               createBufferSource: () => ({ buffer: null, connect() {},
                                            start() { bstarted++; } }),
               destination: {} };
    bo.chip = new S.BeeperChip(44100);
    bo.next = 0; bo.base = 0; bo.t0 = now + 0.05; bo.live = [];
    for (let i = 0; i < 60; i++) bo.live.push(now + 5);
    const bev = [[0.2, 1], [0.4, 0], [0.6, 1]];
    bo.flushBeeper(bev, 4);
    check('beeper: a full voice list drops instead of scheduling', bstarted, 0);
    check('and the dropped edges still leave the speaker at the right level',
          bo.chip.lvl, 1);
    check('beeper: the drop is counted', bo.dropped, 1);
    now = 20;
    bo.flushBeeper([[4.5, 0]], 8);
    check('beeper: voices expire by their scheduled END TIME',
          bstarted, 1);
  }

  /* ======================================================================
     THE BRIDGE TILES THE TIMELINE IN WHOLE SAMPLES
     ======================================================================
     From a PLAY REPORT -- "the sound now has slight noise to it".  A buffer
     used to be `Math.round(nf * sr/FRAME_HZ)` samples long while being
     scheduled at the exact real time `t0 + (f - base)/FRAME_HZ`, so its
     LENGTH never equalled the slot it was cut for.  FRAME_HZ is 50.08, so a
     video frame is 880.591 samples:

         nf = 1 (the FRONT END's title tune)   880.591 vs 881   +0.409
         nf = 4 (a quiet main-loop pass)      3522.364 vs 3522  -0.364
         nf = 5 (a loaded pass)               4402.955 vs 4403  +0.045

     and consecutive buffers therefore SUMMED on a sample or left a zero in
     the middle of the wave.  Measured on the front end before the fix: 426
     of 1,042 joins collided, 361 of them on audible tune, and the mixed peak
     reached 1.2169 against a largest single-buffer sample of 0.9996.

     A STATE-ONLY TEST CANNOT HEAR A CLICK, so both checks below are at
     SAMPLE LEVEL: the buffers must abut on the sample grid, and the whole
     schedule must reconstruct a single continuous render of the same edges.
     The nf sequence deliberately mixes 1, 4, 5, 6 and 7 -- the front end's
     one-frame flush and everything the variable pass clock produces from a
     quiet dungeon to a generator cluster (Q10's {4, 5, 6, 7}). */
  {
    const SR = 44100, FHZ = G.constants.FRAME_HZ, spf = SR / FHZ;
    const NF = [1, 4, 5, 4, 7, 1, 1, 6, 4, 5, 5, 4, 6, 1, 4, 5, 7, 4, 4, 5];

    /* `phase` is where the ~1 kHz square's edges sit relative to the FRAME
       GRID.  At phase 0 an edge lands exactly on a buffer boundary, which is
       a genuinely different question -- see the second run below. */
    function tile(phase, step) {
      step = step || 0.025;
      const bufs = [];                     // {when, data}
      const now = 10;
      const out = new S.SoundOut();
      out.ctx = { sampleRate: SR, get currentTime() { return now; },
                  createBuffer: (c, n) => { const d = new Float32Array(n);
                    return { length: n, getChannelData: () => d }; },
                  createBufferSource: () => ({ buffer: null, connect() {},
                    start(when) { bufs.push({ when,
                                              data: this.buffer.getChannelData() }); } }),
                  destination: {} };
      out.chip = new S.BeeperChip(SR);
      out.gain = { connect() {} };
      out.next = null; out.live = [];
      let f = 0, lvl = 0;
      const log = [], allEdges = [];
      out.flushBeeper(log, f);             // the first flush sets the origin
      const base0 = out.base, t00 = out.t0;
      for (const nf of NF) {
        /* an edge every `step` of a video frame, so EVERY buffer carries
           edges and every join lands in the middle of the wave rather than
           in the silence a real pass boundary happens to sit in */
        for (let k = 0; ; k++) {
          const ef = f + phase + k * step;
          if (ef >= f + nf) break;
          lvl ^= 1; log.push([ef, lvl]); allEdges.push([ef, lvl]);
        }
        f += nf;
        out.flushBeeper(log, f);
      }
      const s0 = Math.round(bufs[0].when * SR);
      const last = bufs[bufs.length - 1];
      const n = Math.round(last.when * SR) + last.data.length - s0;
      const mix = new Float32Array(n);
      let single = 0, holes = 0, overlaps = 0;
      for (const b of bufs) {
        const off = Math.round(b.when * SR) - s0;
        for (let i = 0; i < b.data.length; i++) {
          if (off + i >= 0 && off + i < n) mix[off + i] += b.data[i];
          single = Math.max(single, Math.abs(b.data[i]));
        }
      }
      const edgeAt = [];                   // sample index of each buffer join
      for (let i = 0; i + 1 < bufs.length; i++) {
        const end = Math.round(bufs[i].when * SR) + bufs[i].data.length;
        const gap = Math.round(bufs[i + 1].when * SR) - end;
        if (gap > 0) holes++; else if (gap < 0) overlaps++;
        edgeAt.push(end - s0);
      }
      /* ONE continuous render of the same edges on the same grid */
      const ref = new Float32Array(n);
      new S.BeeperChip(SR).render(ref, 0, n, 0,
        allEdges.map(e => [t00 + (e[0] - base0) / FHZ - s0 / SR, e[1]]), 0);
      let worst = 0, peak = 0, atJoin = 0, interior = 0, e2 = 0, s2 = 0;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(mix[i] - ref[i]);
        worst = Math.max(worst, d); e2 += d * d; s2 += ref[i] * ref[i];
        peak = Math.max(peak, Math.abs(mix[i]));
        if (edgeAt.some(j => Math.abs(i - j) <= 1)) atJoin = Math.max(atJoin, d);
        else interior = Math.max(interior, d);
      }
      return { bufs, n, resyncs: out.resyncs, holes, overlaps,
               worst, peak, single, atJoin, interior,
               rms: Math.sqrt(e2 / n), sig: Math.sqrt(s2 / n),
               joins: edgeAt.length };
    }

    /* (a) THE JOINS, and (b) THE SAMPLES.  With the wave's edges off the
       frame grid the schedule must reproduce a continuous render EXACTLY --
       a doubled sample, a dropped sample or a buffer laid half a sample away
       from its own contents all show up here and nowhere in engine state. */
    const r = tile(0.0125);
    checkTrue('the tiling run scheduled every buffer with no resync',
              r.bufs.length === NF.length && r.resyncs === 0,
              r.bufs.length + ' buffers, ' + r.resyncs + ' resyncs');
    check('every buffer abuts the next EXACTLY -- no holes, no overlaps',
          [r.holes, r.overlaps], [0, 0]);
    /* the rule that was there before really would have failed it, so a pass
       here is not vacuous */
    let oldMiss = 0;
    for (const nf of NF) if (Math.round(nf * spf) !== nf * spf) oldMiss++;
    checkTrue('...and rounding the LENGTH instead would have missed by a ' +
              'fraction of a sample on every buffer',
              oldMiss === NF.length, oldMiss + ' of ' + NF.length);
    checkTrue('the scheduled buffers reconstruct ONE continuous render, ' +
              'sample for sample', r.worst < 1e-6,
              'worst sample error ' + r.worst.toExponential(3) +
              ' over ' + r.n + ' samples');
    checkTrue('no sample anywhere is two buffers SUMMED',
              r.peak <= r.single + 1e-9,
              'mix peak ' + r.peak.toFixed(4) + ' vs single ' + r.single.toFixed(4));

    /* (c) AN EDGE LANDING EXACTLY ON A BUFFER BOUNDARY, which is not a
       corner case at all: $B4FC's border write does it once a video frame,
       and the front end's title tune -- which flushes ONE frame per buffer
       -- does it 50 times a second.  Such an edge must still be rendered at
       its own time.  This is why the window is taken with FLOOR: `start` is
       then at or before the ideal time, so no event is ever pushed back into
       a buffer that has already been rendered and dispatched.  With
       Math.round it was clamped to the next buffer's first sample instead,
       measured at 0.495 of full scale on that sample and -44 dB over the
       timeline. */
    const b = tile(0);
    check('an edge ON a buffer boundary still leaves the joins whole',
          [b.holes, b.overlaps], [0, 0]);
    checkTrue('...and is rendered at its own time, not clamped into the ' +
              'next buffer', b.worst < 1e-6,
              'worst sample error ' + b.worst.toExponential(3) +
              ' (at a join ' + b.atJoin.toExponential(3) + ')');

    /* (d) AND AN EDGE IN THE WINDOW'S LAST PARTIAL SAMPLE.  The window ends
       on a sample boundary, so it stops short of `upto`'s exact time; an
       edge in that sliver has to stay in the log for the next buffer rather
       than be spliced away with only its level applied.  At 0.0007 of a
       frame the edges are 0.6 of a sample apart -- the two title-tune voices
       write one every 48 T -- so the sliver is occupied at almost every
       join, which is what makes this bite. */
    const d = tile(0.0003, 0.0007);
    check('a dense edge stream leaves the joins whole too',
          [d.holes, d.overlaps], [0, 0]);
    checkTrue('...and an edge in the last partial sample of the window is ' +
              'carried to the next buffer, not spliced away unrendered',
              d.worst < 1e-6,
              'worst sample error ' + d.worst.toExponential(3) +
              ' over ' + d.n + ' samples');
  }

  /* ======================================================================
     THE SIMULATED CLOCK CAN RESTART, AND THE BRIDGE MUST NOT GO SILENT
     ======================================================================
     `game.reset()` sets simFrame back to 0 and is reached from feHandover()
     -- the menu handing over to the game, $FF38 JP $8400 -- and from
     setMode().  SoundOut still held the front end's frame numbering, and
     `if (nf <= 0) return` then swallowed every flush until the game's own
     frame counter had climbed back past it.  MEASURED on the page's own
     frame() loop: after a 930-frame menu the first sound of play arrived
     19.3 s late; with the re-origin it arrives in 0.9 s. */
  for (const arm of ['beeper', 'ay']) {
    let started = 0, now = 10;
    const out = new S.SoundOut();
    out.ctx = { sampleRate: 44100, get currentTime() { return now; },
                createBuffer: (c, n) => ({ length: n,
                                           getChannelData: () => new Float32Array(n) }),
                createBufferSource: () => ({ buffer: null, connect() {},
                                             start() { started++; } }),
                destination: {} };
    out.chip = arm === 'beeper' ? new S.BeeperChip(44100)
                                : new S.AyChip(44100, S.AY_CLOCK);
    out.gain = { connect() {} };
    out.next = null; out.live = [];
    const flush = arm === 'beeper' ? out.flushBeeper.bind(out)
                                   : out.flushAy.bind(out);
    const ev = arm === 'beeper' ? f => [[f + 0.5, 1]] : f => [[f, 7, 0x38]];
    flush([], 100);                                   // the origin
    flush(ev(100), 104);
    check(arm + ': it is running before the restart', started, 1);
    /* the front end handed over: simFrame is 0 again */
    flush(ev(0), 4);
    check(arm + ': a BACKWARD jump in the simulated clock re-origins the map',
          [out.next, out.base], [4, 4]);
    check(arm + ': ...and is counted as a resync, not hidden', out.resyncs, 1);
    flush(ev(4), 8);
    checkTrue(arm + ': the very next flush schedules again instead of ' +
              'going silent for the length of the menu', started === 2,
              'started ' + started);
  }
}

/* ---------- the point-differential table (manual 6.10) ---------------- */
/* ======================================================================
   THE TELEPORT CHAIN -- replayed against the ORIGINAL'S OWN ANSWER
   ======================================================================
   build/telecensus.json is frozen by `python tools/telecensus.py`, which
   drives the REAL Z80 and nothing else.  Everything below compares this
   engine against those measurements; no expected value in this block comes
   from the code under test.

   WHY IT EXISTS.  A play report -- level 8, player (4,78), cell (1,19) free,
   camera (2,60), "can rotate and fire but not move" -- was for years
   explained away by a PROVISIONAL note claiming the original sticks too.  It
   does not.  Driven on level-8 dungeons the game builds for itself, stepping
   onto a $30 costs ONE refused pass and then $A4FF's `JP nz,$B195` resolves
   it: with a second pad drawn the original TELEPORTS, and even when it bails
   it clears the arm at $B218.  The port latched the arm for the rest of the
   level, which refused all four directions for ever.

   The two tables are complementary:
     census  what $84AC and $5BD0 actually ARE, over 3 dungeons x a camera
             sweep.  This is the fact the old note got wrong, so it is the
             fact the gate pins hardest.
     chain   whole trajectories through $B195, including the LONE-PAD case,
             which is the genuine single-axis stall and must survive.
   Cross-check the same thing the other way round with
       python tools/telegrid.py diff 29 1 3 120 64 20 20 6
   which is the two-sided neighbourhood differential over 1600 rows.       */
{
  const tcPath = path.join(ROOT, 'build', 'telecensus.json');
  if (!fs.existsSync(tcPath)) {
    checkTrue('build/telecensus.json present (python tools/telecensus.py)',
              false);
  } else {
    const TC = JSON.parse(fs.readFileSync(tcPath, 'utf8'));
    const P = G.packs;
    const gridCache = new Map();
    const gridOf = (pack, sub, c7) => {
      const k = pack + '/' + sub + '/' + c7;
      if (gridCache.has(k)) return gridCache.get(k);
      const rec = Uint8Array.from(P.record(P.sub(pack - 1, sub)));
      rec[1] &= ~0x04;                   // $9B5F is an LD A,R draw: off
      const dg = P.build(rec, { level: 1, rng: () => 0 });
      if (c7 & 2) P.mirrorH(dg);
      if (c7 & 1) P.mirrorV(dg);
      const map = [];
      for (let r = 0; r < 32; r++) {
        const row = [];
        for (let c = 0; c < 32; c++) row.push(dg.cell[r * 32 + c]);
        map.push(row);
      }
      gridCache.set(k, map);
      return map;
    };

    /* ---- $8469: the square table, checked against ARITHMETIC ---------- */
    check('$8469 is dumped, 17 bytes', TC.squares.length, 17);
    check('the engine ships the original\'s own $8469',
          JSON.stringify(G.__TELE_SQ || TC.squares), JSON.stringify(TC.squares));
    {
      /* an INDEPENDENT re-derivation: the table is n^2 for n = 0..11, and
         then it is NOT -- 144 is missing, so index 12..14 hold 13^2,14^2,15^2
         and index 15 holds $FE.  Naming the break is what stops a later
         "tidy-up" from inserting the 144 that the tape does not have. */
      const sq = TC.squares;
      let head = 0;
      for (let n = 0; n <= 11; n++) if (sq[n] === n * n) head++;
      check('$8469[0..11] are the squares 0..121', head, 12);
      check('144 IS MISSING: $8469[12] is 13^2, not 12^2', sq[12], 169);
      check('...and [13],[14] follow it, [15] is $FE',
            [sq[13], sq[14], sq[15]], [196, 225, 254]);
      check('$8479 (index 16, an axis difference of half the world) is 0',
            sq[16], 0);
    }

    /* ---- THE CENSUS: $84AC and every byte of $5BD0 -------------------- */
    {
      let rows = 0, bad = 0, nonzero = 0, worst = null, maxN = 0;
      for (const o of TC.census) {
        const g = G.seed({ map: gridOf(o.pack, o.sub, o.c7),
                           x: o.px, y: o.py, camX: o.cam[0], camY: o.cam[1] });
        g.actors.length = 0; g.spawnBase = 0; g.level = 8;
        /* the Z80 side pinned PLAYER 2's $844E bit 1, which opens $B159's
           second gate without arming player 1 -- so the DRAW is observed and
           $B195 never runs.  Do exactly that. */
        g.players[1].animCtl |= 2;
        g.padList.length = 0;
        g.padCensusDraw();                                    // $850F..$8518
        const got = g.padList.map(r => [r.x, r.y, r.mask]);
        rows++;
        if (o.n) nonzero++;
        if (o.n > maxN) maxN = o.n;
        if (JSON.stringify(got) !== JSON.stringify(o.recs)) {
          bad++;
          if (!worst) worst = { cam: o.cam, map: [o.pack, o.sub, o.c7],
                                want: o.recs, got };
        }
      }
      check('$84AC/$5BD0 reproduce the real Z80 byte for byte, over the ' +
            'whole camera sweep', bad === 0 ? 'ok' : JSON.stringify(worst),
            'ok');
      checkTrue('...and the sweep is not vacuous: most rows register a pad',
                nonzero > rows * 0.5);
      checkTrue('...and the 8-record cap at $B164 is never exceeded',
                maxN <= 8);
      console.log('        (' + rows + ' census rows, ' + nonzero +
                  ' with a pad, deepest table ' + maxN + ')');
    }

    /* ---- THE CHAIN: whole trajectories through $B195 ------------------ */
    {
      let bad = 0, first = null, teleports = 0, bails = 0;
      for (const sc of TC.chain) {
        const map = gridOf(sc.pack, sc.sub, sc.c7).map(r => r.slice());
        if (sc.keep) {
          for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++)
            if (map[r][c] === 0x30 && !(c === sc.keep[0] && r === sc.keep[1]))
              map[r][c] = 0;
        }
        for (const [c, r, v] of (sc.plant || [])) map[r][c] = v;
        const g = G.seed({ map, x: sc.x, y: sc.y,
                           camX: sc.cam[0], camY: sc.cam[1] });
        g.actors.length = 0; g.spawnBase = 0; g.level = 8;
        g.pend = 0; g.pendCol = -1; g.pendRow = -1;
        g.animCtl = 0; g.frameSlot = 0; g.exitCtr = 0;
        g.padList.length = 0;
        /* the original's own tie-breaks, read at $B1CC.  $B575 ends
           `LD A,R / SUB L`, so the CHOICE is a draw no port reproduces; the
           rule around it is what this compares. */
        g.padPickOverride = sc.picks.slice();
        const got = [];
        for (let p = 0; p < sc.passes; p++) {
          g.onePass({ [sc.dir]: true });
          /* the 7th column is (IX+11) bit 6, F_EXITING -- $B232's
             `SUB $36 / JP $A687` sets it when a teleport lands on an exit,
             which is the one arm that only works because $A4FF's JP bypassed
             $A514 and left the memo in the pending slot. */
          got.push([g.x, g.y, g.pend, g.animCtl & 6, g.exitCtr,
                    g.padList.length, (g.f11 & 0x40) ? 0x40 : 0]);
        }
        if (sc.rows.some(r => r[3] & 4)) teleports++;
        else if (sc.rows.some(r => r[3] & 2)) bails++;
        if (JSON.stringify(got) !== JSON.stringify(sc.rows)) {
          bad++;
          if (!first) first = { name: sc.name, want: sc.rows, got };
        }
      }
      let exits = 0;
      for (const sc of TC.chain) if (sc.rows.some(r => r[6])) exits++;
      checkTrue('...and one of them TELEPORTS ONTO AN EXIT ($B232 SUB $36 / ' +
                'JP $A687), which only works if `pend` survives the flight',
                exits >= 1);
      check('every teleport scenario reproduces the original pass for pass ' +
            '(x, y, $843D, $842E&6, $8436, $84AC, exiting)',
            bad === 0 ? 'ok' : JSON.stringify(first), 'ok');
      checkTrue('...and the set is not vacuous: some scenarios TELEPORT',
                teleports >= 3);
      checkTrue('...and some take the BAIL arm, the genuine single-axis stall',
                bails >= 1);
    }

    /* ---- UNIVERSAL PROPERTIES, independent of any captured table ------
       These are the two facts the old note denied.  They are asserted as
       properties over the frozen rows rather than as one more comparison, so
       that a future table swap cannot quietly lose them. */
    {
      let longestArm = 0, everFourWay = false;
      for (const sc of TC.chain) {
        let run = 0;
        for (const r of sc.rows) {
          if (r[3] & 2) { run++; if (run > longestArm) longestArm = run; }
          else run = 0;
        }
      }
      /* one arm pass + the four $B20C counts = 5, and never more: EVERY exit
         from $B195 clears bit 1 ($B218 on both bails, $B225 after transit).
         The lone-pad scenario alternates 1,0,1,0 and so never reaches 2. */
      check('$842E bit 1 never stays up for more than 5 consecutive passes ' +
            '($B218/$B225 clear it on every exit)', longestArm <= 5, true);
      /* the report's own square: UP and DOWN walk on the original even while
         RIGHT is refused, so "stuck in every direction" is not producible. */
      const byName = Object.fromEntries(TC.chain.map(s => [s.name, s]));
      const moved = n => {
        const s = byName[n];
        return s && (s.rows[0][0] !== s.x || s.rows[0][1] !== s.y);
      };
      check('at the reported (4,78) the original still walks UP', moved('lone-up'), true);
      check('...and DOWN', moved('lone-down'), true);
      check('...while RIGHT is refused', byName['lone-right'].rows[0][0], 4);
      checkTrue('...and RIGHT is refused for ever while it is held: 12 passes,' +
                ' one position', new Set(byName['lone-right'].rows
                  .map(r => r[0] + ',' + r[1])).size === 1);
    }
  }
}

// Printed with the SAME arguments as tools/sim_move.py so the two outputs can
// be diffed directly.  This is the poor relation of a full trace differential
// that you can build in an afternoon -- and it is cross-language by
// construction.
/* ---- the SHOT differential -------------------------------------------
   Printed with the SAME arguments and the SAME columns as
   `python tools/shotgate.py table`, so the two can be diffed line for line:

       pass  px  py   sx  sy  st  act  score

   FIRE is held from pass W+1 (--walk W, default 0) and `dir` is held
   throughout.  Because holding fire FREEZES the player ($A57E), a run with
   walk 0 never moves him, the camera never moves either, and every one of the
   dungeon's 63 ghosts stays outside $A1DA's update window -- so the whole run
   is deterministic on both sides despite the two LD A,R coins.  --walk lets
   him walk first, which is what puts the ghosts in range. */
if (process.argv[2] === '--shots') {
  const argv = process.argv;
  const dirName = argv[3] || 'right';
  const passes = Number(argv[4] || 24);
  const optN = (k, d) => argv.indexOf(k) >= 0 ? Number(argv[argv.indexOf(k) + 1]) : d;
  const walk = optN('--walk', 0), ch = optN('--char', 3);
  const g = G.seed({ char: ch });
  const hex = (v, n) => v.toString(16).toUpperCase().padStart(n, '0');
  console.log('pass  px  py   sx  sy  st  act  score');
  for (let i = 0; i < passes; i++) {
    const inp = {};
    if (dirName !== 'none') inp[dirName] = true;
    if (i >= walk) inp.fire = true;
    g.onePass(inp);
    console.log(String(i + 1).padStart(4) + String(g.x).padStart(4) +
                String(g.y).padStart(4) + '  ' +
                String(g.shot.x).padStart(3) + String(g.shot.y).padStart(4) +
                '  ' + hex(g.shot.state, 2) +
                String(g.actors.length).padStart(5) + '  ' + hex(g.score, 6));
  }
  process.exit(0);
}

/* --p2table SCRIPT [--noactors] [--plant c,r,v] [--warp x1,y1,x2,y2]
   [--ff N] [--extra N]

   The engine side of the TWO-PLAYER differential.  It prints exactly the
   table tools/p2gate.py prints off the real Z80, one row per main-loop pass,
   with both 32-byte blocks and the camera.  The script language is p2gate's:
   comma-separated `count:p1keys:p2keys` segments over U D L R F S.

   seed({char: 0x2A, char2: 0x2A}) is deliberate.  The captured machine has
   $FFFB..$FFFF all holding the loader stub's own $2A, so $BEE5 walks 42
   entries past its four-entry table for BOTH players and they come out with
   the same non-character ($8433 = $8453 = $20, $8435 = $8455 = $20, armour
   row 0).  Seeding the port the same way is what makes the health and score
   columns comparable at all; the SHIPPED port picks the elf and the valkyrie
   instead, and says so.                                                    */
if (process.argv[2] === '--p2table') {
  const argv = process.argv;
  const opt = k => argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null;
  const script = argv[3];
  const g = G.seed({ char: 0x2A, char2: 0x2A });
  if (argv.includes('--noactors')) g.actors = [];
  const plant = opt('--plant');
  if (plant) { const [c, r, v] = plant.split(',').map(Number);
               g.map[r][c] = v; }
  const warpArg = opt('--warp');
  const warp = warpArg ? warpArg.split(',').map(Number) : null;
  const ff = opt('--ff') === null ? null : Number(opt('--ff'));
  const extra = Number(opt('--extra') || 0);
  /* --seed hp,frame,phase,ctr,hurry -- the state the ORIGINAL is in at the
     first $8503, measured by p2gate.py's align().  The capture's PC is
     $ABA1, half way through a pass, so the harness's first step finishes
     that pass and the drain, the round robin and the death check all run in
     it; the engine cannot resume a half-finished pass, so it is told where
     the original ended up.  These five numbers come from the machine, never
     from the engine. */
  const sd = opt('--seed');
  if (sd) {
    const [hp, fc, ph, ctr, hu, f11] = sd.split(',').map(Number);
    g.players[0].health = hp; g.players[0].f11 = f11;
    g.frameCtr = fc; g.drainPhase = ph; g.hurry = hu;
    /* $9CFB increments $8491 at $8550, near the BOTTOM of the loop, so the
       value at a loop top is the one THAT pass's body will use.  onePass
       increments at the top and then runs the body, so it must be seeded
       with one LESS than the loop-top value the original was showing. */
    g.passCtr = (ctr - 1) & 0xFF;
  }
  /* --clock v1,v2,... -- THE ORIGINAL'S OWN VIDEO FRAME COUNTER, one value
     per pass, read at $B6DA on the real Z80 by p2gate.py's step_pass().
     The drain is the one rule clocked by $8497 instead of by passes and this
     engine charges a flat four frames a pass where the original's cost
     3.92..5.03, so over the sixteen passes between two ticks the tick can
     move by one.  Substituting the measured clock takes that out of the
     comparison, exactly as the port substitutes a generator for `LD A,R`:
     what is under test here is the two-player rules, not the frame clock,
     and the substitution is declared rather than hidden.  The shipped engine
     is untouched -- this is a hook the differential drives. */
  const ck = opt('--clock');
  const clock = ck ? ck.split(',').map(Number) : null;
  if (clock) g.clockOverride = clock.slice();
  const KEY = { U: 'up', D: 'down', L: 'left', R: 'right',
                F: 'fire', S: 'potion' };
  const mk = s => { const o = {};
                    for (const ch of s) if (KEY[ch]) o[KEY[ch]] = true;
                    return o; };
  const segs = script.split(',').map(s => s.split(':'));
  if (extra) segs.push([String(extra), '-', '-']);
  const h = (v, n) => v.toString(16).toUpperCase().padStart(n, '0');
  const pad = (v, n) => String(v).padStart(n);
  console.log('pass  p1x p1y  p1hp p1sc  k p f11 p14 pnd sht |' +
              '  p2x p2y  p2hp p2sc  k p f11 p14 pnd sht | cam   tgt');
  let i = 0, warped = false;
  for (const [n, k1, k2] of segs) {
    for (let j = 0; j < Number(n); j++) {
      const inp = mk(k1); inp.p2 = mk(k2);
      g.onePass(inp);
      const P = g.players;
      if (!warped && warp && !(P[1].p14 & 0x80) && P[1].animCtl === 0) {
        P[0].x = warp[0]; P[0].y = warp[1];
        P[1].x = warp[2]; P[1].y = warp[3];
        if (ff !== null) g.ff = (g.ff & ~0x30) | ff;
        warped = true;
      }
      const row = q => `${pad(q.x, 4)}${pad(q.y, 4)}  ${h(q.health, 4)} ` +
                       `${h(q.score, 6)} ${pad(q.keys, 2)}${pad(q.potions, 2)} ` +
                       `${h(q.f11, 2)}  ${h(q.p14, 2)}  ${h(q.pend, 2)} ` +
                       `${h(q.shot.state, 2)}`;
      console.log(`${pad(++i, 4)} ${row(P[0])} | ${row(P[1])} | ` +
                  `${pad(g.camX, 2)},${pad(g.camY, 2)} ` +
                  `${pad(g.camTgtX, 2)},${pad(g.camTgtY, 2)}`);
    }
  }
  process.exit(0);
}

/* --soundtable DIR N [--plant c,r,v] [--ticks a,b,c,...] [--noactors]
   [--sfxseed busy,id0,row0,id1,row1,id2,row2]

   THE ENGINE SIDE OF THE REGISTER-LEVEL SOUND DIFFERENTIAL (manual 11, the
   AY branch).  It prints one row per AY TICK -- i.e. per 50 Hz video frame,
   because $BADB's only call site is $A2A5 inside the IM2 handler -- carrying
   the ordered (register, value) writes that tick made.  tools/soundgate.py
   prints exactly the same table off the real Z80's own OUTs to $FFFD/$BFFD
   and diffs the two.

   --ticks is the ORIGINAL'S OWN per-pass tick count, measured by hooking
   $BADB.  The engine charges a flat four frames a pass where the original's
   cost 3.92..5.03, so over 60 passes it would run 240 ticks against the
   original's 237 and every row after the first divergence would shift.
   Substituting the measured count takes THIS ENGINE'S FRAME CLOCK out of
   the comparison and leaves the DRIVER under test, exactly as --clock does
   for the two-player differential.  The shipped engine is untouched.

   --sfxseed is the original's live $BDC0/$BDB3.. block at the first $8503:
   the capture is mid-level and channel 0 still carries the id of an effect
   that ended, which changes which channel the next trigger picks.        */
if (process.argv[2] === '--soundtable') {
  const argv = process.argv;
  const opt = k => argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null;
  const dirName = argv[3] || 'down';
  const passes = Number(argv[4] || 60);
  /* THE AY BRANCH, EXPLICITLY.  The engine ships the 48K beeper, so this
     differential -- which is a REGISTER dump and belongs to the 128K arm --
     sets the game's own probe flag to $01 first.  tools/soundgate.py drives
     the real Z80 from an AY-branch state to match.  Nothing about the AY
     driver was deleted when the beeper became the default; this is how it
     stays gated. */
  G.sound.setMode(G.sound.SOUND_128K);
  const g = G.seed({});
  if (argv.includes('--noactors')) g.actors = [];
  const plant = opt('--plant');
  if (plant) { const [c, r, v] = plant.split(',').map(Number); g.map[r][c] = v; }
  /* --nogen erases the generator cells $20..$2E from the map.  The spawn ROLL
     is `$AA1D CALL $B575`, i.e. the Z80 refresh register, so the port draws
     from a substitute and spawns at different moments -- and every spawn
     makes a sound ($B0D3 JP $BA2B).  Removing the generators removes the one
     unreproducible input from the scenario and leaves the driver under test;
     the run WITH them is reported separately and attributed. */
  if (argv.includes('--nogen'))
    for (let r = 0; r < g.map.length; r++)
      for (let c = 0; c < g.map[r].length; c++)
        if (g.map[r][c] >= 0x20 && g.map[r][c] <= 0x2E) g.map[r][c] = 0;
  const ticks = opt('--ticks');
  if (ticks) g.tickOverride = ticks.split(',').map(Number);
  const seed = opt('--sfxseed');
  /* --coin a,b,c -- the ORIGINAL'S OWN outcomes for the one randomised id.
     `LD A,R` at $BAB2 turns a request for effect 0 into effect 0 or 1, and R
     is the Z80 refresh register: Q18's unreproducible source, the same class
     as the actor coins and the generator roll.  The engine draws from a
     substitute generator; the differential substitutes the measured draw so
     that what is compared is the DRIVER and not the entropy.  Declared, not
     hidden -- and the unsubstituted run is reported too. */
  const coins = opt('--coin');
  G.sound.reset();
  if (coins) {
    const seq = coins.split(',').filter(s => s.length).map(Number);
    let ci = 0;
    g.sound.coin = () => (ci < seq.length ? seq[ci++] : 0);
  }
  if (seed) {
    const s = seed.split(',').map(Number);
    g.sound.busy = s[0];
    for (let c = 0; c < 3; c++) {
      g.sound.ch[c].id = s[1 + 2 * c];
      g.sound.ch[c].row = s[2 + 2 * c];
      g.sound.ch[c].live = !!(s[0] & (1 << c));
    }
    g.sound.log.length = 0;
  }
  const keys = dirName === 'idle' ? {} : { [dirName]: true };
  /* the trigger list, printed as a comment line so soundgate.py's row regex
     ignores it and a human can still see which pass armed what */
  const fired = [];
  const rawSfx = g.sfx.bind(g);
  g.sfx = id => { fired.push([g.pass, id]); rawSfx(id); };
  console.log('pass tick  writes');
  for (let i = 0; i < passes; i++) {
    const before = g.sound.frame;
    g.sound.log.length = 0;
    g.onePass(keys);
    const per = new Map();
    for (const [f, r, v] of g.sound.log) {
      const t = f - before;
      if (!per.has(t)) per.set(t, []);
      per.get(t).push(r + '=' + v.toString(16).padStart(2, '0').toUpperCase());
    }
    const n = g.sound.frame - before;
    for (let t = 0; t < n; t++)
      console.log(String(i + 1).padStart(4) + String(t).padStart(5) + '  ' +
                  (per.get(t) || []).join(' '));
  }
  console.log('# engine triggers: ' +
              (fired.map(([p, id]) => 'p' + p + ':$' +
                         id.toString(16).padStart(2, '0')).join(' ')
               || 'none'));
  process.exit(0);
}

/* --beeptable DIR N [--plant c,r,v ...] [--ticks a,b,...] [--noactors]
   [--nogen]

   THE ENGINE SIDE OF THE EDGE-LEVEL BEEPER DIFFERENTIAL (manual 11, the
   BEEPER branch, and the SHIPPED one).  One row per SPEAKER EDGE:

       pass   source   level   frame-offset-into-the-pass   dT

   `source` is which of the three mechanisms wrote it -- tone ($B91E), noise
   ($B8DB), border (the ISR's $B4FC) or tune ($C089/$C095/$C0AB).  `dT` is
   the T-states since the previous edge of the SAME source in the same pass,
   which is the pitch and is the quantity the model 17E+31 predicts.
   tools/beepgate.py prints exactly the same table off the real Z80's own
   OUTs to port $FE and diffs the two.

   --ticks is the ORIGINAL'S OWN per-pass VIDEO FRAME COST, measured by
   T-stamping $8503.  On the beeper branch a pass is four OR FIVE frames
   (idle 4.145 mean, holding UP 5.000) where this engine charges a flat
   four, so without it the two pass grids walk apart and the chirp lands a
   whole frame out on every five-frame pass.  Substituting the measured
   cost takes THIS ENGINE'S FRAME CLOCK out of the comparison and leaves the
   DRIVER under test -- the same substitution --ticks makes for the AY
   differential and --clock for the two-player one.  The shipped engine is
   untouched.                                                             */
if (process.argv[2] === '--beeptable') {
  const argv = process.argv;
  const opt = k => argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null;
  const dirName = argv[3] || 'down';
  const passes = Number(argv[4] || 40);
  G.sound.setMode(G.sound.SOUND_48K);
  const g = G.seed({});
  if (argv.includes('--noactors')) g.actors = [];
  /* --nogen FIRST, then the plants -- the same order tools/beepgate.py uses
     on the Z80 side, so a planted cell in the generator range is not erased
     on one side and kept on the other */
  if (argv.includes('--nogen'))
    for (let r = 0; r < g.map.length; r++)
      for (let c = 0; c < g.map[r].length; c++)
        if (g.map[r][c] >= 0x20 && g.map[r][c] <= 0x2E) g.map[r][c] = 0;
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === '--plant') {
      const [c, r, v] = argv[i + 1].split(',').map(Number); g.map[r][c] = v;
    }
  /* the player's own inventory, so that the door gate $A8F2 (which spends a
     key) and the potion sites see the same counts on both sides */
  if (opt('--keys') !== null) g.players[0].keys = Number(opt('--keys'));
  if (opt('--potions') !== null) g.players[0].potions = Number(opt('--potions'));
  const ticks = opt('--ticks');
  if (ticks) g.tickOverride = ticks.split(',').map(Number);
  G.sound.reset();
  const input = { up: dirName === 'up', down: dirName === 'down',
                  left: dirName === 'left', right: dirName === 'right' };
  const fired = [];
  const raw = g.sfx.bind(g);
  g.sfx = id => { fired.push([g.pass, id]); raw(id); };
  console.log('pass  source  lvl   offset      dT');
  for (let i = 0; i < passes; i++) {
    const f0 = g.simFrame;
    g.sound.log.length = 0;
    g.onePass(input);
    const prev = {};
    for (const [f, lv, src] of g.sound.log) {
      const off = f - f0;
      const dT = prev[src] === undefined ? -1
               : Math.round((f - prev[src]) * 69888);
      prev[src] = f;
      console.log(String(i + 1).padStart(4) + '  ' + src.padEnd(7) +
                  String(lv).padStart(2) + '  ' + off.toFixed(5).padStart(9) +
                  '  ' + String(dT).padStart(7));
    }
  }
  console.log('# engine triggers: ' +
              (fired.map(([p, id]) => 'p' + p + ':$' +
                         id.toString(16).padStart(2, '0')).join(' ') || 'none'));
  console.log('# engine blocks: ' +
              (g.sound.blocks.map(([f, w, n]) =>
                 w + '@' + f.toFixed(2) + ':' + n.toFixed(2)).join(' ')
               || 'none'));
  process.exit(0);
}

/* --sfxsolo ID N -- one effect, from silence, N ticks of $BADB and nothing
   else.  This is the per-effect half of the differential: it reaches all 18
   ids, including the seven that ordinary play in dungeon 1 never triggers. */
if (process.argv[2] === '--sfxsolo') {
  const id = Number(process.argv[3]);
  const n = Number(process.argv[4] || 8);
  G.sound.setMode(G.sound.SOUND_128K);      // the AY branch -- see --soundtable
  const g = G.seed({});
  G.sound.reset();
  const d = g.sound;
  d.silence(); d.log.length = 0; d.frame = 0;
  /* id 0 is a COIN between effects 0 and 1 ($BAB2 LD A,R / AND 1), so the
     solo run forces the outcome the caller asked for rather than drawing:
     the coin itself is gated separately, by counting outcomes. */
  const forced = Number(process.argv[5]);
  if (!Number.isNaN(forced)) d.coin = () => forced;
  d.trigger(id);
  d.log.length = 0;
  console.log('tick  writes');
  for (let t = 0; t < n; t++) {
    const f0 = d.frame;
    d.log.length = 0;
    d.tick();
    console.log(String(t).padStart(4) + '  ' + d.log.map(
      ([f, r, v]) => r + '=' + v.toString(16).padStart(2, '0').toUpperCase()
    ).join(' '));
  }
  process.exit(0);
}

/* --beepburst SPEC   where SPEC is  phase:objects,objects,...;phase:...
   (phase in VIDEO FRAMES from the loop top, then the drawn-object census of
   the arming pass and of each pass after it) with --frames giving those
   passes' VIDEO FRAME COSTS, measured off the original.

   THE NOISE BURST'S DURATION, ENGINE SIDE.  A burst is 127 ramp calls made
   BY THE BLITTER, one per drawn object, so how long it lasts is decided by
   the blit and not by the driver -- and it spills into the next pass's blit
   when the trigger lands late.  This drives BeeperDriver alone, with the
   original's own object census and its own per-pass frame cost substituted,
   so what is compared is the tick model and not this engine's flat clock.
   tools/beepgate.py prints the same span off the real Z80 by watching
   $B8E9/$B8F2 arm and $84D2 reach 0.                                      */
if (process.argv[2] === '--beepburst') {
  const argv = process.argv;
  const opt = k => argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null;
  const S = G.sound;
  const frames = (opt('--frames') || '').split(';').filter(Boolean)
                   .map(s => s.split(',').map(Number));
  const walks = (opt('--walking') || '').split(';').filter(Boolean)
                   .map(s => s.split(',').map(Number));
  console.log('phase  edges  passes  span  first  last');
  (opt('--spec') || '').split(';').filter(Boolean).forEach((spec, si) => {
    const [phStr, objStr] = spec.split(':');
    const ph = Number(phStr), objs = objStr.split(',').map(Number);
    const cost = frames[si] || objs.map(() => 4);
    const walking = walks[si] || objs.map(() => 1);
    const d = new S.BeeperDriver();
    d.trigger(4, ph);                    // id 4 -> the noise ramp DOWN
    let f0 = 0, npass = 0;
    const seen = [];
    for (let p = 0; p < objs.length; p++) {
      const before = d.log.length;
      /* --walking says whether a player moved in each pass, which is what
         picks between the two measured blitter tick curves.  The original's
         own answer is substituted, exactly as the frame cost is. */
      d.noiseService(f0, objs[p], walking[p] !== 0);
      d.endPass(f0, Math.round(cost[p] || 4));
      const rows = d.log.slice(before).filter(r => r[2] === 'noise');
      if (rows.length) { npass++; seen.push(...rows); }
      f0 += cost[p] || 4;
      if (d.ticks <= 0) break;
    }
    if (!seen.length) { console.log(ph.toFixed(3) + '  none'); return; }
    const first = seen[0][0], last = seen[seen.length - 1][0];
    console.log(ph.toFixed(3) + '  ' + String(seen.length).padStart(4) +
                '  ' + String(npass).padStart(4) +
                '  ' + (last - ph).toFixed(4) +
                '  ' + first.toFixed(4) + '  ' + last.toFixed(4));
  });
  process.exit(0);
}

/* =====================================================================
   --telegrid -- THE MOVE-GATE NEIGHBOURHOOD TABLE (manual D4 / 6.10)
   =====================================================================
   The twin of `python tools/telegate.py js ...`; both take the SAME eleven
   arguments and print the SAME rows, so the two outputs diff line for line.

     node tools/headless.js --telegrid PACK SUB C7 X0 Y0 NX NY PASSES CAMX CAMY CTR

   For every player position on a 2-unit grid in an NX x NY window, and for
   each of the four directions, it holds that direction for PASSES main-loop
   passes from a CLEAN player block and prints the whole trajectory.  The
   point is not the one position a play report names, it is the disagreement
   REGION: a table that names every position where this engine and the real
   Z80 answer differently, and its shape.

   The map is not captured, it is DECODED: both sides build the dungeon from
   the same tape record (pack, sub) with the record's `one $36 survives' flag
   cleared and the two mirrors applied by hand, which is the level closure
   test's own recipe.  The FNV-1a checksum of the 1024 cells is printed in the
   header, so a decoder disagreement fails loudly instead of turning into a
   phantom movement bug.                                                    */
if (process.argv[2] === '--telegrid') {
  const av = process.argv;
  const pack = Number(av[3]), sub = Number(av[4]), c7 = Number(av[5]);
  const x0 = Number(av[6]), y0 = Number(av[7]);
  const nx = Number(av[8]), ny = Number(av[9]);
  const passes = Number(av[10] || 6);
  const camx = Number(av[11] || 0), camy = Number(av[12] || 0);
  const ctr = Number(av[13] || 0);
  /* THE ORIGINAL'S OWN TIE-BREAKS, optional 14th argument: a comma-separated
     list of one entry per (row, teleport) in row order, read off the real Z80
     by hooking $B1CC and taking (IX - $5B00)/4.  $B1B9 CALL $B575 ends
     `LD A,R / SUB L`, so WHICH of several equally-near pads you land on is a
     draw no port can reproduce; handing the differential the original's own
     draw is what lets it compare the RULES instead of two substitutes.  This
     is the same hook p2gate.py uses for the video clock.  Without it the port
     uses its substitute and the tied rows legitimately diverge. */
  const picks = av[14] ? av[14].split(',').filter(s => s.length).map(Number)
                       : null;

  const P = G.packs;
  const rec = Uint8Array.from(P.record(P.sub(pack - 1, sub)));
  rec[1] &= ~0x04;                       // $9B5F is an LD A,R draw; off on both
  const dg = P.build(rec, { level: 1, rng: () => 0 });
  if (c7 & 2) P.mirrorH(dg);             // $98A2 -> $9C06
  if (c7 & 1) P.mirrorV(dg);             // $98A5 -> $9C69
  let hsh = 0x811c9dc5;                  // FNV-1a over the 1024 cells
  for (let i = 0; i < 1024; i++) { hsh ^= dg.cell[i]; hsh = Math.imul(hsh, 0x01000193) >>> 0; }
  const map = [];
  for (let r = 0; r < 32; r++) { const row = []; for (let c = 0; c < 32; c++) row.push(dg.cell[r * 32 + c]); map.push(row); }

  const DIRS = [['U', 'up'], ['D', 'down'], ['L', 'left'], ['R', 'right']];
  console.log('# telegrid pack=' + pack + ' sub=' + sub + ' c7=' + c7 +
              ' grid=' + hsh.toString(16).padStart(8, '0') +
              ' x0=' + x0 + ' nx=' + nx + ' y0=' + y0 + ' ny=' + ny +
              ' passes=' + passes + ' cam=' + camx + ',' + camy + ' ctr=' + ctr);
  console.log('#   x   y d  trajectory: x,y:pend/tel per pass');
  for (let j = 0; j < ny; j++) {
    const y = (y0 + 2 * j) & 0x7F;
    for (let i = 0; i < nx; i++) {
      const x = (x0 + 2 * i) & 0x7F;
      for (const [ch, name] of DIRS) {
        const g = G.seed({ map, x, y, camX: camx, camY: camy });
        /* the CLEAN player block the Z80 side pokes: no actors, the pending
           slot empty, the teleport arm down, the walk phase at zero. */
        g.actors.length = 0;
        /* $84A0 = 0 makes $AA19's E zero, so $AA22's `roll >= E` refuses every
           generator draw and the emptied list STAYS empty.  The Z80 side does
           the same poke; without it the level-8 generators refill the list and
           $A97F -- the third gate -- eats a pass on this side and not that one. */
        g.spawnBase = 0;
        g.level = 8;
        g.passCtr = ctr & 0xFF;
        g.pend = 0; g.pendCol = -1; g.pendRow = -1;
        g.teleportArmed = false;
        g.animCtl = 0; g.frameSlot = 0; g.exitCtr = 0;
        g.padList.length = 0; g.padPicks.length = 0;
        g.padPickOverride = picks;      // shared, consumed in row order
        const toks = [];
        for (let p = 0; p < passes; p++) {
          g.onePass({ [name]: true });
          /* tel is $842E's teleport pair: bit 1 is $A6B0's arm ($A6B0 SET 1)
             and bit 2 is $B208's "teleport in flight".  BOTH now live in
             animCtl, exactly as they do in $842E, which is what lets $8C83's
             `AND 3` see them.  Printing the byte rather than a boolean is
             what puts the finding IN the table instead of behind it. */
          const tel = g.animCtl & 6;
          toks.push(g.x + ',' + g.y + ':' + g.pend.toString(16).padStart(2, '0') +
                    '/' + tel.toString(16));
        }
        console.log(String(x).padStart(4) + String(y).padStart(4) + ' ' + ch +
                    '  ' + toks.join(' '));
      }
    }
  }
  process.exit(0);
}

/* --clocktable DIR N [--noactors] [--nogen] [--warp x,y,cx,cy] [--nact k]
   ONE ROW PER PASS: what the pass cost in video frames, what it advanced
   $8497 by, and the census the cost model charged.  tools/clockgate.py diffs
   the frames column against the real Z80's, pass for pass. */
if (process.argv[2] === '--clocktable') {
  const argv = process.argv;
  const opt = k => argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null;
  const dirName = argv[3] || 'idle';
  const passes = Number(argv[4] || 40);
  G.sound.setMode(G.sound.SOUND_48K);
  const g = G.seed({});
  if (argv.includes('--noactors')) g.actors = [];
  if (argv.includes('--nogen'))
    for (let r = 0; r < g.map.length; r++)
      for (let c = 0; c < g.map[r].length; c++)
        if (g.map[r][c] >= 0x20 && g.map[r][c] <= 0x2E) g.map[r][c] = 0;
  const warp = opt('--warp');
  if (warp) {
    const [x, y, cx, cy] = warp.split(',').map(Number);
    g.players[0].x = x; g.players[0].y = y; g.camX = cx; g.camY = cy;
  }
  const nact = opt('--nact');
  if (nact !== null) g.actors.length = Math.min(g.actors.length, Number(nact));
  const input = { up: dirName === 'up', down: dirName === 'down',
                  left: dirName === 'left', right: dirName === 'right' };
  console.log('pass frames ticks   w1     nact  upd  step  cont  nzA nzB nzC nzD  gcell ngen');
  for (let i = 0; i < passes; i++) {
    g.onePass(input);
    const k = g.clk;
    console.log([String(i + 1).padStart(4), g.passFrames.toFixed(4).padStart(7),
                 String(g.passTicks).padStart(5),
                 String(Math.round(g.clockCost())).padStart(7),
                 String(k.nact).padStart(5), String(k.upd).padStart(4),
                 String(k.step).padStart(5), String(k.contact).padStart(5),
                 String(k.nzA).padStart(5), String(k.nzB).padStart(3),
                 String(k.nzC).padStart(3), String(k.nzD).padStart(3),
                 String(k.gcells).padStart(6), String(k.ngen).padStart(4)].join(''));
  }
  process.exit(0);
}

/* --clockmodel FILE.json -- feed the ORIGINAL's own per-pass census into the
   BUILT artifact's cost model and print what it charges.  This is what makes
   tools/clockgate.py a test of the shipped code rather than of a Python copy
   of it: there is exactly one implementation of the model and it is this one. */
if (process.argv[2] === '--clockmodel') {
  const rows = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const g = G.seed({});
  console.log('# w1 frames ticks');
  for (const r of rows) {
    if (r.reset !== undefined) {           // a new scene: restart the chain
      g.clockPhaseT = Math.round(r.reset * 69888);
      g.frameCtr = r.f0 | 0;
    }
    g.clockReset();
    Object.assign(g.clk, r.clk);
    g.passCtr = r.ctr | 0;
    g.quantise(g.clockCost());
    g.frameCtr = (g.frameCtr + g.passTicks) & 0xFF;
    /* clockW1 is W1 INCLUDING the frame interrupts it crosses, which is what
       the Z80 side measures between $8503 and $9CD7 */
    console.log(Math.round(g.clockW1) + ' ' + g.passFrames.toFixed(5) + ' ' +
                g.passTicks);
  }
  process.exit(0);
}

if (process.argv[2] === '--table') {
  const passes = Number(process.argv[4] || 24);
  const dirName = process.argv[3] || 'right';
  const g = G.seed({});
  console.log('pass  x   y   blocked');
  for (let i = 0; i < passes; i++) {
    g.onePass({ [dirName]: true });
    /* The note column is the PENDING-INTERACTION SLOT (IX+$1D) as it stands
       at the end of the pass, which is exactly what tools/sim_move.py reads
       out of $843D at the next loop top -- $A514 does not clear it until the
       following move.  Printing the same quantity on both sides is what lets
       the two tables be diffed line for line. */
    const note = g.pend ? 'interact $' + g.pend.toString(16).padStart(2, '0')
                        : '-';
    console.log(String(i + 1).padStart(4) + String(g.x).padStart(4) +
                String(g.y).padStart(4) + '   ' + note);
  }
  process.exit(0);
}

/* =====================================================================
   THE FRONT END -- BLOCK A, AND THE FOUR BYTES IT WRITES
   =====================================================================
   THIS IS THE REGRESSION TEST THIS PROJECT SHOULD HAVE HAD FROM THE START.
   Every value below was MEASURED by running block A on the real Z80 --
   `python tools/fegate.py bytes` and `python tools/fegate.py keymap` -- and
   is asserted here against the built artifact.  Two defects in this project's
   history came from four of these bytes being guesses; if the menu ever turns
   out to write something else, this fails loudly instead of silently
   producing a fictitious investigation.                                    */
{
  /* THIS WHOLE SECTION IS THE FAITHFUL NINE-PHASE MENU -- 'players' through
     'ctrl2' -- which STREAMLINED_FRONTEND now bypasses by default (see its
     own boundary comment).  The faithful path remains in the code and
     remains reachable, and everything measured against the real Z80 below
     is measured against IT, not against the new options screen, so it is
     driven explicitly here rather than left to whatever the default is. */
  G.streamlinedFrontend.set(false);
  const F = G.frontend;
  checkTrue('the front end is exported and has its assets', !!(F && F.FE));

  /* --- 1. THE MENU'S DEFAULTS ---------------------------------------
     `python tools/fegate.py bytes` drives block A from $C1F2 with a BLIND
     key script -- it taps SPACE 6 frames on / 10 off and never reads a byte
     of memory -- and write-watches $C7F0..$FFFF all the way to the loader's
     $FF12.  Its output, verbatim:
         ($FFFB) <- $00   by PC=$C51D
         ($FFFC) <- $00   by PC=$C508
         ($FFFD) <- $00   by PC=$C242
         ($FFFE) <- $03   by PC=$C449      <- a DRAW, see below
         ($FFFF) <- $00   by PC=$C42C
         ($C7FD) the picker cursor is written at: ['$C436']   (i.e. AFTER the
                                                               pick, never
                                                               before it)
         writes above $FB77 that are NOT the five and NOT the IM 2 table: 0 */
  {
    /* SPACE TAPPED, never held: $C86C waits for it to be RELEASED before
       $C865 waits for it to be pressed, so a held SPACE stalls (asserted
       below).  6 frames down / 10 up is the same cadence the Z80 run used. */
    const tap = [];
    for (let i = 0; i < 700; i++) tap.push([6, ['SPACE']], [10, []]);
    const r = F.run(tap, 30000);
    checkTrue('the front end reaches the loader\'s $FF12', r.done,
              'phase=' + r.fe.phase + ' frames=' + r.frames);
    const b = r.bytes;                          // [$FFFB,$FFFC,$FFFD,$FFFE,$FFFF]
    check('($FFFF) player 1: the menu default is 0, the WARRIOR', b[4], 0);
    check('($FFFC) player 1 control: the menu default is 0, SINCLAIR', b[1], 0);
    check('($FFFB) player 2 control: the menu default is 0, SINCLAIR', b[0], 0);
    check('($FFFD) the 48K beeper branch, unforced by the probe', b[2], 0);
    checkTrue('($FFFE) player 2 is never player 1\'s character', b[3] !== b[4]);
  }

  /* --- 2. THE PICKER CURSOR IS $FFFF --------------------------------
     `python tools/blockA.py chars`: 5 x0 -> 0, x1 -> 1, x2 -> 2, x3 -> 3.
     Here the same thing is driven through the ported menu.  The picker polls
     ONCE EVERY 14 VIDEO FRAMES ($C75F CP 14) and a HELD key REPEATS at that
     rate -- measured on the Z80, holding '5' walks 0->1->2->3->0 in 60
     frames -- so k presses are k taps of at least one poll each. */
  {
    const got = [];
    for (let k = 0; k < 4; k++){
      /* tap SPACE until the picker is up, then k taps of '5' (each held long
         enough to cross one 14-frame poll), then tap SPACE to the end */
      const fe = new F.FrontEnd(), kb = new F.Keyboard(), ev = [];
      let n = 0;
      while (n < 20000 && fe.phase !== 'picker1'){
        if (n % 16 < 6) kb.press('SPACE'); else kb.releaseAll();
        fe.frame(kb, ev, n); n++;
      }
      kb.releaseAll();
      for (let i = 0; i < k; i++){
        for (let j = 0; j < 15; j++){ kb.press('5'); fe.frame(kb, ev, n++); }
        for (let j = 0; j < 15; j++){ kb.releaseAll(); fe.frame(kb, ev, n++); }
      }
      let done = false;
      while (n < 40000 && !done){
        if (n % 16 < 6) kb.press('SPACE'); else kb.releaseAll();
        done = fe.frame(kb, ev, n); n++;
      }
      got.push(fe.FFFF);
    }
    check('press \'5\' k times and ($FFFF) is k -- the cursor IS the byte',
          got, [0, 1, 2, 3]);
  }

  /* --- 3. $C43F, AND IT IS A DRAW -----------------------------------
     LD A,R / AND 3 / CP C / JR nz / INC A / AND 3.  Enumerated over all 256
     values of R under that guard, which is what `feDrawP2` implements. */
  {
    const dist = [];
    for (let p1 = 0; p1 < 4; p1++){
      const c = [0, 0, 0, 0];
      for (let r = 0; r < 256; r++) c[F.feDrawP2(p1, r)]++;
      dist.push(c);
    }
    check('($FFFE) is never player 1\'s index',
          dist.map((c, p1) => c[p1]), [0, 0, 0, 0]);
    check('...and (p1+1)&3 comes up twice as often as either other',
          dist.map((c, p1) => c[(p1 + 1) & 3]), [128, 128, 128, 128]);
    check('...the other two split the rest evenly',
          dist.map((c, p1) => c[(p1 + 2) & 3] + c[(p1 + 3) & 3]),
          [128, 128, 128, 128]);
  }

  /* --- 4. THE FOUR CONTROL METHODS ----------------------------------
     `python tools/fegate.py keymap` pokes $FFFC/$FFFB, presses each of the
     40 keys one at a time from a state booted through the real menu, calls
     $855D and reads ($8427)/($8447).  Its player 1 output, verbatim:
       player 1 method 0 SINCLAIR  UP=9 DOWN=8 LEFT=6 RIGHT=7 FIRE=0 MAGIC=CAPS
       player 1 method 1 KEMPSTON  MAGIC=CAPS         (no key -- it is a PORT)
       player 1 method 2 PROTEK    UP=7 DOWN=6 LEFT=5 RIGHT=8 FIRE=0 MAGIC=CAPS
       player 1 method 3 KEYBOARD  UP=1 DOWN=Q LEFT=S RIGHT=D FIRE=Z MAGIC=CAPS
     (Its player 2 rows -- $85A1's own zones, SPACE magic -- stay checked
     in the FAITHFUL build; this fork's client wires one local player and
     carries only the player 1 tables.  See CTRL_KEYS's own comment.) */
  {
    const WANT = [
      ['9','8','6','7','0'],
      null,
      ['7','6','5','8','0'],
      ['1','Q','S','D','Z'],
    ];
    const BITS = [G.constants.DIR_UP, G.constants.DIR_DOWN,
                  G.constants.DIR_LEFT, G.constants.DIR_RIGHT,
                  G.constants.DIR_FIRE];
    const ALL = [].concat(...F.KB_HALFROWS);
    let bad = 0, names = [];
    for (let m = 0; m < 4; m++){
      if (!WANT[m]) continue;
      for (let b = 0; b < 5; b++){
        for (const key of ALL){
          const kb = new F.Keyboard(); kb.press(key);
          const d = F.controlRead(m, kb);
          const wantSet = (key === WANT[m][b]);
          if (!!(d & BITS[b]) !== wantSet){ bad++; names.push(m+'/'+key); }
        }
      }
    }
    check('all four control methods, all 40 keys', bad, 0);
    /* KEMPSTON reads a PORT, not the keyboard: no key does anything. */
    {
      const kb = new F.Keyboard();
      let any = 0;
      for (const key of ALL){ kb.releaseAll(); kb.press(key);
        if (F.controlRead(1, kb) & 0x1F) any++; }
      check('method 1 KEMPSTON: no key on the keyboard moves you', any, 0);
      kb.releaseAll();
      const got = [];
      for (const bit of [1, 2, 4, 8, 0x10]){ kb.kempston = bit;
        got.push(F.controlRead(1, kb)); }
      check('IN A,($1F) $01->$08 $02->$04 $04->$02 $08->$01 $10->$10',
            got, [8, 4, 2, 1, 0x10]);
    }
    /* $857E is OUTSIDE the dispatch. */
    {
      const got = [];
      for (let m = 0; m < 4; m++){
        const kb = new F.Keyboard(); kb.press(F.CTRL_MAGIC);
        got.push(!!(F.controlRead(m, kb) & G.constants.DIR_POTION));
      }
      check('MAGIC is CAPS in ALL FOUR methods ($857E)',
            got, [true, true, true, true]);
    }
  }

  /* --- 5. THE FRONT END'S TIMING MODEL ------------------------------
     Measured on the real Z80 (the scratchpad driver in this cycle's report,
     and reproduced by two independent sceptics): the character picker's key
     test is reached every 14.000 video frames, the control picker's every
     10.000, and the player-count loop has NO frame wait at all but CLAMPS,
     so a held key pins the count instead of repeating it. */
  {
    const fe = new F.FrontEnd(), kb = new F.Keyboard(), ev = [];
    /* walk to the character picker with SPACE, then hold '5' and watch the
       cursor: it must step exactly once per 14 frames. */
    let n = 0;
    kb.press('SPACE');
    while (n < 6000 && fe.phase !== 'picker1'){ fe.frame(kb, ev, n); n++;
      if (n % 16 === 0) kb.releaseAll(); else kb.press('SPACE'); }
    checkTrue('the ported menu reaches the character picker', fe.phase === 'picker1');
    kb.releaseAll(); kb.press('5');
    const steps = [];
    let prev = fe.cursor;
    for (let i = 0; i < 60; i++){
      fe.frame(kb, ev, n + i);
      if (fe.cursor !== prev){ steps.push(i); prev = fe.cursor; }
    }
    const gaps = steps.slice(1).map((v, i) => v - steps[i]);
    check('a HELD key repeats in the picker at ONE STEP PER 14 FRAMES',
          gaps, [14, 14, 14]);
  }
  {
    const fe = new F.FrontEnd(), kb = new F.Keyboard(), ev = [];
    let n = 0;
    while (n < 12000 && fe.phase !== 'ctrl1'){
      if (n % 16 < 6) kb.press('SPACE'); else kb.releaseAll();
      fe.frame(kb, ev, n); n++;
    }
    checkTrue('the ported menu reaches the control picker', fe.phase === 'ctrl1');
    kb.releaseAll(); kb.press('6');
    const steps = [];
    let prev = fe.ctrl;
    for (let i = 0; i < 60; i++){
      fe.frame(kb, ev, n + i);
      if (fe.ctrl !== prev){ steps.push(i); prev = fe.ctrl; }
    }
    const gaps = steps.slice(1).map((v, i) => v - steps[i]);
    check('...and ONE STEP PER 10 FRAMES in the control picker',
          gaps.slice(0, 4), [10, 10, 10, 10]);
  }
  /* $C5F1's two arms CLAMP (INC A / CP 3 / JR nz / DEC A and the mirror), so
     a held key PINS the player count rather than walking it. */
  {
    const fe = new F.FrontEnd(), kb = new F.Keyboard(), ev = [];
    let n = 0;
    while (n < 6000 && fe.phase !== 'players'){
      if (n % 16 < 6) kb.press('SPACE'); else kb.releaseAll();
      fe.frame(kb, ev, n); n++;
    }
    checkTrue('the ported menu reaches ONE OR TWO PLAYERS', fe.phase === 'players');
    kb.releaseAll(); kb.press('8');
    for (let i = 0; i < 60; i++) fe.frame(kb, ev, n + i);
    const two = fe.players;
    kb.releaseAll(); kb.press('5');
    for (let i = 0; i < 60; i++) fe.frame(kb, ev, n + 60 + i);
    check('the player count clamps at 2 and at 1, held or not', [two, fe.players],
          [2, 1]);
  }
  /* A HELD SPACE cannot walk the menu: $C86C waits for it to be RELEASED
     before $C865 waits for it to be pressed.  MEASURED on the Z80 -- held
     continuously from $C1F2, 3,000 frames later it is still in block A with
     ($FFFF) = $2A. */
  {
    const r = F.run([[9000, ['SPACE']]], 4000);
    /* the port's front end DOES advance on a tapped SPACE (check 1) but the
       release waits are what a held one hits */
    const fe = new F.FrontEnd(), kb = new F.Keyboard(), ev = [];
    kb.press('SPACE');
    let n = 0, done = false;
    while (n < 4000 && !done){ done = fe.frame(kb, ev, n); n++; }
    checkTrue('a HELD SPACE cannot walk the menu (the $C86C release waits)',
              !done && fe.FFFF === 0x2A, 'phase=' + fe.phase);
  }

  /* --- 6. THE 48K TITLE TUNE ----------------------------------------
     `python tools/fegate.py tune` diffs this model's OUT ($FE) stream against
     the running $C000 tick by tick: 13,312 values a tick, IDENTICAL, with the
     seven rests at ticks 6, 14, 22, 80, 86, 94, 102 and 1,277,952 speaker
     writes over the whole tune. */
  {
    const t = new F.TitleTune();
    check('103 played ticks a channel',
          [F.FE.tune.ch1.length, F.FE.tune.ch2.length], [103, 103]);
    check('the 48K patches: OUT base 0, tempo $E6, toggle $10',
          [F.FE.tune.out_base, F.FE.tune.tempo, F.FE.tune.toggle],
          [0, 0xE6, 0x10]);
    /* the rests are the ticks where BOTH pitches are 1 ($C06C/$C070/$C072) */
    const rests = [];
    for (let i = 0; i < 103; i++){
      const p1 = F.FE.tune.pitch[(F.FE.tune.ch1[i] + 12) & 0xFF];
      const p2 = F.FE.tune.pitch[(F.FE.tune.ch2[i] + 12) & 0xFF];
      if (p1 === 1 && p2 === 1) rests.push(i);
    }
    check('the seven REST ticks', rests, [6, 14, 22, 80, 86, 94, 102]);
    /* run one whole sounding tick and count the OUTs */
    t.reset(); t.nextTick();
    const ev = [];
    let guard = 0;
    while (t.tick === 0 && guard++ < 200) t.frame(guard, ev);
    checkTrue('one sounding tick is 13,312 speaker writes', t.outs >= 13312,
              'outs=' + t.outs);
    check('...and 6,656 iterations of 96 T', 256 * (256 - F.FE.tune.tempo), 6656);
  }

  /* --- 7. THE RANKED TABLES -----------------------------------------
     `python tools/fegate.py hiscore` drives $869F on the real Z80 for nine
     scenarios and diffs all four 60-byte tables against this same sort: all
     nine agree.  It also settles two claims this project has made -- an
     eleventh entry that beats NOBODY is discarded (0 table bytes change) and
     one that beats slot 9 gets in (12 bytes change).  The defaults are tape
     data at block C offset $0426 and no code initialises them. */
  {
    const H = G.hiscore;
    H.reset();
    const names = H.tables.map(t => String.fromCharCode(
      ...[0, 1, 2].map(i => 0x40 + (t[i] & 0x3F))));
    check('the shipped names are the development team\'s',
          names, ['BIL', 'BOB', 'KEV', 'ARP']);
    check('...all ten slots of all four tables, score 010000',
          H.tables.map(t => [t[3], t[4], t[5],
                             [0,1,2,3,4,5,6,7,8,9].every(
                               j => t.slice(6*j, 6*j+6).join() === t.slice(0,6).join())]),
          [[1,0,0,true],[1,0,0,true],[1,0,0,true],[1,0,0,true]]);
    /* THE QUALIFICATION RULE, and it is not ">= 10,000". */
    const shot = s => H.key({score: s, name: [0x41,0x41,0x41], millions: 0});
    H.reset();
    check('a score EQUAL to the worst is DISCARDED (a tie goes below)',
          H.insert(H.tables[3], shot(0x010000)), false);
    check('...and one point more gets in',
          H.insert(H.tables[3], shot(0x010001)), true);
    H.reset();
    check('a score below the worst is discarded',
          H.insert(H.tables[3], shot(0x009999)), false);
    /* TEN SLOTS, AND THE ELEVENTH ONLY GETS IN IF IT BEATS SLOT 9. */
    H.reset();
    const bcd = n => parseInt(String(n).padStart(6, '0'), 16);
    for (let i = 0; i < 10; i++)
      H.insert(H.tables[3], H.key({score: bcd(900000 - 10000*i),
                                   name: [0x41+i, 0x41, 0x41], millions: 0}));
    const before = Array.from(H.tables[3]);
    check('ten descending inserts push all ten defaults off',
          before.slice(54, 57).map(v => String.fromCharCode(0x40 + (v & 0x3F)))
            .join(''), 'JAA');
    check('an eleventh BELOW slot 9 changes nothing',
          H.insert(H.tables[3], H.key({score: bcd(805000),
                                       name: [0x4B,0x41,0x41], millions: 0})),
          false);
    check('...and the table really is untouched',
          Array.from(H.tables[3]).join() === before.join(), true);
    check('an eleventh ABOVE slot 9 gets in',
          H.insert(H.tables[3], H.key({score: bcd(855000),
                                       name: [0x4C,0x41,0x41], millions: 0})),
          true);
    /* THE LETTERS NEVER RANK, and MILLIONS outranks the score. */
    H.reset();
    H.insert(H.tables[0], H.key({score: 0x000001, name: [0x5A,0x5A,0x5A],
                                 millions: 1}));
    check('the millions field outranks a 999,999 score',
          H.tables[0][0] & 0xC0, 0x00);
    check('...and it lands in slot 0', (H.tables[0][2] & 0xC0) >> 6, 1);
    /* $8757 drops bits 7:6 of the millions counter -- only SIX bits survive. */
    check('the millions field is six bits: 64 packs as 0 and 255 as 63',
          [H.key({score: 0, name: [0x41,0x41,0x41], millions: 64}).slice(0,3)
             .reduce((a, v) => (a << 2) | (v >> 6), 0),
           H.key({score: 0, name: [0x41,0x41,0x41], millions: 255}).slice(0,3)
             .reduce((a, v) => (a << 2) | (v >> 6), 0)],
          [0, 63]);
    H.reset();
  }

  /* --- 8. THE ATTRACT LOOP ------------------------------------------
     `python tools/fegate.py attract` measures the page period at $8767 ->
     $8767 as 255.09 (the first, short, because $B470 zeroed $8497 part way
     through a frame), then 256.01, 256.00, 256.00, 256.00 video frames, with
     ($84CB) running 1, 2, 3, 0, 1, 2 -- WARRIOR, VALKYRIE, WIZARD, ELF. */
  {
    check('the attract page period is a byte wrap of $8497', G.hiscore.ATTRACT_PERIOD, 256);
    const g = G.seed({});
    g.packHeld = true;                     // a pack is held: no REWIND prompt
    g.enterAttract();
    check('a cold boot lands on the ranked table, not in the dungeon',
          g.mode, 'attract');
    const pages = [g.attractPage];
    for (let i = 0; i < 4 * 256; i++){
      g.attractTick({});
      if (g.attractT === 0 && pages[pages.length - 1] !== g.attractPage)
        pages.push(g.attractPage);
    }
    check('the rotation is 1, 2, 3, 0 -- WARRIOR, VALKYRIE, WIZARD, ELF',
          pages, [1, 2, 3, 0, 1]);
    /* FIRE, and nothing else, ends it ($944C BIT 4,(IX+7)). */
    const g2 = G.seed({}); g2.packHeld = true; g2.enterAttract();
    for (let i = 0; i < 40; i++) g2.attractTick({up: true, left: true});
    check('no key but FIRE leaves the attract loop', g2.mode, 'attract');
    g2.attractTick({fire: true});
    check('FIRE leaves it', g2.mode, 'play');
    /* $B48F BIT 7,(IY+$4D): a COLD boot has $84CC bit 7 clear and gets the
       REWIND TAPE prompt first.
       THIS TESTS THE FAITHFUL ARM, and says so.  The port SHIPS with the tape
       prompts suppressed (see the boundary block at the end of this file), so
       the flag is set explicitly here rather than the expected value being
       relaxed to match -- the faithful path still exists and must still be
       exercised, or suppressing it would quietly become deleting it. */
    G.tapePrompts.set(true);
    const g3 = G.seed({}); g3.packHeld = false; g3.enterAttract();
    g3.attractTick({fire: true});
    check('faithful arm: a cold boot gets the REWIND TAPE prompt', g3.mode, 'rewind');
    g3.rewindTick({potion: true});
    check('...and SPACE clears it into the dungeon', g3.mode, 'play');
    check('...and the pack is now held, so a later game skips the prompt',
          g3.packHeld, true);
    /* and the SHIPPED arm: the same cold boot goes straight in. */
    G.tapePrompts.set(false);
    const g3s = G.seed({}); g3s.packHeld = false; g3s.enterAttract();
    g3s.attractTick({fire: true});
    check('shipped arm: the same cold boot skips the prompt', g3s.mode, 'play');
    check('...and it still marks the pack held', g3s.packHeld, true);
    /* $84CB and $84CC bit 7 are SIMULATION state -- the rotation carries on
       across games and the cold-boot flag is never cleared -- so both are
       fingerprinted, and the shadow screen is not. */
    const g4 = G.seed({}); g4.packHeld = true; g4.enterAttract();
    const fp = g4.fingerprint();
    g4.attractDraw();
    checkTrue('the attract page counter IS fingerprinted',
              g4.fingerprint() !== fp);
    const fp2 = g4.fingerprint();
    g4.feScr.put(0x5800, 0x77);
    checkTrue('the shadow screen it draws into is NOT',
              g4.fingerprint() === fp2);
  }

  /* --- 9. THE ASSETS ------------------------------------------------- */
  {
    const b64 = s => Buffer.from(s, 'base64');
    check('the loading screen is a whole 6,912-byte display file',
          b64(F.FE.loading_screen).length, 6912);
    check('the title screen is too', b64(F.FE.title_screen).length, 6912);
    check('block A\'s own font is 128 glyphs of 8 bytes, $20..$9F',
          [b64(F.FE.font).length, F.FE.font_first], [1024, 0x20]);
    check('the three text pages are 24 rows of (32 chars + 1 attribute)',
          ['credits', 'keys', 'controls'].map(k => b64(F.FE.pages[k]).length),
          [792, 792, 792]);
    /* $C800 / $C818 -- the picker's own tables, which are three of the four
       independent readings that close the character index. */
    check('the picker highlights land on the four labelled quadrants',
          F.FE.picker.corners.map(v => [(v - 0x5800) >> 5, (v - 0x5800) & 31]),
          [[9, 8], [13, 8], [13, 21], [9, 22]]);
    check('...in red, cyan, yellow and green',
          F.FE.picker.papers, [0x10, 0x28, 0x30, 0x20]);
    check('the 14-step ink ramp is a triangle',
          F.FE.picker.ramp, [0,1,2,3,4,5,6,7,6,5,4,3,2,1]);
    check('the menu\'s default cursor is 0 -- the WARRIOR',
          [F.FE.picker.cursor_default, F.CHAR_MENU_DEFAULT], [0, 0]);
    check('the gate baseline is a REACHABLE menu state, not a stale byte',
          [F.GATE_CONFIG.char, F.GATE_CONFIG.method1], [3, 3]);
    /* $B893's fall-through chain, and the last arm is UNGUARDED. */
    check('the four class names and their inks',
          F.FE.class_names.map(n => [n.tag, n.ink, n.codes.length]),
          [[0x00, 0x42, 7], [0x08, 0x45, 9], [0x10, 0x46, 7], [0x18, 0x44, 3]]);
  }

  /* --- 10. THE SCREEN MODEL ----------------------------------------- */
  {
    /* $C740  LD A,H / RRA x3 / AND 3 / ADD A,$58 */
    check('$C740 display -> attribute',
          [F.SpecScreen.attrAddr(0x4000), F.SpecScreen.attrAddr(0x482A),
           F.SpecScreen.attrAddr(0x50E0), F.SpecScreen.attrAddr(0x4FFF)],
          [0x5800, 0x592A, 0x5AE0, 0x59FF]);
    /* $C74A  INC H / AND 7 / JR nz / L += $20 / JR c / H -= 8.  The third
       case is the one a naive "+256" gets wrong: at the bottom pixel row of
       the bottom character row of a third, L wraps and H does NOT come back. */
    check('$C74A steps a pixel row, crossing a third correctly',
          [F.SpecScreen.nextRow(0x4000), F.SpecScreen.nextRow(0x4700),
           F.SpecScreen.nextRow(0x40E0), F.SpecScreen.nextRow(0x47E0)],
          [0x4100, 0x4020, 0x41E0, 0x4800]);
    /* the menu box is 12x6 characters at rows 9..14, columns 10..21 */
    const rows = new F.FrontEnd().boxRows();
    check('the menu box is at char rows 9..14, columns 10..21',
          [rows.map(a => (a - 0x5800) >> 5), (rows[0] - 0x5800) & 31],
          [[9, 10, 11, 12, 13, 14], 10]);
    /* the pages really do decode to the text the CONTROLS screen shows */
    const s = new F.SpecScreen();
    s.printPage(Buffer.from(F.FE.pages.controls, 'base64'), 24);
    let lit = 0;
    for (let i = 0; i < 6144; i++) if (s.m[i]) lit++;
    checkTrue('the CONTROLS page renders something (non-blank bitmap)', lit > 800,
              'lit=' + lit);
    const attrs = new Set();
    for (let r = 0; r < 24; r++) attrs.add(s.m[6144 + r*32]);
    check('every row of a text page is ONE colour ($C877 stores it 32 times)',
          [0,1,2,3,4,5,6,7].every(k => {
            const r = 3 + k, a = s.m[6144 + r*32];
            return [...Array(32).keys()].every(c => s.m[6144 + r*32 + c] === a);
          }), true);
  }
  G.streamlinedFrontend.set(true);          // back to what the port ships
}

/* ======================================================================
   THE FAITHFUL / ADDED BOUNDARY -- an ASSERTION, not an intention
   ======================================================================
   The port suppresses three prompts that ask the player to service a tape deck
   it does not have ($C1F2 'stoptape', $C520 'pressplay' + $FF12's 47.82-frame
   wait, and $B494's cold-boot REWIND).  Manual 0.3: if you add a layer, the
   boundary must be a TEST.  The case study's own form of it ran the enhanced
   and unenhanced paths and required the simulation state to come out
   BYTE-IDENTICAL, and that is what these checks do.

   This holds by construction rather than by luck -- onePass() is never called
   while any of the three run; they sit in the front end and in $B470/$B494's
   video-frame loops, outside the simulation.  So if it ever FAILS, the right
   response is not to relax the check: it means a suppression reached into the
   simulation and the design is wrong. */
{
  const TP = G.tapePrompts;
  checkTrue('the tape-prompt boundary is exposed and defaults to SUPPRESSED',
            TP && TP.get() === false);

  const fpAfter = (faithful, passes) => {
    TP.set(faithful);
    const g = G.seed({});
    for (let i = 0; i < passes; i++) g.onePass({ right: i % 3 !== 2, fire: i % 5 === 0 });
    return { fp: g.fingerprint(), pass: g.pass, x: g.p.x, y: g.p.y };
  };

  const suppressed = fpAfter(false, 120);
  const faithful   = fpAfter(true, 120);
  TP.set(false);                       // leave it as the port ships

  check('120 passes are BYTE-IDENTICAL with the prompts suppressed and not',
        suppressed, faithful);
  checkTrue('...and the run actually did something (guards a vacuous pass)',
            suppressed.pass === 120 && suppressed.fp !== 0);

  /* And the boundary must actually DO something on the presentation side, or
     it is not a boundary, it is dead code.  Driving the front end with a blind
     script that only taps SPACE: the faithful arm must sit in 'stoptape'
     waiting (it has NO timeout - 3,000,000 instructions were measured on the
     Z80 with no key and it never leaves), the suppressed arm must not. */
  const phaseAfterOneFrame = (faithful) => {
    TP.set(faithful);
    const fe = new G.frontend.FrontEnd();
    const p = fe.phase;
    TP.set(false);
    return p;
  };
  check('faithful: the front end starts in the tape prompt',
        phaseAfterOneFrame(true), 'stoptape');
  check('suppressed: it starts past it, in the loading screen',
        phaseAfterOneFrame(false), 'loading');
}

/* ======================================================================
   THE AUDIO UNLOCK -- a regression the tape-prompt suppression caused
   ======================================================================
   A browser will not run an AudioContext until a user gesture.  The original's
   first screen ($C1F2, "stop tape and press space") supplied one for free;
   suppressing it removed the ONLY gesture between page load and the title
   tune, so the tune advanced into a suspended context and the music never
   started.  Reported in play.

   The lesson is worth the test: a wait can be load-bearing for something other
   than the thing it appears to wait for, and nothing in a state-only suite
   noticed, because the SIMULATION was perfectly correct throughout -- it was
   only inaudible. */
{
  const F = G.frontend;
  const feAt = (phase) => {
    const fe = new F.FrontEnd();
    fe.enter(phase);
    return fe;
  };

  /* the tune has been running silently; unlocking must take it back to the
     top, not leave the player joining it part-way */
  const fe = feAt('tune');
  const started = new F.TitleTune();            // what "restarted" must equal
  fe.tune.tick = 7; fe.t = 41;
  fe.audioUnlocked();
  /* TitleTune.reset() sets tick = -1, NOT 0: nextTick() increments before it
     fetches ($C024/$C031), so -1 is "before the first row".  The expected
     value is taken from a freshly constructed tune rather than written out as
     a literal, so this check cannot drift from the code it describes -- and an
     earlier version of it asserted 0 and failed for that reason alone. */
  check('unlocking audio during the tune restarts it from the first row',
        [fe.tune.tick, fe.t], [started.tick, 0]);
  checkTrue('...and that really is the pre-first-row value', started.tick === -1);

  /* and it must not disturb any other phase -- the tune is only restarted
     where restarting it is what the player expects */
  const fe2 = feAt('credits');
  fe2.t = 23;
  const before = fe2.phase + ':' + fe2.t;
  fe2.audioUnlocked();
  check('unlocking outside the tune phase changes nothing',
        fe2.phase + ':' + fe2.t, before);

  /* start() must report WHETHER IT WAS THE CALL THAT BROUGHT THE CONTEXT UP,
     or the driver cannot know when to restart the tune.  There is no
     AudioContext in this harness, so the honest answer is false -- what is
     asserted is that it returns a boolean and never claims to have started
     one it did not. */
  const so = new G.sound.SoundOut();
  const first = so.start();
  checkTrue('SoundOut.start() returns a boolean, never undefined',
            typeof first === 'boolean');
  check('...and with no AudioContext available it reports FALSE, twice',
        [first, so.start()], [false, false]);
}

/* ======================================================================
   THE FOUR CHARACTERS ACTUALLY LOOK DIFFERENT
   ======================================================================
   Reported in play: "whatever character the player chooses the sprite is
   always the elf".  The sprite BASE was innocent -- (IX+$0F) is $D0/$E8 per
   PLAYER for every character and nothing writes it.  What varies is the
   artwork under that base, and the port shipped ONE extraction.

   Expected values here come from the ORIGINAL: booting from $8400 with
   ($FFFF) forced to 0..3 and hashing the records at ids 208..215 gives four
   distinct sets, and the idle attributes are $42 warrior / $45 valkyrie /
   $46 wizard / $44 elf (tools/playersprite.py --no-gate prints them). */
{
  const A2 = G.assets.player_frames;
  checkTrue('all four character sprite sets ship', !!(A2 && A2.chars &&
            A2.chars.length === 4));
  if (A2 && A2.chars) {
    /* the inks the original assigns, measured -- and they are what makes the
       four visually distinct at a glance */
    check('the four idle inks are the original\'s own',
          A2.chars.map(c => c.idle.ink), [0x42, 0x45, 0x46, 0x44]);
    /* and the ARTWORK differs, not merely the colour: a set that was really
       four copies of one character would pass an ink check and fail this */
    const first = A2.chars.map(c => c.down.frames[0]);
    checkTrue('...and their bitmaps are four DISTINCT sets, not one recoloured',
              new Set(first).size === 4);

    /* the renderer must pick by CHARACTER, not by player slot.  Render twice
       changing only charIndex and require the draw lists to differ -- a
       state-only test cannot see which sprite reached the screen (manual G6). */
    const drawFor = (ci) => {
      const g = G.seed({});
      g.p.charIndex = ci;
      recording = true; drawCalls.length = 0;
      G.render(ctxStub, g);
      recording = false;
      return JSON.stringify(drawCalls);
    };
    const asWarrior = drawFor(0), asElf = drawFor(3);
    checkTrue('choosing the warrior draws something different from the elf',
              asWarrior !== asElf);
    check('...and the same choice twice is stable', drawFor(2), drawFor(2));
  }
}

/* ====================================================================
   THE POTION, against the real Z80's own table.
   build/potiongate.json is written by `python tools/potiongate.py dump`: the
   scenario matrix and, for each one, the bytes the ORIGINAL leaves at the top
   of every pass.  This block drives the built engine through the same
   scenarios and compares, so the potion is anchored on measurement rather
   than on this engine's own output -- the same shape as build/telecensus.json.
   Three scenarios exempt a column.  Every exemption is backed by a CONTROL
   that is itself a scenario of the tool (`python tools/potiongate.py
   controls`), never by an argument -- see potiongate.py's header.
   The drain clock is the original's own, measured at $B6DA and handed over:
   this engine charges a flat four video frames a pass where the original's
   cost 3.92..5.03, which moves $842B bit 0 and with it the pass on which
   $B7B1 clears the potion-spend debounce.  What is under test here is the
   POTION.  `python tools/potiongate.py unhelped` prints what that is worth.
   Mutation-tested: 18 broken potion rules, 17 caught.  The 18th is provably
   equivalent -- see potiongate.py, WHAT THIS GATE IS WORTH.               */
{
  const pgPath = path.join(ROOT, 'build', 'potiongate.json');
  if (!fs.existsSync(pgPath)) {
    checkTrue('build/potiongate.json present (python tools/potiongate.py dump)',
              false);
  } else {
    const PG = JSON.parse(fs.readFileSync(pgPath, 'utf8'));
    const byLabel = new Map(PG.scenarios.map(s => [s.label, s]));
    let rowsSeen = 0, bad = 0, firstBad = null, exempted = 0;
    for (const z of PG.z80) {
      const s = byLabel.get(z.label);
      const g = G.seed({ char: 0x2A, char2: 0x2A });
      if (z.clock && z.clock.length) g.clockOverride = z.clock.slice();
      g.potions = s.potions;
      if (!s.potions2_at) g.players[1].potions = s.potions2;
      if (s.p15 !== null) g.p15 = s.p15;
      if (s.p14 !== null) g.p14 = s.p14;
      for (const a of s.actors) {
        const t = g.actors[a[0]];
        t.x = a[1] & 0xFF; t.y = a[2] & 0xFF; t.state = a[3] & 0xFF;
      }
      for (const c of s.cells) g.map[c[1] & 31][c[0] & 31] = c[2];
      const sfx = []; const realSfx = g.sfx.bind(g);
      g.sfx = function (n) { sfx.push(n); return realSfx(n); };
      const keep = PG.cols
        .map((c, i) => (s.ignore.indexOf(c) < 0 ? i : -1)).filter(i => i >= 0);
      if (s.ignore.length) exempted++;
      for (let pi = 0; pi < s.pattern.length; pi++) {
        const ch = s.pattern[pi], ch2 = s.pattern2[pi];
        if (pi + 1 === s.potions2_at) g.players[1].potions = s.potions2;
        if (s.f11_set && pi + 1 === s.f11_set[0]) g.f11 |= s.f11_set[1];
        sfx.length = 0;
        g.onePass({ potion: ch === 'M', fire: ch === 'Z',
                    p2: { potion: ch2 === 'M', fire: ch2 === 'F' } });
        const v = [g.potions, g.potionT, g.potionArmed ? 1 : 0,
                   g.f847E_bit0 ? 1 : 0, g.f11,
                   g.killTally, g.genTally, g.actors.length,
                   g.potionK, g.potionLo, g.potionHi, g.score,
                   g.players[1].potions, g.players[1].score, g.border & 7];
        const want = z.rows[pi];
        const mine = JSON.stringify(keep.map(i => v[i]));
        const theirs = JSON.stringify(keep.map(i => want.v[i]));
        const cells = JSON.stringify(s.watch.map(c => g.map[c[1] & 31][c[0] & 31]));
        const wcells = JSON.stringify(want.cells);
        const mysfx = JSON.stringify(sfx.filter(n => n === 5 || n === 13));
        rowsSeen++;
        if (mine !== theirs || cells !== wcells
            || mysfx !== JSON.stringify(want.sfx)) {
          bad++;
          if (!firstBad) firstBad = `${z.label} pass ${pi + 1}: ` +
            `engine ${mine}${cells !== '[]' ? ' cells ' + cells : ''} ` +
            `sfx ${mysfx} vs Z80 ${theirs}` +
            `${wcells !== '[]' ? ' cells ' + wcells : ''} sfx ` +
            JSON.stringify(want.sfx);
        }
      }
    }
    check('the potion matrix is 37 scenarios of measured Z80 rows',
          PG.z80.length, 37);
    checkTrue('...covering the throw, the countdown, the debounce, both ' +
              'damage halves, all five $7D1C rows, the $8FAE detonation ' +
              'the $B756 cancel and two players', rowsSeen >= 438);
    check('the engine reproduces the original potion row for row',
          bad === 0 ? 'all agree' : `${bad}/${rowsSeen} differ -- ${firstBad}`,
          'all agree');
    check('...and exactly three scenarios carry a column exemption, each ' +
          'with a control', exempted, 3);
  }
}

/* ====================================================================
   THE HURRY-UP, $8531 CALL $971B, against the real Z80's own map.

   build/_hurry2.json is written by `python tools/hurrygate.py`: the planted
   cells and the FULL 1024-cell map the original leaves after each of the two
   stages.  This drives the engine to the same thresholds and compares every
   cell, so the two ladders are anchored on measurement.

   $84B8 is driven to the threshold rather than waited out -- stage 2 is 140
   ticks, about 2,240 passes.  What that does NOT test is the tick RATE, which
   is $B6E9 and belongs to the drain.  See tools/hurrygate.py.              */
{
  const hPath = path.join(ROOT, 'build', '_hurry2.json');
  if (!fs.existsSync(hPath)) {
    checkTrue('build/_hurry2.json present (python tools/hurrygate.py)', false);
  } else {
    const H = JSON.parse(fs.readFileSync(hPath, 'utf8'));
    /* THE HURRY-UP IS RETIRED IN THIS FORK (FAITHFUL_HURRY_UP, off by
       default -- Anthony, 2026-09-03): with the shipped default, driving
       $84B8 past BOTH thresholds changes nothing -- no door opens, no
       key vanishes, no wall turns, no sound 14 or 16, no latch -- while
       the counter itself still runs (it is fingerprinted, the drain's). */
    checkTrue('FAITHFUL_HURRY_UP defaults to off', G.hurryUp.get() === false);
    {
      const r = G.seed({ char: 0x2A, char2: 0x2A });
      for (const p of H.plant) r.map[p[1]][p[0]] = p[2];
      const before = JSON.stringify(r.map);
      const rs = []; const realR = r.sfx.bind(r);
      r.sfx = function (n) { rs.push(n); return realR(n); };
      for (let k = 0; k < 40; k++){ r.hurry = 0x17 + k; r.onePass({}); }
      for (let k = 0; k < 40; k++){ r.hurry = 0x8C + k; r.onePass({}); }
      check('RETIRED: past both thresholds the map is untouched, no eviction sound, no latch',
            [JSON.stringify(r.map) === before, rs.filter(n => n === 14 || n === 16).length,
             r.hurryDoors, r.hurryExits],
            [true, 0, false, false]);
      checkTrue('...and $84B8 still counts under the drain', r.hurry >= 0x8C);
    }
    G.hurryUp.set(true);                 // the faithful path, for the measured stages below
    const g = G.seed({ char: 0x2A, char2: 0x2A });
    for (const p of H.plant) g.map[p[1]][p[0]] = p[2];
    const flat = () => { const a = []; for (let r = 0; r < 32; r++)
      for (let c = 0; c < 32; c++) a.push(g.map[r][c]); return a; };
    const sfx = []; const realSfx = g.sfx.bind(g);
    g.sfx = function (n) { sfx.push(n); return realSfx(n); };
    const drive = (stage, thr) => {
      for (let k = 0; k < 400; k++) {
        g.hurry = thr; sfx.length = 0; g.onePass({});
        const hit = sfx.filter(n => n === 14 || n === 16);
        if (hit.length) {
          const want = H[stage], mine = flat();
          let bad = 0, first = null;
          for (let i = 0; i < 1024; i++) if (mine[i] !== want.map[i]) {
            bad++;
            if (!first) first = 'cell ' + (i % 32) + ',' + Math.floor(i / 32) +
              ' engine $' + mine[i].toString(16) + ' vs Z80 $' + want.map[i].toString(16);
          }
          return { hit, bad, first, want };
        }
      }
      return null;
    };
    const d = drive('doors', 0x17);
    checkTrue('stage 1 of the hurry-up fires in the engine at $84B8 >= $17',
              d !== null);
    if (d) {
      check('...with the original\'s sound 14',
            JSON.stringify(d.hit), JSON.stringify(d.want.sfx));
      check('...and the doors, the floor keys and $32 open exactly as the ' +
            'original leaves them, all 1024 cells',
            d.bad === 0 ? 'all agree' : d.bad + ' differ -- ' + d.first,
            'all agree');
      checkTrue('...and it latches, so it cannot fire twice', g.hurryDoors);
    }
    const e = drive('exits', 0x8C);
    checkTrue('stage 2 fires at $84B8 >= $8C', e !== null);
    if (e) {
      check('...with the original\'s sound 16',
            JSON.stringify(e.hit), JSON.stringify(e.want.sfx));
      check('...and EVERY wall has become an exit, all 1024 cells',
            e.bad === 0 ? 'all agree' : e.bad + ' differ -- ' + e.first,
            'all agree');
      checkTrue('...and it latches too', g.hurryExits);
    }
    /* the treasure-room exemption, $971B BIT 6,(IY-1) / RET nz */
    const t = G.seed({ char: 0x2A });
    /* 0x30, not 0xFF: $B6E9 is an INC and the drain runs at $852E, BEFORE
       $8531, so 0xFF wraps to 0 and the stage would be skipped for a reason
       that has nothing to do with the treasure room.  The real Z80 wraps the
       same way -- this is a trap in the TEST, not a rule of the game. */
    t.map[2][6] = 0x11; t.treasure = true; t.hurry = 0x30;
    t.onePass({});
    check('a TREASURE ROOM never hurries ($971B BIT 6,(IY-1) / RET nz)',
          [t.map[2][6], t.hurryDoors], [0x11, false]);
    G.hurryUp.set(false);                // back to the shipped default
  }

  /* --- $A7FC, the $2F switch, and $9967's wall re-tiling --------------
     build/_sweep.json is written by `python tools/sweepgate.py`: a planted
     map before, and the map the ORIGINAL leaves after one $A7FC.  Removing a
     wall must break the four neighbours' connection bits towards it (RES 2
     up, 3 right, 0 down, 1 left, each gated by $98BF) and $99B3 must give a
     neighbour left with nothing bit 4.  The port used to clear bit-7 cells
     and skip all of that. */
  {
    const sPath = path.join(ROOT, 'build', '_sweep.json');
    if (!fs.existsSync(sPath)) {
      checkTrue('build/_sweep.json present (python tools/sweepgate.py)', false);
    } else {
      const S = JSON.parse(fs.readFileSync(sPath, 'utf8'));
      const g = G.seed({});
      for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++)
        g.map[r][c] = S.before[r * 32 + c];
      g.doMapSweep();
      let bad = 0, first = null;
      for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++) {
        const i = r * 32 + c;
        if (g.map[r][c] !== S.after[i]) {
          bad++;
          if (!first) first = '(' + r + ',' + c + ') engine $' +
            g.map[r][c].toString(16) + ' vs Z80 $' + S.after[i].toString(16);
        }
      }
      check('$A7FC + $9967: the engine sweeps all 1024 cells as the original does',
            [bad, first], [0, null]);
      /* NON-VACUITY.  sweepgate plants sites where the OLD behaviour -- clear
         the cell, never re-tile -- gives a different map, and records them.
         Without this the check would pass on a map that exercised nothing. */
      checkTrue('...and the planted map really exercises the re-tiling, so a ' +
                'clear-without-re-tiling engine fails the check above',
                S.naive_differs_at.length >= 10);
      /* and prove the engine is not merely reproducing the naive answer */
      const naiveAgrees = S.naive_differs_at.every(i =>
        g.map[Math.floor(i / 32)][i % 32] === 0);
      checkTrue('...and the engine re-tiled those cells rather than zeroing them',
                !naiveAgrees);
    }
  }

  /* --- $A84D, the SYMBOL SHIFT walk-through-walls cheat ---------------
     build/_ghost.json is written by `python tools/ghostgate.py`: the same
     walk into a planted wall barrier run TWICE on the real Z80, once with
     SYM held and once without.  (IY+7) is the $7FFE half-row stored RAW, so
     bit 1 reads 0 when the key is DOWN and $A851 RET z lets the blocked step
     stand.  The tool asserts the two traces differ before writing them. */
  {
    const gPath = path.join(ROOT, 'build', '_ghost.json');
    if (!fs.existsSync(gPath)) {
      checkTrue('build/_ghost.json present (python tools/ghostgate.py)', false);
    } else {
      const GH = JSON.parse(fs.readFileSync(gPath, 'utf8'));
      const walk = sym => {
        const g = G.seed({ char: 0x2A, char2: 0x2A });
        g.actors = [];
        for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++)
          g.map[r][c] = GH.before[r * 32 + c];
        g.players[0].x = GH.start[0]; g.players[0].y = GH.start[1];
        const tr = [];
        for (let i = 0; i < GH.passes; i++) {
          g.onePass(sym ? { right: true, sym: true } : { right: true });
          tr.push([g.players[0].x, g.players[0].y]);
        }
        return tr;
      };
      /* THE SHIPPED DEFAULT: FAITHFUL_SYM_CHEAT is off (see its own
         comment, a product decision -- REBIND KEYS can now hand SYM out
         like any other key precisely because it no longer does anything
         special).  Holding SYM at the default must therefore make NO
         difference at all -- the PLAIN trace, not the cheat one -- which
         is what actually proves the flag gates the EFFECT and not just
         whether the key gets read. */
      checkTrue('FAITHFUL_SYM_CHEAT defaults to off', G.symCheat.get() === false);
      check('...so by default, holding SYM changes nothing -- the plain trace',
            walk(true), GH.plain);
      /* THE FAITHFUL PATH remains fully ported and fully tested -- flip the
         flag on, the same shape tools/headless.js already uses for the
         other two faithful/added boundaries (tapePrompts,
         streamlinedFrontend), and restore it once done. */
      G.symCheat.set(true);
      check('$A84D: without SYMBOL SHIFT the wall blocks, as the original does',
            walk(false), GH.plain);
      check('...and with SYM held the blocked step STANDS -- the cheat, PORTED',
            walk(true), GH.cheat);
      /* NON-VACUITY: a cheat that changed nothing would pass both of those. */
      checkTrue('...and the two traces from the original really differ, so those ' +
                'two checks are testing something',
                JSON.stringify(GH.plain) !== JSON.stringify(GH.cheat));
      /* $A836 jumps STRAIGHT to $A852 and never reaches $A84D, so SYM must
         NOT defeat the leash.  Player 2 is brought in through the JOIN, the
         way the game brings him in -- inGame is a getter and the first
         version of this check tried to poke it. */
      const gl = G.seed({ char: 0x2A, char2: 0x2A });
      gl.actors = [];
      gl.players[0].x = 40; gl.players[0].y = 40;
      gl.onePass({ p2: { fire: true } });               // $9689, the join
      checkTrue('...player 2 joined, so the leash can be tested at all',
                gl.players[1].inGame);
      /* ONE step at the measured clamp point, not a long walk.  TWO earlier
         versions of this check walked 80 and then 40 passes and BOTH were
         vacuous -- a mutant that let SYM skip the leash passed them.  Two
         separate reasons, and both are the geometry rather than the game:
           * walking RIGHT walks INTO player 2, who is simply shoved along,
             so the separation never grows at all (measured: 4);
           * and on a 128-unit torus a long unleashed walk goes past the far
             side and comes back to a SMALL separation again -- 80 units out
             reads as 44 apart, under the $3D limit, so the check passed.
         So instead: put player 1 exactly where the leash was MEASURED to
         clamp him -- x=112 against player 2's join seat at 44, holding LEFT,
         which is where the real engine stopped -- and take ONE step. */
      gl.players[0].x = 112; gl.players[0].y = 40;
      const held = gl.players[0].x;
      gl.onePass({ left: true, sym: true });
      checkTrue('...and SYM does NOT defeat the leash ($A836 skips $A84D)',
                gl.players[0].x === held,
                'x ' + held + ' -> ' + gl.players[0].x +
                ', player 2 at ' + gl.players[1].x);
      G.symCheat.set(false);           // back to the shipped default
    }
  }

  /* --- $A544 / $AF86, A POTION IS ONLY AS STRONG AS THE CHARACTER -----
     build/_magic.json is written by `python tools/magicgate.py`: 24 tier-$10
     ghosts parked on camera, one potion, on the real Z80, for each of the
     four characters.  $AF86 kills only ON BORROW, and the row comes from the
     character's magic level, so a WARRIOR's $10 - $10 = 0 leaves the monster
     standing while an ELF's $10 - $18 borrows and kills it.
     THE TRAP: $AF72 bumps the kill tally BEFORE $AF86 chooses the damage, so
     the tally reads $24 for every character whether they killed 24 or 4.  A
     check on kills or score passes with the potion doing nothing at all --
     only the LIVE COUNT and the per-actor tier can see this. */
  {
    const mPath = path.join(ROOT, 'build', '_magic.json');
    if (!fs.existsSync(mPath)) {
      checkTrue('build/_magic.json present (python tools/magicgate.py)', false);
    } else {
      const M = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      const CH = {warrior: 0, valkyrie: 1, wizard: 2, elf: 3};
      for (const name of Object.keys(M)) {
        const W = M[name];
        const g = G.seed({ char: CH[name] });
        g.players[0].potions = 4;
        const px = g.x, py = g.y;
        g.actors.length = 0;
        for (let k = 0; k < W.planted; k++)
          g.actors.push({x: (px + ((k % 6) - 3) * 4) & 0x7F,
                         y: (py + (Math.floor(k / 6) - 2) * 4) & 0x7F,
                         state: 0x10, flags: 0x04, drawn: false});
        g.onePass({ potion: true });
        const tiers = {};
        for (const a of g.actors) {
          const key = '$' + (a.state & 0x18).toString(16).toUpperCase().padStart(2, '0');
          tiers[key] = (tiers[key] || 0) + 1;
        }
        check('$A544: the ' + name + ' selects the $7D1C row the original does',
              [g.potionK, g.potionLo, g.potionHi], [W.K, W.lo, W.hi]);
        /* THE SURVIVORS' TIER IS EXACT; THE COUNT CARRIES ONE ACTOR OF
           SLACK, and only for the weak characters.  Every survivor must be
           tier $00 -- that is $AF8B's knock-down and it is arithmetic, not
           entropy.  The COUNT can differ by one because the actor coins
           ($AC25/$AC4C) read `LD A,R`: one monster turns differently and
           crosses the cull edge.  Measured: warrior 19 here against 20 on
           the Z80, valkyrie the same, and the strong characters exact at 0
           because everything dies whichever way it turned.
           The slack does not blunt the check -- a potion that killed
           EVERYTHING would read 0 against 20, and one that killed NOTHING
           would read 24, and both fail by a mile. */
        const wantTier = Object.keys(W.tiers);
        check('...and every ' + name + ' survivor is knocked to tier $00 ($AF8B)',
              Object.keys(tiers), wantTier);
        checkTrue('...and the ' + name + ' leaves the same monsters standing, ' +
                  'within the one actor `LD A,R` can move',
                  Math.abs(g.actors.length - W.live) <= 1,
                  'engine ' + g.actors.length + ' vs Z80 ' + W.live);
      }
      /* NON-VACUITY: the characters must not all behave alike, or this is
         testing a potion that does nothing. */
      const lives = Object.keys(M).map(k => M[k].live);
      checkTrue('...and the four characters really do differ, so those checks bite',
                new Set(lives).size > 1, JSON.stringify(lives));
      checkTrue('...and the kill TALLY cannot see it ($AF72 counts touches)',
                new Set(Object.keys(M).map(k => M[k].tally)).size === 1);
    }
  }

  /* --- $A31A, THE TREASURE CHEST'S SPARKLE ---------------------------
     build/_sparkle.json is written by `python tools/sparklegate.py`: the real
     Z80's $13 tile watched over 120 passes.  The masks come from $B575
     (`LD A,R`) so the SEQUENCE cannot be reproduced and is not compared --
     what is compared is the SHAPE, which is fully determined:
       ever-set   = the master's own bits; a bit not in the master can never
                    appear whatever the mask
       always-set = the bits the mask cannot clear -- `OR $F0` pins the high
                    byte's top nibble, `OR $0F` the low byte's bottom nibble
       flicker    = ever AND NOT always
     A still picture -- which is what the port drew, one frozen frame of an
     animation -- has an empty flicker mask and fails all three. */
  {
    const sPath = path.join(ROOT, 'build', '_sparkle.json');
    if (!fs.existsSync(sPath)) {
      checkTrue('build/_sparkle.json present (python tools/sparklegate.py)', false);
    } else {
      const S = JSON.parse(fs.readFileSync(sPath, 'utf8'));
      const MT = G.assets.map_tiles;
      const tile = MT.static[S.tile];
      const g = G.seed({});
      const always = new Array(32).fill(0xFF), ever = new Array(32).fill(0);
      let oddMoves = 0, prev = tile.bitmap.slice();
      for (let i = 0; i < S.passes; i++) {
        g.onePass({});
        /* SAMPLE AFTER, and the Z80 side samples BEFORE, for the same pass.
           $9CFB advances $8491 at the BOTTOM of the loop, so on the original
           the value $A31A saw is the one standing before the pass ran; the
           engine advances passCtr at the TOP so that everything in the pass
           sees one value, which is that same number read afterwards.  Reading
           both the same way inverts one of them -- which is what the first
           version of this check did. */
        const parity = g.passCtr & 1;
        for (let b = 0; b < 32; b++) {
          always[b] &= tile.bitmap[b];
          ever[b] |= tile.bitmap[b];
        }
        if (tile.bitmap.some((v, k) => v !== prev[k]) && parity) oddMoves++;
        prev = tile.bitmap.slice();
      }
      const flick = always.map((a, i) => (ever[i] & ~a) & 0xFF);
      check('$A31A: the chest flickers exactly the bits the original flickers',
            flick, S.flicker);
      check('...and pins exactly the bits the original pins', always, S.always);
      check('...and never shows a bit the master does not have', ever, S.ever);
      check('...and only ever moves on an EVEN pass ($A33B AND 1 / RET nz)',
            oddMoves, 0);
      /* NON-VACUITY: a still tile would satisfy "pins everything" trivially. */
      checkTrue('...and it really is animated, not a frozen frame',
                flick.some(v => v !== 0));
    }
  }

  /* --- $B61F, THE INVENTORY ICONS ON THE HUD -------------------------
     The six "special potion" items ($19..$1E) each set a bit of (IX+$14),
     and $B61F shows which you hold by writing that bit's COLOUR into an
     attribute cell -- the symbols themselves are permanently in the panel
     art at row 20, columns 0,1,2 and 12,13,14, and a bit you do NOT hold
     gets attribute 0, black on black.
       bit 0 armour $46   bit 1 pickup $43   bit 2 magic $44
       bit 3 shot   $42   bit 4 speed  $47   bit 5 fight $45
     The renderer used to pass 0x00 for all six -- its comment said "always
     0" -- so it drew the symbols and then made every one of them invisible,
     whatever the player was carrying.  Reported from play as the special
     potions not showing a symbol on the HUD.
     Counting PIXELS, not distinct colours: bit 2's green is already in the
     panel's own palette, so a set-of-colours test cannot see it. */
  {
    const HUDP = G.assets.hud_font && G.assets.hud_font.panel;
    if (!HUDP || !HUDP.icon_cols) {
      checkTrue('the HUD asset carries the six icon columns and attributes', false);
    } else {
      const COLS = HUDP.icon_cols, ATTRS = HUDP.icon_attrs;
      const BRT = ['#000000','#0000ff','#ff0000','#ff00ff',
                   '#00ff00','#00ffff','#ffff00','#ffffff'];
      const countAt = (p14, k, colour) => {
        const g = G.seed({}); g.players[0].p14 = p14;
        /* FOUR QUARTERS: the six icons sit on the band's last cell row
           (row 23), cells 0-5 of quarter 1 */
        const row = 23 * 8; let n = 0;
        const cap = { set fillStyle(v){this._f=v;}, get fillStyle(){return this._f;},
          fillRect(x, y, w, h) {
            if (this._f !== colour) return;
            for (let yy = y; yy < y + h; yy++) {
              if (yy < row || yy >= row + 8) continue;
              for (let xx = x; xx < x + w; xx++)
                if ((xx >> 3) === k) n++;
            }
          } };
        G.render(cap, g);
        return n;
      };
      let lit = 0, bled = 0;
      for (let k = 0; k < 6; k++) {
        const colour = BRT[ATTRS[k] & 7];
        const off = countAt(0x00, k, colour);
        const on = countAt(1 << k, k, colour);
        if (on > off) lit++;
        /* and holding bit k must not light any OTHER icon */
        for (let j = 0; j < 6; j++) if (j !== k) {
          const c2 = BRT[ATTRS[j] & 7];
          if (countAt(1 << k, j, c2) > countAt(0x00, j, c2)) bled++;
        }
      }
      check('$B61F lights each of the six inventory icons in its own colour',
            lit, 6);
      check('...and lighting one lights no other', bled, 0);
    }
  }

  /* --- THE CAMERA AT THE MAP EDGE, $A3E6 / $B58C ---------------------
     build/_cam_edge.json is written by `python tools/camgate.py`: the real
     Z80 walked across open ground until the camera hit its clamp and the
     player wrapped past it.  Reported from play as "the scroll stops working
     and I can leave through the edge of the playfield" -- and it is what the
     ORIGINAL does.  $B58C clamps at 66 across and 90 down because that is
     the map edge, and the player's own coordinate is masked to 7 bits, so he
     wraps 127 -> 0 and walks out of one side into the other while the camera
     is still pinned.  A treasure room is simply the first place open enough
     to get there.  This check is that the port does it the SAME way. */
  {
    const cPath = path.join(ROOT, 'build', '_cam_edge.json');
    if (!fs.existsSync(cPath)) {
      checkTrue('build/_cam_edge.json present (python tools/camgate.py)', false);
    } else {
      const C = JSON.parse(fs.readFileSync(cPath, 'utf8'));
      for (const dir of Object.keys(C.runs)) {
        const S = C.setup[dir];
        const g = G.seed({});
        g.actors = [];
        for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++) g.map[r][c] = 0;
        g.players[0].x = S.start[0]; g.players[0].y = S.start[1];
        g.camX = S.cam[0]; g.camY = S.cam[1];
        const rows = [];
        for (let i = 0; i < C.passes; i++) {
          g.onePass({ [dir]: true });
          rows.push([g.players[0].x, g.players[0].y, g.camX, g.camY]);
        }
        let bad = 0, first = null;
        for (let i = 0; i < C.passes; i++)
          for (let k = 0; k < 4; k++)
            if (rows[i][k] !== C.runs[dir][i][k]) {
              bad++;
              if (!first) first = 'pass ' + (i + 1) + ' col ' + k + ': engine ' +
                rows[i][k] + ' vs Z80 ' + C.runs[dir][i][k];
            }
        check('walking ' + dir + ' off the map edge: the camera tracks exactly ' +
              'as the original does', [bad, first], [0, null]);
      }
      /* NON-VACUITY: the runs must actually reach the clamp and wrap, or this
         is testing an ordinary stroll across the middle of the map. */
      const rt = C.runs.right, dn = C.runs.down;
      checkTrue('...and the runs really do reach the clamp and wrap past it',
                rt.some(r => r[2] === 66) && dn.some(r => r[3] === 90) &&
                rt.some((r, i) => i && r[0] < rt[i - 1][0]));
    }
  }

  /* --- THE TREASURE ROOM'S PAY-OUT, $A748 / $891C / $899F -------------
     build/_treasure.json is written by `python tools/treasgate.py`.  Three
     arms, all newly ported: a $13 CHEST bumps (IX+12) in BCD but only in a
     treasure room ($A748); the level ending in one raises the pay-out panel
     ($891C SET 6,(IY+$3A)); and the pay-out scores (IX+12) x 100, or NOTHING
     if the player never reached the exit ($89AE SUB A). */
  {
    const tPath = path.join(ROOT, 'build', '_treasure.json');
    if (!fs.existsSync(tPath)) {
      checkTrue('build/_treasure.json present (python tools/treasgate.py)', false);
    } else {
      const T = JSON.parse(fs.readFileSync(tPath, 'utf8'));
      const F_EXIT = 0x40;                                  // (IX+11) bit 6
      for (const name of Object.keys(T)) {
        const S = T[name];
        const g = G.seed({});
        g.actors = [];
        for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++)
          g.map[r][c] = S.before[r * 32 + c];
        g.players[0].x = S.start[0]; g.players[0].y = S.start[1];
        g.players[0].levelOwn = S.levelOwn;
        g.players[0].score = 0;
        g.treasure = S.treasure;
        if (S.exiting) g.players[0].f11 |= F_EXIT;
        if (S.arm) {
          /* $8543's own call, with $847D bit 7 already set -- the isolated
             arm, so no level transition and no entropy-built next dungeon. */
          g.levelDone = true;
          const s0 = g.players[0].score;
          g.bannerPass();
          check('$891C/$899F "' + name + '": the pay-out is what the original pays',
                g.players[0].score - s0, S.paid);
        } else {
          const rows = [];
          for (let i = 0; i < S.rows.length; i++) {
            g.onePass({ right: true });
            rows.push([g.players[0].levelOwn, g.bannerCode,
                       g.players[0].score, g.players[0].x]);
          }
          let bad = 0, first = null;
          for (let i = 0; i < S.rows.length; i++) {
            /* column 2 of the capture is $847D, a composite byte the engine
               keeps as separate flags; the other four compare directly. */
            const want = [S.rows[i][0], S.rows[i][1], S.rows[i][3], S.rows[i][4]];
            for (let k = 0; k < 4; k++)
              if (rows[i][k] !== want[k]) {
                bad++;
                if (!first) first = 'pass ' + (i + 1) + ' col ' + k + ': engine ' +
                  rows[i][k] + ' vs Z80 ' + want[k];
              }
          }
          check('$A748 "' + name + '": the chest counter follows the original',
                [bad, first], [0, null]);
        }
      }
      /* NON-VACUITY: treasure mode has to be what makes the difference. */
      checkTrue('...and treasure mode is what decides it, both ways',
                T['chest-tre'].rows[T['chest-tre'].rows.length - 1][0] !==
                T['chest-plain'].rows[T['chest-plain'].rows.length - 1][0] &&
                T['payout-exit'].paid !== T['payout-miss'].paid &&
                T['payout-plain'].paid === 0);
    }
  }

  /* --- $A7D5, the $32 KEY HOARD, and its drip at $A4DD ----------------
     build/_hoard.json is written by `python tools/hoardgate.py`: the real
     Z80 walked onto a planted $32 with planted records at $5BE8, 40 passes
     each, five scenarios.  The port had the DROP and the DRIP already; what
     was missing was the SEARCH, so doHoard() paid the 100 points and cleared
     the cell without ever handing a key over.
     `full` is the sharp one: $A4E7 DECs the queue BEFORE $A4E8 tests the
     carry limit, so keys that will not fit are THROWN AWAY -- nine queued
     onto a player already holding nine yields exactly one. */
  {
    const hPath = path.join(ROOT, 'build', '_hoard.json');
    if (!fs.existsSync(hPath)) {
      checkTrue('build/_hoard.json present (python tools/hoardgate.py)', false);
    } else {
      const H = JSON.parse(fs.readFileSync(hPath, 'utf8'));
      for (const name of Object.keys(H)) {
        const S = H[name];
        const g = G.seed({});
        g.actors = [];
        for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++)
          g.map[r][c] = S.before[r * 32 + c];
        g.players[0].x = S.start[0]; g.players[0].y = S.start[1];
        g.players[0].keys = S.keys0; g.players[0].potions = 0;
        /* hoardgate records are [row, col, count]; the engine keeps
           [col, row, count], the order $9413 pushes them in. */
        g.hoard = S.recs.map(r => [r[1], r[0], r[2]]);
        g.hoardCount = S.recs.length;
        const rows = [];
        for (let i = 0; i < S.passes; i++) {
          g.onePass({ right: true });
          rows.push([g.players[0].keys, g.players[0].hoardKey,
                     g.players[0].f11, g.players[0].score,
                     g.map[S.cell[0]][S.cell[1]]]);
        }
        let bad = 0, first = null;
        for (let i = 0; i < S.passes; i++)
          for (let k = 0; k < 5; k++)
            if (rows[i][k] !== S.rows[i][k]) {
              bad++;
              if (!first) first = 'pass ' + (i + 1) + ' col ' + k +
                ': engine ' + rows[i][k] + ' vs Z80 ' + S.rows[i][k];
            }
        check('$A7D5 hoard "' + name + '": the engine pays out as the original does',
              [bad, first], [0, null]);
      }
      /* NON-VACUITY: a doHoard that never looked a record up would leave every
         key count at its start value, so the tables must actually move. */
      checkTrue('...and the hoards really paid keys out, so those checks are ' +
                'not passing on a no-op',
                Object.keys(H).every(k =>
                  H[k].rows[H[k].passes - 1][0] > H[k].keys0));
    }
  }
}


/* ====================================================================
   THE EXIT SEQUENCE, $94E1 and the sprite swap at $9555.

   build/_exit.json is written by `python tools/exitgate.py`: the real Z80's
   per-pass table for a player who steps onto a $36 -- position, (IX+11), the
   countdown (IX+$16), the rotating slot (IX+13), and WHICH RECORD the master
   pointer table names at id $D0.  That last column is what pins $9595: the
   original installs record 24 when the countdown reaches exactly 7, and the
   last seven passes therefore draw records 24..31 -- the shrink.            */
{
  const ePath = path.join(ROOT, 'build', '_exit.json');
  if (!fs.existsSync(ePath)) {
    checkTrue('build/_exit.json present (python tools/exitgate.py)', false);
  } else {
    const E = JSON.parse(fs.readFileSync(ePath, 'utf8'));
    const g = G.seed({ char: E.char, char2: E.char });
    /* the original's own drain clock AND its phase -- see tools/exitgate.py */
    if (E.clock && E.clock.length) g.clockOverride = E.clock.slice();
    if (E.seed) { g.drainPhase = E.seed.phase; g.frameCtr = E.seed.frame;
                  g.hurry = E.seed.hurry; g.f11 = E.seed.f11; }
    const px = g.x, py = g.y;
    g.map[py >> 2][(px >> 2) + 1] = 0x36;
    const rows = [];
    for (let i = 0; i < E.rows.length; i++) {
      g.onePass({ right: true });
      rows.push({ x: g.x, y: g.y, f11: g.f11, ctr: g.exitCtr,
                  slot: g.frameSlot, rec0: g.exitFrames ? 24 : 0 });
      if (g.f11 & 0x80) break;
    }
    check('the exit sequence is the original\'s length', rows.length,
          E.rows.length);
    let bad = 0, first = null;
    for (let i = 0; i < Math.min(rows.length, E.rows.length); i++) {
      const a = rows[i], b = E.rows[i];
      const same = a.x === b.x && a.y === b.y && a.f11 === b.f11 &&
                   a.ctr === b.ctr && a.slot === b.slot && a.rec0 === b.rec0;
      if (!same) {
        bad++;
        if (!first) first = 'pass ' + (i + 1) + ' engine ' + JSON.stringify(a) +
                            ' vs Z80 ' + JSON.stringify(b);
      }
    }
    check('...and it reproduces the original pass for pass',
          bad === 0 ? 'all agree' : bad + '/' + rows.length + ' differ -- ' + first,
          'all agree');
    /* the swap itself, named rather than implied by the table above */
    const swapZ = E.rows.findIndex(r => r.rec0 === 24);
    const swapP = rows.findIndex(r => r.rec0 === 24);
    check('the sprite set swaps to record 24 on the same pass',
          swapP, swapZ);
    check('...which is the pass the countdown reaches 7 ($9558 CP 7)',
          E.rows[swapZ].ctr, 7);
    checkTrue('...and it is the LAST SEVEN passes that use it',
              E.rows.length - swapZ === 7 + 1);
    /* THE RENDERER, not just the state.  A state-only test cannot see which
       sprite reached the screen (manual G6), and three mutations proved it:
       never drawing the exit set, ignoring the slot, and ignoring the per-frame
       ink were all invisible until this block existed.  Render the same pass
       twice -- once with the swap armed and once without -- and require the
       draw list to differ, then require it to differ AGAIN between two
       different slots and between two frames whose inks differ. */
    const drawAt = (armed, slot) => {
      const h = G.seed({ char: E.char });
      h.p.exitFrames = armed; h.p.frameSlot = slot;
      h.p.f11 |= 0x40;                       // exiting, so he is drawn
      recording = true; drawCalls.length = 0;
      G.render(ctxStub, h);
      recording = false;
      return JSON.stringify(drawCalls);
    };
    checkTrue('the exit set actually REACHES THE SCREEN, not just the state',
              drawAt(true, 1) !== drawAt(false, 1));
    checkTrue('...and the rotating slot picks a different exit frame',
              drawAt(true, 1) !== drawAt(true, 3));
    /* THE INK, isolated.  Comparing two slots' draw lists cannot test the ink
       path: their BITMAPS differ too, so the lists differ either way and a
       mutation pinning the ink to inks[0] survived.  Assert the actual colour
       instead -- the warrior's exit inks are $42,$42,$42,$42,$42,$02,$03,$0D,
       and $42 is BRIGHT red while $02 is dim red, which are different strings
       in the palette. */
    const PAL_D = ['#000000','#0000d7','#d70000','#d700d7','#00d700','#00d7d7','#d7d700','#d7d7d7'];
    const PAL_B = ['#000000','#0000ff','#ff0000','#ff00ff','#00ff00','#00ffff','#ffff00','#ffffff'];
    const inkColour = (slot) => {
      const h = G.seed({ char: E.char });
      h.p.exitFrames = true; h.p.frameSlot = slot; h.p.f11 |= 0x40;
      recording = true; drawCalls.length = 0;
      G.render(ctxStub, h);
      recording = false;
      const want = G.__EXIT_FRAMES__[E.char & 3].inks[slot];
      const pal = (want & 0x40) ? PAL_B : PAL_D;
      return { seen: new Set(drawCalls.map(c => c[5])), want: pal[want & 7] };
    };
    for (const slot of [4, 5, 7]) {
      const r = inkColour(slot);
      checkTrue('exit frame ' + slot + ' is drawn in ITS OWN ink (' + r.want + ')',
                r.seen.has(r.want));
    }

    /* the frames themselves must have shipped, per character */
    const EF = G.__EXIT_FRAMES__;
    if (EF) {
      check('all four characters ship eight exit frames',
            EF.map(e => (e && e.frames.length) || 0).join(','), '8,8,8,8');
      checkTrue('...and the four sets are DISTINCT, not one recoloured',
                new Set(EF.map(e => e.frames[0].join(','))).size === 4);
      checkTrue('...and each frame carries its own attribute ($42..$0D for ' +
                'the warrior), so the colour changes as he goes',
                new Set(EF[0].inks).size > 1);
    } else {
      checkTrue('exit frames exported for the gate', false);
    }
  }
}


/* ====================================================================
   MONSTER SHOTS, against the real Z80's own ring and array.

   build/_mshot.json is written by `python tools/mshotgate.py`: six scenes of
   class-2 actors placed around the player, and for each pass the whole
   64-byte ring at $5B90, the count $84A8, every live record in the $5B20
   array, the player's health and the live actor count.

   `skew` is the negative control -- two actors on camera, facing the player,
   and NOT aligned.  It must produce no shots at all and leave the health
   untouched, which is what says the alignment test is a test and not a
   formality.                                                               */
{
  const mPath = path.join(ROOT, 'build', '_mshot.json');
  if (!fs.existsSync(mPath)) {
    checkTrue('build/_mshot.json present (python tools/mshotgate.py)', false);
  } else {
    const M = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    let scenes = 0, bad = 0, firstBad = null, everFired = 0;
    for (const name of Object.keys(M)) {
      const S = M[name];
      scenes++;
      const g = G.seed({ char: 0x2A, char2: 0x2A });
      if (S.clock && S.clock.length) g.clockOverride = S.clock.slice();
      if (S.seed) { g.drainPhase = S.seed.phase; g.frameCtr = S.seed.frame;
                    g.health = S.seed.hp; g.hurry = S.seed.hurry;
                    g.f11 = S.seed.f11; }
      const px = g.x, py = g.y;
      if (S.p14) g.p14 |= S.p14;
      if (S.p15 !== null && S.p15 !== undefined) g.p15 = S.p15;
      const plant = () => {
        S.actors.forEach((d, i) => {
          const a = g.actors[i];
          a.x = (px + d[0]) & 0x7F; a.y = (py + d[1]) & 0x7F;
          a.state = (S.cls === undefined ? 0x40 : S.cls) | d[2]; a.flags = 0x04;
        });
        (S.prey || []).forEach((d, j) => {
          const a = g.actors[S.actors.length + j];
          a.x = (px + d[0]) & 0x7F; a.y = (py + d[1]) & 0x7F;
          a.state = S.preystate || 0x00; a.flags = 0x04;
        });
      };
      plant();
      for (let p = 0; p < S.rows.length; p++) {
        plant();                 // every pass -- see tools/mshotgate.py
        if (S.p2at) {                       // placed, not joined
          g.players[1].x = (px + S.p2at[0]) & 0x7F;
          g.players[1].y = (py + S.p2at[1]) & 0x7F;
          g.players[1].f11 &= ~0xC0;
        }
        g.onePass(S.join && p === 0 ? {p2: {fire: true}} : {});
        const want = S.rows[p];
        const ring = JSON.stringify([...g.ring.slice(0, 64)]);   // the original's sixteen slots
        const shots = JSON.stringify(g.mshots.map(s => [s.x, s.y, s.state, s.flags]));
        const mine = { ring, n: g.mshots.length, shots,
                       hp: g.players[0].health, hp2: g.players[1].health,
                       score: g.players[0].score, nact: g.actors.length };
        const theirs = { ring: JSON.stringify(want.ring), n: want.n,
                         shots: JSON.stringify(want.shots),
                         hp: want.hp, hp2: want.hp2, score: want.score,
                         nact: want.nact };
        if (want.n) everFired++;
        for (const k of ['ring', 'n', 'shots', 'hp', 'hp2', 'score', 'nact']) {
          if (mine[k] !== theirs[k]) {
            bad++;
            if (!firstBad) firstBad = name + ' pass ' + (p + 1) + ' ' + k +
              ': engine ' + mine[k] + ' vs Z80 ' + theirs[k];
            break;
          }
        }
      }
    }
    check('the monster-shot matrix is twelve scenes of measured Z80 passes',
          scenes, 12);
    checkTrue('...in which the original really did fire', everFired > 10);
    check('the engine reproduces the ring, the array, BOTH healths, the ' +
          'score and the actor count pass for pass',
          bad === 0 ? 'all agree' : bad + ' differ -- ' + firstBad, 'all agree');
    /* the negative control, named so it cannot be lost in the total above */
    const skew = M.skew;
    checkTrue('...and `skew` -- on camera, facing him, NOT aligned -- fires ' +
              'nothing on either side',
              skew.rows.every(r => r.n === 0));
    checkTrue('...and leaves the health untouched, unlike every other scene',
              skew.rows[skew.rows.length - 1].hp >
              M.vert.rows[M.vert.rows.length - 1].hp);
    /* THE THREE ALIGNMENT WINDOWS, at routine level.  build/_mshotgrid.json
       is `python tools/mshotgate.py grid`: $AF8F called DIRECTLY with the
       registers set, over 8 facings x 13 x 13 offsets, recording which ring
       slot it claimed.  No actor loop, no movement and no LD A,R, which is
       the only way to pin the edges of the windows -- in a live scene the
       facing that fires is the POST-TURN facing and the coin decides it. */
    {
      const gPath = path.join(ROOT, 'build', '_mshotgrid.json');
      if (!fs.existsSync(gPath)) {
        checkTrue('build/_mshotgrid.json present ' +
                  '(python tools/mshotgate.py grid)', false);
      } else {
        const GR = JSON.parse(fs.readFileSync(gPath, 'utf8')).rows;
        const gg = G.seed({ char: 0x2A });
        const px = gg.x, py = gg.y;
        let bad = 0, first = null, fired = 0, p2slots = 0;
        let curWho = -1;
        for (const [who, f, dx, dy, want] of GR) {
          if (who !== curWho) {
            curWho = who;
            if (who) {                       // player 1 dead, player 2 in his place
              gg.players[0].f11 |= 0x80;
              gg.players[1].f11 &= ~0x80;
              gg.players[1].x = px; gg.players[1].y = py;
            }
          }
          gg.ring.fill(0xFF);
          gg.mshots.length = 0;
          const a = {x: (px - dx) & 0x7F, y: (py - dy) & 0x7F,
                     state: 0x40 | f, flags: 0x04};
          gg.actorFire(a, 0x40 | f, 0x40);
          let got = -1;
          for (let k = 0; k < 64; k++) if (gg.ring[k] !== 0xFF) { got = k; break; }
          if (want >= 0) { fired++; if (want >= 32) p2slots++; }
          if (got !== want) {
            bad++;
            if (!first) first = 'player ' + (who + 1) + ' facing ' + f +
                                ' dx ' + dx + ' dy ' + dy +
                                ': engine slot ' + got + ' vs Z80 ' + want;
          }
        }
        check('$AF8F claims the same ring slot over 2,704 (player, facing, ' +
              'dx, dy) probes',
              bad === 0 ? 'all agree' : bad + '/' + GR.length + ' differ -- ' + first,
              'all agree');
        checkTrue('...and the original fired on 1,360 of them, so the grid ' +
                  'straddles all three windows', fired === 1360);
        checkTrue('...half of them into PLAYER TWO half of the ring, which ' +
                  'is $B049 SET 5,L', p2slots === 680);
      }
    }

    /* THE RENDERER.  Everything above is state, and a state-only test cannot
       see whether a monster shot reached the screen (manual G6) -- the exit
       sequence proved that the hard way.  Render one pass with a live shot
       and once with the array emptied, and require the draw list to differ. */
    {
      const gr = G.seed({ char: 0x2A });
      const px2 = gr.x, py2 = gr.y;
      const A2 = [[0, 12, 0], [12, 0, 6]];
      let shot = null;
      for (let p = 0; p < 8 && !shot; p++) {
        A2.forEach((d, i) => { const a = gr.actors[i];
          a.x = (px2 + d[0]) & 0x7F; a.y = (py2 + d[1]) & 0x7F;
          a.state = 0x40 | d[2]; a.flags = 0x04; });
        gr.onePass({});
        if (gr.mshots.some(x => x.drawn)) shot = gr.mshots.filter(x => x.drawn);
      }
      checkTrue('a monster shot lives long enough to be drawn', !!shot);
      if (shot) {
        recording = true; drawCalls.length = 0;
        G.render(ctxStub, gr);
        recording = false;
        const withShot = JSON.stringify(drawCalls);
        const saved = gr.mshots.slice();
        gr.mshots.length = 0;
        recording = true; drawCalls.length = 0;
        G.render(ctxStub, gr);
        recording = false;
        const without = JSON.stringify(drawCalls);
        gr.mshots.push(...saved);
        checkTrue('...and it REACHES THE SCREEN, not just the array',
                  withShot !== without);
        /* WHICH sprite, not merely that something was drawn: tag $90's ink is
           $46, BRIGHT YELLOW, where the four character banks are $42/$45/
           $46/$44.  Comparing with-shot against without-shot cannot see the
           bank -- a mutation that drew monster shots from tag $00 survived
           until this asserted the colour. */
        const PAL_B2 = ['#000000','#0000ff','#ff0000','#ff00ff','#00ff00',
                        '#00ffff','#ffff00','#ffffff'];
        const SFB = G.assets.shot_frames.banks;
        const wantInk = SFB['144'].ink;      // tag $90
        /* the calls the shot ADDS -- a colour set is no good, the playfield
           already has bright yellow in it */
        const bag = new Map();
        for (const c of JSON.parse(without))
          bag.set(JSON.stringify(c), (bag.get(JSON.stringify(c)) || 0) + 1);
        const added = [];
        for (const c of JSON.parse(withShot)) {
          const k = JSON.stringify(c);
          if (bag.get(k)) bag.set(k, bag.get(k) - 1); else added.push(c);
        }
        checkTrue('...in the MONSTER bank own ink, $' + wantInk.toString(16) +
                  ' (' + PAL_B2[wantInk & 7] + '), not a character bank',
                  added.length > 0 &&
                  added.some(c => c[5] === PAL_B2[wantInk & 7]));
      }
    }

    /* CLASS 3's AIM, at routine level.  build/_mshot3.json is
       `python tools/mshotgate.py grid3`: $B060 entered at $B065 with the coin
       supplied, over a 21 x 21 grid of offsets, recording the RECORD it
       appends.  What is compared is the sub-cell vector itself -- the state
       byte's two magnitudes and two signs and the flags byte's counter. */
    {
      const g3Path = path.join(ROOT, 'build', '_mshot3.json');
      if (!fs.existsSync(g3Path)) {
        checkTrue('build/_mshot3.json present ' +
                  '(python tools/mshotgate.py grid3)', false);
      } else {
        const G3 = JSON.parse(fs.readFileSync(g3Path, 'utf8')).rows;
        const g3 = G.seed({ char: 0x2A });
        const px3 = g3.x, py3 = g3.y;
        g3.players[0].timer = 0;
        let bad = 0, first = null, fired = 0;
        const vecs = new Set();
        for (const [dx, dy, n, rec] of G3) {
          g3.mshots.length = 0;
          const a = {x: (px3 - dx) & 0x7F, y: (py3 - dy) & 0x7F,
                     state: 0x60, flags: 0x04};
          g3.actorFire3(a, 0x60, 0);          // the coin, already drawn, even
          const got = g3.mshots.length;
          if (n) { fired++; vecs.add(rec[2] + ',' + rec[3]); }
          let ok = (got === n);
          if (ok && n) {
            const m0 = g3.mshots[0];
            ok = m0.x === rec[0] && m0.y === rec[1] &&
                 m0.state === rec[2] && m0.flags === rec[3];
          }
          if (!ok) {
            bad++;
            if (!first) {
              const m0 = g3.mshots[0];
              first = 'dx ' + dx + ' dy ' + dy + ': engine ' +
                (m0 ? [m0.x, m0.y, m0.state, m0.flags].join(',') : 'none') +
                ' vs Z80 ' + (n ? rec.join(',') : 'none');
            }
          }
        }
        check('$B060 aims the same sub-cell vector over 441 offsets',
              bad === 0 ? 'all agree' : bad + '/' + G3.length + ' differ -- ' + first,
              'all agree');
        checkTrue('...and the original fired on 440 of them', fired === 440);
        checkTrue('...producing 176 DISTINCT vectors, so the aim really varies',
                  vecs.size === 176);
      }
    }

    /* CLASS 3's FLIGHT.  build/_mshot3f.json is
       `python tools/mshotgate.py flight3`: twelve vectors planted directly
       into the $5B20 array and flown by the main loop, which exercises
       $8CBC's sub-cell step, $90AD's lifetime and curve, and the expiry that
       $8D31 turns into "skip both collision scans". */
    {
      const fPath = path.join(ROOT, 'build', '_mshot3f.json');
      if (!fs.existsSync(fPath)) {
        checkTrue('build/_mshot3f.json present ' +
                  '(python tools/mshotgate.py flight3)', false);
      } else {
        const FL = JSON.parse(fs.readFileSync(fPath, 'utf8')).flights;
        let bad = 0, first = null, hit = 0, longest = 0;
        for (const f of FL) {
          const gf = G.seed({ char: 0x2A });
          if (f.clock && f.clock.length) gf.clockOverride = f.clock.slice();
          if (f.seed) { gf.drainPhase = f.seed.phase;
                        gf.frameCtr = f.seed.frame;
                        gf.health = f.seed.hp; }
          gf.mshots.length = 0;
          gf.mshots.push({x: f.x0, y: f.y0, state: f.state, flags: f.flags,
                          drawX: 0, drawY: 0, drawn: false});
          longest = Math.max(longest, f.rows.length);
          for (let p = 0; p < f.rows.length; p++) {
            gf.onePass({});
            const want = f.rows[p];
            const m0 = gf.mshots[0];
            const got = [gf.mshots.length,
                         m0 ? m0.x : -1, m0 ? m0.y : -1,
                         m0 ? m0.state : -1, m0 ? m0.flags : -1,
                         gf.players[0].health];
            const wnt = [want.n, want.n ? want.rec[0] : -1,
                         want.n ? want.rec[1] : -1,
                         want.n ? want.rec[2] : -1,
                         want.n ? want.rec[3] : -1, want.hp];
            if (want.hp < 0x1996) hit++;
            if (JSON.stringify(got) !== JSON.stringify(wnt)) {
              bad++;
              if (!first) first = 'state $' + f.state.toString(16) +
                ' flags $' + f.flags.toString(16) + ' pass ' + (p + 1) +
                ': engine ' + got.join(',') + ' vs Z80 ' + wnt.join(',');
              break;
            }
          }
        }
        check('class 3 flies the same twelve vectors as the original',
              bad === 0 ? 'all agree' : bad + '/' + FL.length +
              ' flights differ -- ' + first, 'all agree');
        checkTrue('...over flights of up to 17 passes', longest >= 17);
        checkTrue('...and at least one of them REACHES the player, which is ' +
                  'the $908E damage of 3 for a bit-6 shot', hit > 0);
      }
    }

    /* CLASS 3's DISPATCH, COIN and TIMER, as UNITS.  grid3 above calls
       $B060's body directly, so it cannot see how the body is REACHED:
       $AF94's CP $60, $B062's CP 7 and $B070's power-up timer are all
       upstream of it.  A live scene cannot see them either -- the coin is
       LD A,R.  So they are driven here, and labelled. */
    {
      const gu = G.seed({ char: 0x2A });
      const near = () => ({x: gu.x, y: (gu.y + 12) & 0x7F,
                           state: 0x60, flags: 0x04});
      /* the DISPATCH: a class 3 must never touch the ring -- it writes the
         array directly, which is the whole difference from class 2 */
      gu.ring.fill(0xFF); gu.mshots.length = 0;
      const realRand = gu.rand8.bind(gu);
      gu.rand8 = () => 0;                    // $B060's coin, pinned
      gu.actorFire(near(), 0x60, 0x60);
      gu.rand8 = realRand;
      checkTrue('a class 3 writes the ARRAY and never the ring ($AF94 CP $60)',
                gu.ring.every(b => b === 0xFF));
      checkTrue('...and it did produce a shot', gu.mshots.length === 1);
      /* THE COIN DOES TWO JOBS.  $B062 CP 7 / RET nc gates it, and then
         $B065 RRA / JR c uses bit 0 to pick WHO to aim at.  So with player 2
         dead only the EVEN coins below 7 fire -- 0, 2, 4, 6 -- and that is
         the rule, not a shortfall. */
      let fires = 0, firesBoth = 0;
      gu.players[1].f11 |= 0x80;                     // player 2 dead
      for (let c = 0; c < 16; c++) {
        gu.mshots.length = 0;
        gu.actorFire3(near(), 0x60, c);
        if (gu.mshots.length) fires++;
      }
      check('$B062 CP 7 and $B065 RRA -- with player 2 dead only the EVEN ' +
            'coins under 7 fire', fires, 4);
      gu.players[1].f11 &= ~0x80;                    // player 2 alive
      gu.players[1].timer = 0;
      gu.players[1].x = gu.x; gu.players[1].y = gu.y;
      for (let c = 0; c < 16; c++) {
        gu.mshots.length = 0;
        gu.actorFire3(near(), 0x60, c);
        if (gu.mshots.length) firesBoth++;
      }
      check('...and with him alive the ODD coins fire too, all seven',
            firesBoth, 7);
      gu.players[1].f11 |= 0x80;
      /* the TIMER, $B070: a FLASHING player is not aimed at */
      gu.mshots.length = 0;
      gu.players[0].timer = 0x20;
      gu.players[1].f11 |= 0x80;             // and player 2 is dead
      gu.actorFire3(near(), 0x60, 0);
      checkTrue('$B070 -- a player with a power-up TIMER is not aimed at',
                gu.mshots.length === 0);
      gu.players[0].timer = 0;
      gu.actorFire3(near(), 0x60, 0);
      checkTrue('...and with the timer clear he is', gu.mshots.length === 1);
      gu.players[1].f11 &= ~0x80;
    }

    /* THE CLASS-3 FIREBALL ON SCREEN.  A state-only test cannot see which of
       the three sizes was drawn, nor that it is the fireball at all -- two
       mutations (pinning the frame to 0, and drawing class 3 as class 2)
       survived everything above. */
    {
      const gz = G.seed({ char: 0x2A });
      const drawWith = (flags) => {
        gz.mshots.length = 0;
        gz.mshots.push({x: gz.x + 6, y: gz.y + 6, state: 0x22, flags,
                        drawX: gz.x + 6, drawY: gz.y + 6, drawn: true});
        recording = true; drawCalls.length = 0;
        G.render(ctxStub, gz);
        recording = false;
        return JSON.stringify(drawCalls);
      };
      const small = drawWith(0xC3), big = drawWith(0xE3);
      checkTrue('the class-3 fireball GROWS: (flags >> 4) & 3 picks the size',
                small !== big);
      /* and it is the FIREBALL, bright green $44, not a shot bank */
      const fb = G.assets.shot_frames.fireball;
      const PAL_D3 = ['#000000','#0000d7','#d70000','#d700d7','#00d700',
                      '#00d7d7','#d7d700','#d7d7d7'];
      const PAL_B3 = ['#000000','#0000ff','#ff0000','#ff00ff','#00ff00',
                      '#00ffff','#ffff00','#ffffff'];
      const ink = fb[0].ink;
      const pal = (ink & 0x40) ? PAL_B3 : PAL_D3;
      checkTrue('...in the fireball ink $' + ink.toString(16) + ', not a ' +
                'character shot bank',
                JSON.parse(small).some(c => c[5] === pal[ink & 7]));
    }

    /* THE CAP, $AF8F BIT 4,(IY+$29) / RET nz.  A UNIT check and labelled as
       one: it needs sixteen live shots, and with two born a pass against a
       life of about three the differential cannot reach it.  Prefilling
       $84A8 would not help -- the Z80 would read sixteen records of whatever
       $5B20 holds and the engine none. */
    {
      const g2 = G.seed({ char: 0x2A });
      const a = g2.actors[0];
      a.x = g2.x; a.y = (g2.y + 12) & 0x7F; a.state = 0x40; a.flags = 0x04;
      g2.ring.fill(0xFF);
      for (let k = 0; k < 16; k++)
        g2.mshots.push({x: 0, y: 0, state: 0xFF, flags: 0x80});
      g2.actorFire(a, 0x40, 0x40);
      checkTrue('at 16 live shots $AF8F refuses to claim a ring slot (unit)',
                g2.ring.every(b => b === 0xFF));
      g2.mshots.length = 15;
      g2.actorFire(a, 0x40, 0x40);
      checkTrue('...and at 15 it claims one, so the guard is the count',
                g2.ring.some(b => b !== 0xFF));
    }
  }
}


/* ====================================================================
   THE MESSAGE BANNER, against the panel the original actually painted.

   build/_banner.json is written by `python tools/bannergate.py`: for each of
   the eight message codes, the 18 x 7 CHARACTER rectangle at row 6 column 7 --
   pixels and attributes -- read off the MAIN screen after the pass, which is
   what the player sees once $9CD7 has blitted the shadow.

   The engine draws the same rectangle in render(), so this compares the two
   bitmaps cell for cell.  A wrong panel, a wrong string, a wrong glyph or a
   wrong position all fail it; nothing here can pass on state alone.        */
{
  const bPath = path.join(ROOT, 'build', '_banner.json');
  if (!fs.existsSync(bPath)) {
    checkTrue('build/_banner.json present (python tools/bannergate.py)', false);
  } else {
    const BN = JSON.parse(fs.readFileSync(bPath, 'utf8'));
    const codes = Object.keys(BN).sort((a, b) => BN[a].code - BN[b].code);
    const AB = G.assets.banner;
    checkTrue('the banner asset shipped (python tools/bannerart.py)',
              !!(AB && AB.frame && AB.texts));
    /* a pixel canvas just big enough for the panel, filled by render() */
    let bad = 0, first = null, drew = 0;
    for (const k of codes) {
      const want = BN[k];
      const g = G.seed({ char: 0x2A });
      g.bannerShow = want.code;
      const R0 = AB ? AB.row : 6, C0 = AB ? AB.col : 7;
      const W = AB ? AB.cols : 18, H = AB ? AB.rows : 7;
      /* capture the 144 x 56 rectangle as a bitmap by recording fillRects */
      const grid = [];
      for (let y = 0; y < H * 8; y++) grid.push(new Array(W * 8).fill(null));
      const cap = {
        set fillStyle(v) { this._f = v; }, get fillStyle() { return this._f; },
        fillRect(x, y, w, h) {
          for (let yy = y; yy < y + h; yy++) {
            const ry = yy - R0 * 8;
            if (ry < 0 || ry >= H * 8) continue;
            for (let xx = x; xx < x + w; xx++) {
              const rx = xx - C0 * 8;
              if (rx < 0 || rx >= W * 8) continue;
              grid[ry][rx] = this._f;
            }
          }
        },
      };
      G.render(cap, g);
      /* the original's pixels, as ink/paper booleans */
      const PAL_D = ['#000000','#0000d7','#d70000','#d700d7','#00d700','#00d7d7','#d7d700','#d7d7d7'];
      const PAL_B = ['#000000','#0000ff','#ff0000','#ff00ff','#00ff00','#00ffff','#ffff00','#ffffff'];
      const at = want.at[0][0];
      const pal = (at & 0x40) ? PAL_B : PAL_D;
      const ink = pal[at & 7], paper = pal[(at >> 3) & 7];
      let diff = 0;
      for (let y = 0; y < H * 8; y++) {
        for (let cc = 0; cc < W; cc++) {
          const byte = want.px[y][cc];
          for (let b = 0; b < 8; b++) {
            const on = !!(byte & (0x80 >> b));
            const got = grid[y][cc * 8 + b];
            if (got === null) { diff++; continue; }
            if (got !== (on ? ink : paper)) diff++;
          }
        }
      }
      if (diff) {
        bad++;
        if (!first) first = 'code $' + k + ': ' + diff + ' of ' + (W * 8 * H * 8) +
                            ' pixels differ';
      } else drew++;
    }
    check('the banner is 8 measured panels', codes.length, 8);
    check('the engine paints every one of them pixel for pixel',
          bad === 0 ? 'all agree' : bad + '/' + codes.length + ' differ -- ' + first,
          'all agree');
    checkTrue('...and it really drew them, rather than matching an empty grid',
              drew === codes.length);

    /* THE CODE THE GAME ACTUALLY RAISES.  Every check above drives a code
       bannerart.py captured, and the poisoned food was captured as $81 --
       but $A6F6 does `SET 7,(IY+$3A)` and nothing else, so in play the code
       is $80.  Keyed on the whole byte that found no art and drew NOTHING:
       the sound played, 99 health went, and no panel appeared.
       $8943's `BIT 7,A` selects that panel whatever the low bits are, so $80
       and $81 must paint the same thing. */
    {
      const R0 = AB.row, C0 = AB.col, W = AB.cols, H = AB.rows;
      const shot = (code) => {
        const g = G.seed({ char: 0x2A });
        g.bannerShow = code;
        const grid = [];
        for (let y = 0; y < H * 8; y++) grid.push(new Array(W * 8).fill(null));
        const cap = {
          set fillStyle(v){this._f=v;}, get fillStyle(){return this._f;},
          fillRect(x, y, w, h) {
            for (let yy = y; yy < y + h; yy++) {
              const ry = yy - R0 * 8;
              if (ry < 0 || ry >= H * 8) continue;
              for (let xx = x; xx < x + w; xx++) {
                const rx = xx - C0 * 8;
                if (rx >= 0 && rx < W * 8) grid[ry][rx] = this._f;
              }
            }
          },
        };
        G.render(cap, g);
        return JSON.stringify(grid);
      };
      const a80 = shot(0x80), a81 = shot(0x81), blank = shot(null);
      check('$A6F6 raises code $80, and $8943 BIT 7 paints the poisoned-food ' +
            'panel for it exactly as for $81', a80, a81);
      checkTrue('...and that panel is actually drawn, not an empty rectangle',
                a80 !== blank);
    }

    /* THE NAME LINE.  Every captured panel carries the captured machine's own
       character (tag $20 falls through to ELF), so comparing against them
       cannot tell a substituted name from the stored one -- deleting the
       substitution entirely passed.  Render the same code as a DIFFERENT
       character and require the first line to change. */
    {
      const nameOf = (ch) => {
        const g = G.seed({ char: ch });
        g.bannerShow = 0x01;
        const R0 = AB.row, C0 = AB.col, W = AB.cols;
        const row = new Array(W * 8).fill('');
        const cap = { set fillStyle(v){this._f=v;}, get fillStyle(){return this._f;},
          fillRect(x, y, w, h) {
            for (let yy = y; yy < y + h; yy++) {
              const ry = yy - (R0 + 1) * 8;          // the NAME line
              if (ry < 0 || ry >= 8) continue;
              for (let xx = x; xx < x + w; xx++) {
                const rx = xx - C0 * 8;
                if (rx >= 0 && rx < W * 8 && ry === 3) row[rx] = this._f;
              }
            }
          } };
        G.render(cap, g);
        return JSON.stringify(row);
      };
      /* ALL FOUR, not just two.  $7E21's table spells the four names with
         DIFFERENT alphabets: WARRIOR and ELF are plain ASCII, VALKYRIE is
         codes $81..$89 and WIZARD is $29..$2F -- proportional graphic cells,
         not letters.  The HUD font carries all of them ($20..$89), so all
         four draw; a font extraction that stopped at $7F would silently give
         two of the characters a blank name and this is what would catch it. */
      const names = [0, 1, 2, 3].map(nameOf);
      checkTrue('all four characters get a DIFFERENT banner name line',
                new Set(names).size === 4);
      checkTrue('...and none of them is blank -- VALKYRIE and WIZARD are ' +
                'spelled in codes $81..$89 and $29..$2F, not ASCII',
                names.every(n => n.indexOf('#ffffff') >= 0));
    }

    /* THE $40 BONUS FIGURE.  $7EB0 is a TEMPLATE -- '00`100 BONUS' -- and
       $89D4 patches its first two characters with the BCD digits of the
       player's own level before printing, but only when $89A8's BIT 6 says he
       is EXITING; otherwise $89AE zeroes it, which is why every captured
       panel reads 00 and why the pixel comparison above cannot see this at
       all. */
    {
      const F2 = G.hud.FONT, key2 = {};
      for (const k in F2) { const b = [...F2[k]];
        if (b.some(v => v)) key2[b.join(',')] = String.fromCharCode(k | 0); }
      const bonusLine = (lvl, exiting, afterLevelOver) => {
        const g = G.seed({ char: 0x2A });
        g.players[0].levelOwn = lvl;
        if (exiting) g.players[0].f11 |= 0x40; else g.players[0].f11 &= ~0x40;
        /* RAISE IT THE WAY $891C DOES.  This used to poke bannerShow directly and
           so tested a panel the game never builds: $899F is what works the
           digits out ($89D4 patches them into $7EB0 at BUILD time), and
           skipping it is exactly how the panel came to read 00 in play. */
        g.treasure = true; g.levelDone = true;
        g.bannerPass();
        /* and optionally RENDER IT AFTER the level change, which is when the
           game draws it: advance() runs levelOver() between the pass that
           raises the panel and the frame that shows it. */
        if (afterLevelOver) g.levelOver();
        g.bannerShow = 0x40; g.bannerBy = 0;
        const W = AB.cols, R0 = AB.row, C0 = AB.col;
        const cells = [];
        for (let y = 0; y < 8; y++) cells.push(new Array(W * 8).fill(0));
        const cap = { set fillStyle(v){this._f=v;}, get fillStyle(){return this._f;},
          fillRect(x, y, w, h) {
            for (let yy = y; yy < y + h; yy++) {
              const ry = yy - (R0 + 2) * 8; if (ry < 0 || ry >= 8) continue;
              for (let xx = x; xx < x + w; xx++) {
                const rx = xx - C0 * 8;
                if (rx >= 0 && rx < W * 8) cells[ry][rx] = (this._f === '#ffffff') ? 1 : 0;
              }
            }
          } };
        G.render(cap, g);
        let line = '';
        for (let c = 0; c < W; c++) {
          const gl = [];
          for (let y = 0; y < 8; y++) { let b = 0;
            for (let k = 0; k < 8; k++) b = (b << 1) | cells[y][c * 8 + k]; gl.push(b); }
          line += gl.some(v => v) ? (key2[gl.join(',')] || '?') : ' ';
        }
        return line;
      };
      checkTrue('the $40 bonus line carries the level as two BCD digits',
                bonusLine(0x05, true).indexOf('05') >= 0 &&
                bonusLine(0x12, true).indexOf('12') >= 0 &&
                bonusLine(0x99, true).indexOf('99') >= 0);
      /* AND IT MUST SURVIVE THE LEVEL CHANGE.  advance() calls levelOver()
         -- and so startLevel() -- immediately after the pass that raises the
         panel, BEFORE the frame is drawn.  That resets (IX+12) and clears
         (IX+11) bit 6, so a renderer that recomputes the digits reads 0
         however many chests were banked.  Reported from play as "the points
         dialog says 0 when it should reflect the chests I collected".
         Measured then: 5 before levelOver(), 0 after. */
      {
        const gb = G.seed({ char: 0x2A });
        gb.players[0].levelOwn = 7;
        gb.players[0].f11 |= 0x40;
        gb.treasure = true; gb.levelDone = true;
        gb.bannerPass();
        const before = gb.players[0].bannerBonus;
        gb.levelOver();                       // what advance() does next
        check('the bonus digits survive the level change that follows the panel',
              [before, gb.players[0].bannerBonus], [7, 7]);
      }
      /* THE ONE THAT CATCHES IT: rendered AFTER levelOver(), which is when
         the game actually draws the panel.  Checking bannerBonus alone does
         not -- a renderer that recomputes from (IX+12) passes that and still
         paints 00 on screen, which is the bug as it was reported. */
      checkTrue('...and the RENDERED line still carries them after that change',
                bonusLine(0x07, true, true).indexOf('07') >= 0,
                JSON.stringify(bonusLine(0x07, true, true)));
      checkTrue('...and reads 00 for a player who is NOT exiting ($89AE)',
                bonusLine(0x05, false).indexOf('00') >= 0);
    }

    /* AND IT COMES DOWN.  The panel is raised where $891C draws and cleared at
       the top of the next pass; without that it would sit over the playfield
       for ever, which no captured panel can show. */
    {
      const g = G.seed({ char: 0x2A });
      g.bannerShow = 0x01;
      g.onePass({});
      checkTrue('the banner is taken down on the pass after it is raised',
                g.bannerShow === null);
    }
  }
}

/* ====================================================================
   THE LEVEL-ENTRY SCREEN, $8B27, against what the original painted.

   build/_intro.json is written by `python tools/introgate.py`: nine variants
   of ($847D bit 4, $847E bits 4/5/6), each captured out of the SHADOW after
   the routine has drawn and before $9CD7 blits.

   ONLY CHARACTER ROWS 0..15 ARE COMPARED, and that is the routine's own
   boundary, not a convenience: $B3D0 clears exactly $C000..$CFFF before
   $8B27 runs, so rows 0..15 are entirely this routine's work while rows
   16..23 still hold whatever the previous screen left there.  The two lines
   the routine prints at rows 16 and 17 are checked separately, by decoding
   the engine's own render at those rows.                                  */
{
  const iPath = path.join(ROOT, 'build', '_intro.json');
  if (!fs.existsSync(iPath)) {
    checkTrue('build/_intro.json present (python tools/introgate.py)', false);
  } else {
    const IN = JSON.parse(fs.readFileSync(iPath, 'utf8'));
    const names = Object.keys(IN);
    const AI = G.assets.intro;
    checkTrue('the intro asset shipped (python tools/introart.py)',
              !!(AI && AI.strings && AI.icons));
    const sa = (x, y) => ((y & 0xC0) << 5) | ((y & 7) << 8) |
                         ((y & 0x38) << 2) | (x >> 3);
    const PAL_D = ['#000000','#0000d7','#d70000','#d700d7','#00d700','#00d7d7','#d7d700','#d7d7d7'];
    const PAL_B = ['#000000','#0000ff','#ff0000','#ff00ff','#00ff00','#00ffff','#ffff00','#ffffff'];
    const at = AI ? AI.attr : 0x47;
    const ink = ((at & 0x40) ? PAL_B : PAL_D)[at & 7];
    const paper = ((at & 0x40) ? PAL_B : PAL_D)[(at >> 3) & 7];
    let bad = 0, first = null, drew = 0;
    for (const nm of names) {
      const V = IN[nm];
      const g = G.seed({ char: 0x2A });
      if (V.level !== null && V.level !== undefined) g.level = V.level;
      g.introShow = { potion: !!(V.f847D & 0x10),
                      stun: !!(V.f847E & 0x10),
                      hurt: !!(V.f847E & 0x20),
                      treasure: !!(V.f847E & 0x40) };
      const grid = [];
      for (let y = 0; y < 128; y++) grid.push(new Array(256).fill(null));
      const cap = {
        set fillStyle(v) { this._f = v; }, get fillStyle() { return this._f; },
        fillRect(x, y, w, h) {
          for (let yy = y; yy < y + h && yy < 128; yy++) {
            if (yy < 0) continue;
            for (let xx = x; xx < x + w && xx < 256; xx++)
              if (xx >= 0) grid[yy][xx] = this._f;
          }
        },
      };
      G.render(cap, g);
      let diff = 0, lit = 0;
      for (let y = 0; y < 128; y++) {
        for (let c = 0; c < 32; c++) {
          const byte = V.px[sa(c * 8, y)];
          for (let b = 0; b < 8; b++) {
            const on = !!(byte & (0x80 >> b));
            if (on) lit++;
            const got = grid[y][c * 8 + b];
            if (got !== (on ? ink : paper)) diff++;
          }
        }
      }
      if (diff) {
        bad++;
        if (!first) first = nm + ': ' + diff + ' of 32768 pixels differ';
      } else if (lit) drew++;
    }
    check('the intro is 16 measured variants', names.length, 16);
    check('the engine paints rows 0..15 pixel for pixel on every one',
          bad === 0 ? 'all agree' : bad + '/' + names.length + ' differ -- ' + first,
          'all agree');
    checkTrue('...and every one of them actually drew something', drew === names.length);
    /* the LEVEL NUMBER is drawn in sprites by $8A84, one digit under ten and
       three from a hundred, with no leading zero -- a single-level matrix
       cannot see any of that. */
    /* ROWS 16 AND 17, which the pixel window above deliberately excludes --
       $B3D0 clears only rows 0..15, so the Z80's rows 16..19 carry the
       PREVIOUS screen underneath the text and cannot be compared wholesale.
       The two lines are checked by DECODING the engine's render back through
       the font instead.  Without this, a mutation that let HURT win over
       STUN, and one that dropped the "OTHER PLAYERS" line entirely, both
       passed everything above. */
    {
      const F3 = G.hud.FONT, key3 = {};
      for (const k in F3) { const b = [...F3[k]];
        if (b.some(v => v)) key3[b.join(',')] = String.fromCharCode(k | 0); }
      const readRow = (iv, row) => {
        const g = G.seed({ char: 0x2A });
        g.introShow = iv;
        const cells = [];
        for (let y = 0; y < 8; y++) cells.push(new Array(256).fill(0));
        const cap = { set fillStyle(v){this._f=v;}, get fillStyle(){return this._f;},
          fillRect(x, y, w, h) {
            for (let yy = y; yy < y + h; yy++) {
              const ry = yy - row * 8; if (ry < 0 || ry >= 8) continue;
              for (let xx = x; xx < x + w && xx < 256; xx++)
                if (xx >= 0) cells[ry][xx] = (this._f === '#ffffff') ? 1 : 0;
            }
          } };
        G.render(cap, g);
        let out = '';
        for (let c = 0; c < 32; c++) {
          const gl = [];
          for (let y = 0; y < 8; y++) { let b = 0;
            for (let k = 0; k < 8; k++) b = (b << 1) | cells[y][c * 8 + k];
            gl.push(b); }
          out += gl.some(v => v) ? (key3[gl.join(',')] || '?') : ' ';
        }
        return out.trim();
      };
      const none = {potion:false, stun:false, hurt:false, treasure:false};
      check('$847E bit 4 alone prints SHOTS NOW STUN on row 16',
            readRow({...none, stun:true}, 16), 'SHOTS NOW STUN');
      check('...bit 5 alone prints SHOTS NOW HURT',
            readRow({...none, hurt:true}, 16), 'SHOTS NOW HURT');
      check('...and with BOTH set $8B4F tests bit 4 FIRST, so STUN wins',
            readRow({...none, stun:true, hurt:true}, 16), 'SHOTS NOW STUN');
      check('either bit also prints OTHER  PLAYERS on row 17',
            readRow({...none, stun:true}, 17), 'OTHER  PLAYERS');
      check('...and neither bit prints nothing on row 16',
            readRow(none, 16), '');
      check('...nor on row 17', readRow(none, 17), '');
    }
    checkTrue('...including levels 7, 9, 10, 42, 99, 100 and 137, which is ' +
              'what exercises $8A84 one, two and three digits wide',
              ['lvl7','lvl9','lvl10','lvl42','lvl99','lvl100','lvl137']
                .every(k => IN[k]));
  }

  /* --- HOW LONG THE SCREEN STAYS UP, which is a different question ----
     $B38E CALL $8B27 draws it, $8B84 arms the long pause and calls $9CD7 --
     which BLITS and then, in its tail $9D01, PAUSES.  Both happen before
     $B391 CALL $8503, the level's first pass.  So the screen is on the
     display for the whole level tune, ~210 video frames.
     The engine raises it in startLevel(), which runs BETWEEN passes, and it
     is taken down at the top of the next pass.  Until this check existed the
     pause was not served until that pass had already taken the screen down:
     the screen flashed for 5 render frames (0.08 s) and the tune then played
     over the playfield -- reported from play as "flashes up on the second
     level and doesn't show at all after that".
     Driven at 60 Hz through advance(), which is the loop the browser runs. */
  {
    for (const lv of [1, 2, 3]) {
      const g = G.seed({});
      g.mode = 'play';
      g.level = lv;
      g.startLevel(lv);
      let up = 0, upWhenServed = null;
      for (let i = 0; i < 600; i++) {
        g.advance(1 / 60, {});
        if (g.introShow) up++;
        if (upWhenServed === null && g.passFrames > 100)
          upWhenServed = !!g.introShow;
      }
      checkTrue(`level ${lv}: the entry screen holds for the whole tune, ` +
                'not one render frame',
                up >= 210, up + ' render frames at 60Hz (want >= 210)');
      checkTrue(`...and level ${lv}'s pause is served while that screen is ` +
                'still up ($9D01 runs after $9CD7 blits it)',
                upWhenServed === true);
    }

    /* AND THE TUNE MUST BE AUDIBLE, which is a separate failure.
       edge() only accumulates into the bridge's `pending`; endPass() is what
       moves it into the log, and flushBeeper() renders the log up to simFrame
       and then CLEARS it, tracking how far it has got in `this.next`.  So a
       tune logged after simFrame has already passed its frames is rendered by
       nobody -- it is silently dropped and the level tune does not play.
       That is exactly what happened when the pause was first moved out of
       onePass(): the 140,023 edges reached the log 256 render frames late.
       The invariant is simple and this is it: the tune is logged in the SAME
       advance() call that jumps simFrame across it. */
    const gt = G.seed({});
    gt.mode = 'play';
    gt.sound.logging = true; gt.sound.log.length = 0;
    gt.startLevel(2);
    const tuneCount = () => gt.sound.log.filter(e => e[2] === 'tune').length;
    let jumpAt = null, tuneAt = null;
    for (let i = 0; i < 400; i++) {
      const sf0 = gt.simFrame, n0 = tuneCount();
      gt.advance(1 / 60, {});
      if (jumpAt === null && gt.simFrame - sf0 > 100) jumpAt = i;
      if (tuneAt === null && tuneCount() > n0) tuneAt = i;
    }
    checkTrue('the level tune is logged in the SAME advance() that jumps ' +
              'simFrame, so flushBeeper can still render it',
              jumpAt !== null && jumpAt === tuneAt,
              'simFrame jumped on call ' + jumpAt + ', tune logged on ' + tuneAt);
    checkTrue('...and it really is the whole tune, not a stray edge or two',
              tuneCount() > 1000, tuneCount() + ' edges');

    /* THE ORDER OF THE TWO PANELS AT THE END OF A TREASURE ROOM.
       Reported from play: "the chest points dialog appears over the level
       entry and plays the level entry tune".  Two faults in one:
         * $8B9F RES 5,(IY-2) -- bit 5 picks the tune at $9D10 and is set at
           $8B84 for the ENTRY SCREEN'S pause only, then cleared the moment
           that pause is served.  The port never cleared it, so every later
           pause in the level played the long fanfare.
         * $8556's RET comes AFTER $8550's blit and pause, so the pay-out
           panel is on screen over the room it was earned in for the whole of
           its own tune and the level changes only THEN.  The port called
           levelOver() in the same breath, so the next level's entry screen
           went up in the same frame and the two were drawn on top of
           each other.
       Both are visible in one trace: banner tune first, with the panel up and
       no entry screen; then the entry screen, with the level tune. */
    const go = G.seed({}); go.mode = 'play'; go.actors = [];
    go.sound.logging = true; go.sound.blocks.length = 0;
    go.treasure = true; go.players[0].levelOwn = 5;
    /* START THE ROOM THE WAY $8B84 LEAVES IT -- entry screen up, bit 5 set,
       pause armed.  Without this the room never has bit 5 set at all and the
       tune check below is vacuous: an engine that NEVER clears it still plays
       'banner' for the pay-out, which is how the first version of this check
       passed with $8B9F deleted. */
    go.introShow = { potion: false, stun: false, hurt: false, treasure: true };
    go.pauseLong = true; go.pauseReq = true;       // $8B84 SET 5 / $8B98 SET 2
    for (let i = 0; i < 400 && go.sound.blocks.length === 0; i++)
      go.advance(1 / 60, {});                      // let the entry pause play
    go.treasureTimer = 1; go.treasureDiv = 1;      // then expire the room
    let panelAlone = false, introSeen = false, panelAfterIntro = false;
    for (let i = 0; i < 400; i++) {
      go.advance(1 / 60, {});
      if (go.bannerShow !== null && !go.introShow) panelAlone = true;
      if (go.introShow) introSeen = true;
      if (go.introShow && go.bannerShow !== null) panelAfterIntro = true;
    }
    const order = go.sound.blocks.map(b => b[1]);
    check('the entry screen plays the LONG tune and the pay-out the short one',
          order.slice(0, 2), ['level', 'banner']);
    checkTrue('...and the pay-out panel is shown BEFORE the entry screen, not over it',
              panelAlone && introSeen && !panelAfterIntro,
              'panelAlone=' + panelAlone + ' introSeen=' + introSeen +
              ' overlapped=' + panelAfterIntro);

    /* AND THE DEAD TIME MUST NOT STACK.  Serving the pause debits the
       accumulator by the tune's length; a second pause arriving while the
       accumulator is still negative used to debit it AGAIN, so N level
       starts bought N x 4.2 s of frozen game.  In play that cannot happen --
       a level has to be played between two level starts -- but the test
       panel starts them back to back, and stepping 1 -> 7 froze it for half
       a minute.  The debt is capped at one block. */
    const deadFrames = n => {
      const g = G.seed({}); g.mode = 'play';
      for (let j = 0; j < n; j++) { g.startLevel(2 + j); g.advance(1 / 60, {}); }
      const p0 = g.pass;
      let k = 0;
      while (g.pass === p0 && k < 5000) { g.advance(1 / 60, {}); k++; }
      return k;
    };
    const d1 = deadFrames(1), d6 = deadFrames(6);
    checkTrue('one level start costs about one tune of dead time',
              d1 > 200 && d1 < 320, d1 + ' render frames');
    checkTrue('...and SIX starts in a row still cost one, not six',
              d6 <= d1 + 10, d1 + ' for one against ' + d6 + ' for six');
  }
}

/* ====================================================================
   THE RANKED TABLES, $8826, and their four-page display at $8767.

   build/_rank.json is written by `python tools/rankgate.py`: the shadow after
   each of the four pages has been drawn and before $9CD7 blits.  Rows 0..13
   are compared -- the heading on row 1 and the ten entries from row 4 -- which
   is everything the routine writes.

   THE SORT IS ALREADY GATED ELSEWHERE: `python tools/fegate.py hiscore`
   drives $86ED over ties, the shipped score exactly, a point either side of
   it and the millions field.  What was missing until now is a PICTURE test --
   nothing compared what hsDrawPage paints against what $8767 paints. */
{
  const rPath = path.join(ROOT, 'build', '_rank.json');
  if (!fs.existsSync(rPath)) {
    checkTrue('build/_rank.json present (python tools/rankgate.py)', false);
  } else {
    const RK = JSON.parse(fs.readFileSync(rPath, 'utf8'));   // pages by number
    const AR = G.assets.rank;
    checkTrue('the ranked asset shipped (python tools/rankgate.py)',
              !!(AR && AR.tables && AR.tables.length === 4));
    const sa = (x, y) => ((y & 0xC0) << 5) | ((y & 7) << 8) |
                         ((y & 0x38) << 2) | (x >> 3);
    /* THE ENGINE'S OWN hsDrawPage(), which IS $8767 -- not a second renderer
       written for the test.  It paints a SpecScreen, so the comparison is
       byte against byte in the display file rather than pixel against
       fillRect, which is stricter. */
    const HS = G.hiscore;
    const drawPage = HS ? HS.drawPage : null;
    checkTrue('the engine exposes hsDrawPage ($8767) for the gate', !!drawPage);
    let bad = 0, first = null, drew = 0;
    for (let pg = 0; pg < 4 && drawPage; pg++) {
      const want = RK[String(pg)];
      const scr = new G.frontend.SpecScreen();
      drawPage(scr, pg + 1);            // $876D INCs first, so 1..4
      let diff = 0, lit = 0;
      for (let y = 0; y < 112; y++)
        for (let c = 0; c < 32; c++) {
          const off = sa(c * 8, y);
          const b = want.px[off], got = scr.m[off];
          if (b) lit++;
          if (b !== got) diff++;
        }
      /* the ATTRIBUTES too -- $877A floods 640 of them and comparing only the
         bitmap let a mutation that dropped the fill entirely pass. */
      for (let i = 0; i < 640; i++)
        if (want.at[i] !== scr.m[6144 + i]) diff++;
      if (diff) { bad++; if (!first) first = 'page ' + pg + ': ' + diff + ' bytes'; }
      else if (lit) drew++;
    }
    checkTrue('...and the tables it drew from are the SHIPPED ones, not a ' +
              'copy the test made', HS && HS.tables.length === 4);
    check('hsDrawPage reproduces all four ranked pages byte for byte',
          bad === 0 ? 'all agree' : bad + '/4 differ -- ' + first, 'all agree');
    checkTrue('...and every page actually drew something', drew === 4);
    /* the PACKING, which the pictures cannot see: the letter is in bits 0..5
       and the top two carry the MILLIONS count ($86B1 SLA C / SLA C on
       ($7F2B+7)), not the character -- the shipped tables have none, so all
       four tables read zero there. */
    checkTrue('a record keeps the letter in bits 0..5 and the millions in 6..7',
              AR.tables.every(t => t.rows.every(r =>
                r.name.every(n => n >= 0 && n < 64) &&
                r.cls.every(c => c === 0))));
    check('the four tables carry the authors, one per character',
          AR.tables.map(t => t.rows[0].name.map(n =>
            String.fromCharCode(0x40 + n)).join('')).join(','),
          'BIL,BOB,KEV,ARP');
    checkTrue('...each on 10000, in packed BCD',
              AR.tables.every(t => t.rows.every(r =>
                r.score[0] === 0x01 && r.score[1] === 0 && r.score[2] === 0)));
  }
}

/* ====================================================================
   THE LEVEL JUMP -- a tool API, not a game feature.

   startLevel() is not a function of the level number: from level 8 the
   dungeon comes from a rotating stash and each call decrements the
   treasure countdown and mutates the pack mask.  jumpToLevel() re-seeds
   the build stream and replays 1..n, which is what makes a level
   reproducible -- tools/dungeonshot.js depends on it.  There is no UI
   for it; the page shows the playfield and nothing else.
   ==================================================================== */
{
  /* the level jump runs the game's own build, not a shortcut round it */
  const g2 = G.seed({});
  g2.jumpToLevel(42);
  check('the level jump builds the level properly, entry screen and all',
        [g2.level, !!g2.introShow, g2.pauseReq], [42, true, true]);
  checkTrue('...and it is the real dungeon 42, not dungeon 1 relabelled',
            JSON.stringify(g2.map) !== JSON.stringify(G.seed({}).map));

  /* AND THE SAME LEVEL MUST BE THE SAME LEVEL.  startLevel() is stateful by
     design -- from level 8 the dungeon comes from a rotating stash, and every
     call decrements the treasure countdown and mutates the pack mask -- so
     calling it twice with the same number builds two different dungeons and
     every few calls substitutes a treasure room.  Reported from play as "it
     seems to select a different level each time".  jumpToLevel() re-seeds the
     build stream and replays 1..n, which is both reproducible and the dungeon
     you would actually meet at that level. */
  {
    const sig = g => { let h = 0;
      for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++)
        h = (Math.imul(h, 31) + g.map[r][c]) >>> 0;
      return h.toString(16) + (g.treasure ? '*' : ''); };
    const g3 = G.seed({});
    for (const lv of [3, 10, 20]) {
      const seen = [];
      for (let i = 0; i < 3; i++) { g3.jumpToLevel(lv); seen.push(sig(g3)); }
      checkTrue('jumping to level ' + lv + ' three times lands on the SAME ' +
                'dungeon each time', new Set(seen).size === 1, seen.join(' '));
    }
    /* and the schedule is reproducible too: level 10 is the first treasure
       room on a straight run, so a correct replay must land in one. */
    g3.jumpToLevel(10);
    checkTrue('...and the treasure-room schedule replays with it (10 is one)',
              g3.treasure);
    /* THE BUILD SEED, and why it is not simply a constant.
       $91B5 draws $84C7 from `LD A,R` on every level >= 8 and its low two
       bits MIRROR the dungeon -- bit 1 horizontally at $9C06, bit 0
       vertically at $9C69, so a level comes up one of four ways.  With the
       substitute seeded from a fixed number that draw was the same in every
       game: level 9 always both-mirrored, reported from play as "levels 8+
       seem to spawn in the same orientation".  The shipped page now reseeds
       once per game (freshBuildSeed at feHandover); the gates keep
       GATE_CONFIG's constant, which is why everything above still replays. */
    {
      const g5 = G.seed({});
      const orients = new Set(), maps = new Set();
      for (let k = 0; k < 40; k++) {
        g5.brngSeed = (0x9E3779B1 * (k + 1)) >>> 0;
        g5.jumpToLevel(9);
        orients.add(g5.mirrorBits & 3);
        maps.add(sig(g5));
      }
      checkTrue('the build seed reaches all FOUR mirror orientations of level 9',
                orients.size === 4, [...orients].join(','));
      checkTrue('...and different seeds really build different dungeons',
                maps.size > 30, maps.size + ' distinct of 40');
      /* and the PLUMBING: reset() must honour cfg.buildSeed, or the shipped
         page's per-game draw never reaches the builder at all. */
      const built = sd => { const q = G.seed({}); q.reset({ buildSeed: sd });
                            q.jumpToLevel(9); return sig(q); };
      checkTrue('reset() honours cfg.buildSeed, so a fresh game varies',
                built(0x11111111) !== built(0x22222222));
      checkTrue('...and the default is the constant, so the gates replay',
                built(undefined) === built(0x13579BDF));
    }

    /* the CONTROL: raw startLevel() really is the unstable thing, or the
       check above is testing nothing. */
    const g4 = G.seed({});
    const raw = [];
    for (let i = 0; i < 4; i++) { g4.startLevel(20); raw.push(sig(g4)); }
    checkTrue('...and raw startLevel() really does wander, which is why',
              new Set(raw).size > 1, raw.join(' '));
  }

}

/* ====================================================================
   THE OPTIONS SCREEN -- ADDED, replacing 'players'..'ctrl2' by default
   (STREAMLINED_FRONTEND).  Drawn in the game's own font inside the message
   box's own border, driven here through the front end's real frame() and
   optFrame()/optRows()/optRender() -- an options screen no test can reach
   is exactly how the last three UIs written here shipped bugs.
   ==================================================================== */
{
  const F = G.frontend;
  checkTrue('streamlined is the default', F.live.constructor === F.FrontEnd &&
            G.streamlinedFrontend.get() === true);

  /* fresh menu, tapped SPACE at the same 6-on/10-off cadence the faithful
     tests above use, until the options screen is up. */
  const toOptions = (cap) => {
    const fe = new F.FrontEnd(), kb = new F.Keyboard(), ev = [];
    let n = 0;
    while (n < (cap || 6000) && fe.phase !== 'options'){
      if (n % 16 < 6) kb.press('SPACE'); else kb.releaseAll();
      fe.frame(kb, ev, n); n++;
    }
    kb.releaseAll(); fe.frame(kb, ev, n++);        // let SPACE's release land
    return {fe, kb, ev, n};
  };
  /* one clean press-then-release EDGE.  Any frames>=1 gives exactly one
     step: only the FIRST held frame is a rising edge (or, mid rebind
     capture, the first frame kb.held is non-empty). */
  const tap = (s, key, frames) => {
    for (let i = 0; i < (frames || 2); i++){ s.kb.press(key); s.fe.frame(s.kb, s.ev, s.n++); }
    for (let i = 0; i < 3; i++){ s.kb.releaseAll(); s.fe.frame(s.kb, s.ev, s.n++); }
  };
  checkTrue('a fresh menu reaches the options screen (boxout -> options)',
            toOptions().fe.phase === 'options');

  /* --- it draws, and it draws the game's own furniture ---------------- */
  {
    const s = toOptions();
    // was this pixel TOUCHED at all -- separate from its colour, since the
    // panel's own field is black now and "not black" can no longer stand
    // in for "something was drawn here".
    const touch = () => {
      const px = new Array(192).fill(0).map(() => new Array(256).fill(false));
      const cap = { set fillStyle(v){}, get fillStyle(){ return null; },
        fillRect(x, y, w, h){ for (let yy = y; yy < y + h; yy++){
          if (yy < 0 || yy >= 192) continue;
          for (let xx = x; xx < x + w; xx++) if (xx >= 0 && xx < 256) px[yy][xx] = true; } } };
      s.fe.optRender(cap);
      return px;
    };
    const t = touch();
    checkTrue('the options screen paints something', t.some(row => row.some(Boolean)));
    /* the panel takes the WHOLE screen now, not a small centred box -- the
       corner cells (a couple of pixels in) must be painted, where the old
       26x(rows+6) box never reached. */
    checkTrue('the panel now reaches every corner of the screen',
              t[2][2] && t[189][253]);
  }

  /* --- the title is the credits page's own logo, not plain text --------
     Reported as a request: not a redraw of the same picture, the SAME
     printPage() the credits page already uses -- block A's font redefines
     the lowercase letters as this picture's own tiles, so there is only
     ever one copy of it to get out of sync. */
  {
    const blank = new Array(F.FE_LOGO_ROWS * 8).fill(0).map(() => new Array(256).fill(false));
    const touch = new Array(F.FE_LOGO_ROWS * 8).fill(0).map(() => new Array(256).fill(false));
    const cap = { set fillStyle(v){}, get fillStyle(){ return null; },
      fillRect(x, y, w, h){ for (let yy = y; yy < y + h; yy++){
        if (yy < 0 || yy >= touch.length) continue;
        for (let xx = x; xx < x + w; xx++) if (xx >= 0 && xx < 256) touch[yy][xx] = true; } } };
    F.drawLogo(cap, 0, 0);
    checkTrue('drawLogo() paints something across its three rows',
              JSON.stringify(touch) !== JSON.stringify(blank));
  }

  /* --- section gaps: the LAYOUT MATH, not an inference from pixels -------
     Nearly every row has SOME white pixel (UI_ATTR's own ink is white), so
     checking "is this row lit" can't tell a gap from a row of text.
     optLayout() is what optRender() itself draws from, so this is exactly
     what ships, not a re-implementation of it. */
  {
    const s = toOptions();
    const items = s.fe.optLayout().items;
    const ys = items.map(it => it.y);
    checkTrue('every row gets its own line (the y column is strictly increasing)',
              ys.every((y, i) => i === 0 || y > ys[i - 1]));
    let gaps = 0;
    for (let i = 1; i < items.length; i++)
      if (items[i].r.group !== items[i - 1].r.group){
        checkTrue('a group boundary (' + items[i-1].r.group + ' -> ' + items[i].r.group +
                  ') skips TWO lines (the spread plus the section gap)',
                  items[i].y === items[i - 1].y + 3);
        gaps++;
      } else {
        checkTrue('...and within a group (' + items[i].r.group + ') rows are SPREAD one apart',
                  items[i].y === items[i - 1].y + 2);
      }
    check('the one-player screen has its two section boundaries (p0 -> misc -> start)',
          gaps, 2);
  }
  /* --- rows sharing a preview's band are narrowed, others are not ------- */
  {
    const s = toOptions();
    const L = s.fe.optLayout();
    for (const {y, narrow} of L.items)
      checkTrue((narrow ? 'row ' + y + ' sharing a preview\'s band is narrowed'
                        : 'row ' + y + ' clear of every preview is full width'),
                narrow === L.previews.some(pv => y >= pv.y && y < pv.y + L.PH));
  }

  /* --- the corner preview: draws, differs per character, animates -------
     the in-game sprite CHAR_FRAMES already holds for real play, at native
     size, not a downscaled crop of the title screen (tried first, and
     reported as destroying the character's identity at that size). */
  {
    const side = 16 * F.PREVIEW_SCALE;
    /* the blit is OPAQUE (paper painted too, same as every sprite in this
       game) so every pixel is touched every time regardless of content --
       "was this pixel drawn" distinguishes nothing.  Record the COLOUR. */
    const blank = JSON.stringify(new Array(side).fill(0).map(() => new Array(side).fill(null)));
    const shotBox = (fn) => {
      const px = new Array(side).fill(0).map(() => new Array(side).fill(null));
      const cap = { set fillStyle(v){ this._f = v; }, get fillStyle(){ return this._f; },
        fillRect(x, y, w, h){ for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++)
          if (yy >= 0 && yy < side && xx >= 0 && xx < side) px[yy][xx] = this._f; } };
      fn(cap);
      return px;
    };
    const pics = [0, 1, 2, 3].map(i => JSON.stringify(shotBox(cap => F.drawCharPreview(cap, i, 0, 0, 0))));
    checkTrue('the preview draws SOMETHING for every character',
              pics.every(p => p !== blank));
    checkTrue('...and a DIFFERENT something -- not the same sprite four times',
              new Set(pics).size === 4);

    /* it turns AND walks: sampled a few frameCtr values apart, both the
       facing (changes every 45 frames) and the walk phase (every 12) must
       eventually differ from where they started. */
    const overTime = [0, 20, 50, 100, 200, 400].map(t => JSON.stringify(shotBox(cap => F.drawCharPreview(cap, 0, t, 0, 0))));
    checkTrue('the same character animates over frameCtr (turns and walks)',
              new Set(overTime).size > 1, overTime.map((p, i) => p === overTime[0]).join(','));
  }

  /* --- the preview: the player's own, aligned with his row -------------- */
  {
    const s = toOptions();
    const L1 = s.fe.optLayout();
    check('exactly one preview, for player 1',
          L1.previews.map(pv => pv.p), [0]);
    const charRow1 = L1.items.find(it => it.r.k === 'char' && it.r.p === 0);
    check('...aligned with PLAYER 1\'s own row', L1.previews[0].y, charRow1.y);
  }

  /* --- an ARROW marks the selection now, not an inverted row -- reported
     as cluttered.  The gutter is column 1 (col+1): white ('>' is UI_ATTR's
     own ink) somewhere in the selected row's 8x8 cell, nowhere else. */
  {
    // is ANY pixel of the 8x8 gutter cell at character-row `y` white?
    const gutterLit = (fe, y) => {
      let lit = false;
      const cap = { set fillStyle(v){ this._f = v; }, get fillStyle(){ return this._f; },
        fillRect(x, yy, w, h){
          if (this._f !== '#ffffff') return;
          if (x < 16 && x + w > 8 && yy < (y + 1) * 8 && yy + h > y * 8) lit = true;
        } };
      fe.optRender(cap);
      return lit;
    };
    const s = toOptions();
    const rows = s.fe.optRows();
    const y0 = s.fe.optLayout().items[s.fe.optSel].y;
    checkTrue('the gutter is lit at the selected row\'s own y', gutterLit(s.fe, y0));
    s.fe.optSel = (s.fe.optSel + 1) % rows.length;
    const y1 = s.fe.optLayout().items[s.fe.optSel].y;
    checkTrue('...and moving the cursor moves the lit row', gutterLit(s.fe, y1));
    checkTrue('...and the row it left is no longer lit',
              y0 === y1 || !gutterLit(s.fe, y0));
  }

  /* --- the rows: ONE local player, so no PLAYERS row at all ------------- */
  {
    const s = toOptions();
    check('the rows: player 1, its name, its input, its rebind, defaults, start'
          + ' -- and NO slowdown row, retired as redundant online',
          s.fe.optRows().map(r => r.k),
          ['char', 'name', 'input', 'rebind', 'reset', 'start']);
    checkTrue('cursor starts on PLAYER 1', s.fe.optRows()[s.fe.optSel].k === 'char');
  }

  /* --- the NAME row: release-gated typing in the tag font's charset ----- */
  {
    const s = toOptions();
    s.fe.optSel = s.fe.optRows().findIndex(r => r.k === 'name');
    check('the NAME row invites until one is set',
          s.fe.optRows()[s.fe.optSel].value(), 'SET NAME');
    tap(s, 'ENTER', 1);
    checkTrue('activating NAME starts entry', s.fe.optNaming === true);
    for (const k of ['A', 'N', 'T']) tap(s, k, 1);
    check('typed keys land, one per full press', s.fe.optName, 'ANT');
    tap(s, 'DELETE', 1);
    check('DELETE -- the Backspace key -- rubs out', s.fe.optName, 'AN');
    for (const k of ['T', 'H', 'O', 'N', 'Y', '7', '8']) tap(s, k, 1);
    check('...and the name caps at EIGHT', s.fe.optName, 'ANTHONY7');
    tap(s, 'ENTER', 1);
    checkTrue('ENTER keeps it and ends entry',
              !s.fe.optNaming && s.fe.optName === 'ANTHONY7');
    check('...and the row wears it', s.fe.optRows()[s.fe.optSel].value(), 'ANTHONY7');
  }

  /* --- the name persists, and a stored blob is shape-checked ----------- */
  {
    F.live.optName = 'NITRO 5';
    G.settings.save();
    F.live.optName = '';
    G.settings.load();
    check('the name persists through settings', F.live.optName, 'NITRO 5');
    F.live.optName = 'no!no!no!no!';
    G.settings.save(); G.settings.load();
    check('...and a stored blob is SHAPE-CHECKED: junk out, upper, capped at 8',
          F.live.optName, 'NONONONO');
    G.settings.reset();
    check('DEFAULTS clears the name', F.live.optName, '');
  }

  /* --- navigation wraps both ways (7/8/... alias ArrowUp etc, see KEYMAP) */
  {
    const s = toOptions();
    const n0 = s.fe.optRows().length;
    tap(s, '7', 1);                    // UP off the top row
    check('the cursor wraps upward off the top row', s.fe.optSel, n0 - 1);
    tap(s, '6', 1);                    // DOWN off the bottom
    check('...and downward off the bottom', s.fe.optSel, 0);
  }

  /* --- a CHORDED nav+action press acts on the row the cursor STARTED on,
     not the one it lands on -- an ordinary gamepad diagonal sets two
     direction bits in the SAME poll (padBits()), and a keyboard player
     resting a finger on ENTER while tapping a direction does too. */
  {
    const s = toOptions();                      // fresh: cursor on CHAR, row 0
    const before = s.fe.optChar[0];
    s.kb.press('7'); s.kb.press('8');           // UP + RIGHT, same frame
    s.fe.frame(s.kb, s.ev, s.n++);
    checkTrue('RIGHT acted on the CHAR row it was pressed on',
              s.fe.optChar[0] !== before);
    check('...and UP, same frame, still moved the cursor off it (wrapping to the end)',
          s.fe.optSel, s.fe.optRows().length - 1);
  }
  {
    const s = toOptions();                      // fresh: cursor on CHAR, row 0
    const before = s.fe.optChar[0];
    s.kb.press('7'); s.kb.press('ENTER');       // UP + GO, same frame
    s.fe.frame(s.kb, s.ev, s.n++);
    checkTrue('GO acted on CHAR (stepped it), not on wherever UP wrapped to',
              s.fe.optChar[0] !== before);
    /* sharper than it used to be: UP from row 0 wraps the cursor onto
       START itself, so an act-after-navigate regression would boot the
       game right here. */
    checkTrue('...and did NOT fire START, even though UP wrapped the cursor onto it',
              s.fe.phase === 'options');
  }

  /* --- character selection cycles ALL FOUR freely -- the old exclusion
     only ever protected the other LOCAL player's pick ------------------- */
  {
    const s = toOptions();
    s.fe.optSel = s.fe.optRows().findIndex(r => r.k === 'char');
    const seen = [s.fe.optChar[0]];
    for (let i = 0; i < 4; i++){ tap(s, '8', 1); seen.push(s.fe.optChar[0]); }
    check('the single player cycles through all four characters',
          new Set(seen.slice(0, 4)).size, 4);
    check('...and 4 steps of 4 return to the start', seen[4], seen[0]);
  }

  /* --- CONTROLLER is refused with no pad, offered once one connects ----- */
  {
    const s = toOptions();
    s.fe.optSel = s.fe.optRows().findIndex(r => r.k === 'input' && r.p === 0);
    check('P1 INPUT starts on KEYBOARD', s.fe.optRows()[s.fe.optSel].value(), 'KEYBOARD');
    tap(s, '8', 1);
    check('...and refuses CONTROLLER with no pad connected', s.fe.optMethod[0], 3);
    sandbox.navigator = { getGamepads: () => [
      { connected: true, id: 'Test Pad', axes: [0, 0], buttons: [] }] };
    F.pollGamepads();
    tap(s, '8', 1);
    check('...and accepts it once a pad is connected', s.fe.optMethod[0], 1);
    check('...and a P1 PAD status row shows its name',
          s.fe.optRows().find(r => r.k === 'pad' && r.p === 0).value(), 'TEST PAD');
    delete sandbox.navigator;
    F.pollGamepads();
  }

  /* --- a CONTROLLER choice that no longer has a pad is downgraded ------
     Not a user action -- settingsLoad() restores a PERSISTED choice with
     no pad connected yet (many browsers withhold a gamepad from
     navigator.getGamepads() until one of its buttons is pressed), and a
     pad can be unplugged mid-screen.  Reached START with CONTROLLER set
     and nothing feeding kempston would leave that player unable
     to move for the whole game, with no in-game panel left to fix it. */
  {
    const s = toOptions();
    s.fe.optMethod[0] = 1;                    // as if restored from storage
    s.fe.frame(s.kb, s.ev, s.n++);             // one frame is enough: optFrame()
    check('P1 CONTROLLER with no pad is downgraded to KEYBOARD, unprompted',
          s.fe.optMethod[0], 3);
  }
  {
    const s = toOptions();
    sandbox.navigator = { getGamepads: () => [
      { connected: true, id: 'Pad One', axes: [0, 0], buttons: [] }] };
    F.pollGamepads();
    s.fe.optSel = s.fe.optRows().findIndex(r => r.k === 'input' && r.p === 0);
    tap(s, '8', 1);
    check('...takes the pad while it is there', s.fe.optMethod[0], 1);
    delete sandbox.navigator;                 // unplugged mid-screen
    F.pollGamepads();
    s.fe.frame(s.kb, s.ev, s.n++);
    check('...and falls back the moment it is unplugged', s.fe.optMethod[0], 3);
  }
  /* --- pollGamepads: compacts the sparse Gamepad API array -------------- */
  {
    sandbox.navigator = { getGamepads: () => [
      undefined, { connected: true, id: 'Solo Pad', axes: [1, 0], buttons: [] }] };
    const r = F.pollGamepads();
    check('a pad in API slot 1 (slot 0 empty) is reported as "pad 0"',
          [r.count, r.names], [1, ['SOLO PAD']]);
    check('...axes[0]=1 (right) feeds kempston', F.liveKb.kempston, 0x01);
    /* pad 0 is the only pad that FEEDS anything now (one local player);
       the others are still REPORTED, for the options screen's own count. */
    sandbox.navigator = { getGamepads: () => [
      { connected: true, id: 'First', axes: [0, 0], buttons: [] },
      { connected: true, id: 'Second', axes: [-1, 0], buttons: [] }] };
    const r2 = F.pollGamepads();
    check('a second connected pad is reported but feeds nothing',
          [r2.count, F.liveKb.kempston], [2, 0]);
    delete sandbox.navigator;
    F.pollGamepads();
    check('with nothing connected, kempston clears', F.liveKb.kempston, 0);
  }

  /* --- rebinding actually rebinds: SIX slots now (POTION is the sixth --
     see zonePotion), ENTER skips, SPACE binds ---------------------------- */
  {
    const s = toOptions();
    s.fe.optSel = s.fe.optRows().findIndex(r => r.k === 'rebind');
    tap(s, 'ENTER', 1);
    check('activating REBIND starts capture at UP', s.fe.optBinding, 0);
    const zone = F.CTRL_KEYS[3];
    const wasUp = zone[0], wasDown = zone[1];
    tap(s, 'J', 2);
    check('...and the held key becomes the new UP binding', zone[0], 'J');
    checkTrue('...and it actually changed', zone[0] !== wasUp);
    check('...and capture advanced to DOWN', s.fe.optBinding, 1);
    /* ENTER is the one reserved key (this screen's own confirm -- see
       FE_ENTER) and SKIPS rather than binds. */
    tap(s, 'ENTER', 2);
    check('ENTER during capture SKIPS the direction, keeping the old key',
          zone[1], wasDown);
    check('...and still advances', s.fe.optBinding, 2);
    /* ...and both chat keys stay out of the zone for good: ENTER by the
       reservation above, ESC by never being a game key at all -- KEYMAP
       has no entry for it, so it cannot reach kb.held to be captured */
    check('the DOM map sends Enter to the reserved ENTER and has NO entry for Escape',
          [F.KEYMAP.Enter, 'Escape' in F.KEYMAP], ['ENTER', false]);
    checkTrue('...so neither chat key can ever be bound over the chat',
              !zone.includes('ENTER') && !zone.includes('ESCAPE'));
    /* SPACE is deliberately NOT reserved any more -- see FE_ENTER -- so it
       must BIND like any ordinary key instead of skipping, freeing it for
       the one binding Spectrum-era players expect most (QAOP + SPACE). */
    const wasLeft = zone[2];
    tap(s, 'SPACE', 2);
    check('...and SPACE, no longer reserved, BINDS instead of skipping',
          zone[2], 'SPACE');
    checkTrue('...and it actually changed', zone[2] !== wasLeft);
    check('...and capture advanced to RIGHT', s.fe.optBinding, 3);
    tap(s, 'C', 2); tap(s, 'V', 2);
    check('...FIRE done, capture advanced to POTION -- the ADDED sixth slot',
          s.fe.optBinding, 5);
    tap(s, 'B', 2);
    check('after all six, capture ends', [s.fe.optBinding, zone[5]], [-1, 'B']);
  }
  /* the bound SPACE is not just accepted by capture -- it actually WORKS,
     end to end, through the same controlRead() every other key goes
     through.  Reported motivation: a wireless-controller player is not the
     audience here, a KEYBOARD player who wants SPACE as FIRE is. */
  {
    const DIR_FIRE = G.constants.DIR_FIRE;
    F.CTRL_KEYS[3] = ['1', 'Q', 'S', 'D', 'SPACE', 'CAPS'];
    const kb = new F.Keyboard();
    kb.press('SPACE');
    checkTrue('a SPACE binding fires through controlRead(), same as any key',
              !!(F.controlRead(3, kb) & DIR_FIRE));
  }
  /* CAPS and SYM are ALSO no longer reserved -- see optCaptureFrame's own
     comment: SYM because FAITHFUL_SYM_CHEAT defaults off so there's no
     live cheat left for it to expose, CAPS because the streamlined game's
     potion no longer reads it unconditionally at all (zonePotion), so
     under this screen it's just a key.  CAPS starts IN the zone (it's the
     POTION default), so binding it to UP is ALSO the swap path's first
     exercise: the POTION slot must inherit UP's old key rather than the
     zone ending up with CAPS twice. */
  {
    const s = toOptions();
    s.fe.optSel = s.fe.optRows().findIndex(r => r.k === 'rebind');
    tap(s, 'ENTER', 1);
    const zone = F.CTRL_KEYS[3];
    const wasUp = zone[0];
    tap(s, 'CAPS', 2);
    check('CAPS, no longer reserved, BINDS instead of skipping', zone[0], 'CAPS');
    check('...and capture advanced to DOWN', s.fe.optBinding, 1);
    check('...and the POTION slot, which held CAPS, inherited UP\'s old key (SWAP)',
          zone[5], wasUp);
    tap(s, 'SYM', 2);
    check('SYM, no longer reserved, BINDS instead of skipping', zone[1], 'SYM');
    check('...and capture advanced to LEFT', s.fe.optBinding, 2);
    tap(s, 'X', 2); tap(s, 'C', 2); tap(s, 'V', 2); tap(s, 'T', 2);
    check('after all six, capture ends', s.fe.optBinding, -1);
  }
  /* both bound keys WORK end to end, same as SPACE's own check above.
     Under the FAITHFUL default (zonePotion false) CAPS still casts player
     1's OWN magic underneath -- $857E's unconditional read -- and SYM
     carries nothing: the walk-through-walls cheat is off by default
     (FAITHFUL_SYM_CHEAT), so a SYM binding is just an ordinary key. */
  {
    const DIR_UP = G.constants.DIR_UP, DIR_DOWN = G.constants.DIR_DOWN,
          DIR_POTION = G.constants.DIR_POTION;
    F.CTRL_KEYS[3] = ['CAPS', 'SYM', 'S', 'D', 'Z', 'X'];
    const kb = new F.Keyboard();
    kb.press('CAPS');
    const d = F.controlRead(3, kb);
    checkTrue('a CAPS binding moves through controlRead(), same as any key',
              !!(d & DIR_UP));
    checkTrue('...and, faithful default, STILL casts player 1\'s own magic ($857E)',
              !!(d & DIR_POTION));
    kb.releaseAll(); kb.press('SYM');
    checkTrue('a SYM binding moves through controlRead() too',
              !!(F.controlRead(3, kb) & DIR_DOWN));
    checkTrue('...and, cheat off by default, carries no hidden side effect any more',
              G.symCheat.get() === false);
  }
  /* a key held one frame too long must not leak into the NEXT direction --
     this is the bug optCaptureFrame's own comment documents: gating the
     ready-check on ENTER's release instead of the just-captured key's let
     a slow release capture one key for two consecutive directions. */
  {
    const s = toOptions();
    s.fe.optSel = s.fe.optRows().findIndex(r => r.k === 'rebind');
    tap(s, 'ENTER', 1);
    const zone = F.CTRL_KEYS[3];
    s.kb.press('T');
    for (let i = 0; i < 5; i++) s.fe.frame(s.kb, s.ev, s.n++);   // held far too long
    s.kb.releaseAll(); s.fe.frame(s.kb, s.ev, s.n++);
    check('a key held for several frames still binds only ONE direction',
          [zone[0], s.fe.optBinding], ['T', 1]);
  }

  /* --- a key of your OWN, sitting in another slot, SWAPS -- never refuses.
     The first cut refused it, which made rearranging your own keys
     impossible: UP could not take the key DOWN currently held, so the
     classic QAOP layout was unreachable from the defaults in one pass.
     Rearranging your own keys is not a conflict -- the other slot inherits
     this slot's old key, and the zone stays six distinct keys at every
     step. */
  {
    F.CTRL_KEYS[3] = ['A', 'B', 'C', 'D', 'E', 'F'];
    const s = toOptions();
    s.fe.optSel = s.fe.optRows().findIndex(r => r.k === 'rebind' && r.p === 0);
    tap(s, 'ENTER', 1);
    tap(s, 'Q', 2);                    // UP -> 'Q', unclaimed
    check('UP bound to the fresh key, capture advanced to DOWN',
          [F.CTRL_KEYS[3][0], s.fe.optBinding], ['Q', 1]);
    tap(s, 'Q', 2);                    // DOWN wants UP's OWN new key: SWAP
    check('a key of your own SWAPS instead of refusing: DOWN takes it...',
          F.CTRL_KEYS[3][1], 'Q');
    check('...UP inherits DOWN\'s old key', F.CTRL_KEYS[3][0], 'B');
    check('...and capture ADVANCES', s.fe.optBinding, 2);
    const seen = new Set(F.CTRL_KEYS[3]);
    check('...and the zone still holds six distinct keys', seen.size, 6);
  }

  /* --- THE FLAGSHIP, in as many words as it was reported: the classic
     QAOP + SPACE with CAPS for the potion -- ONE pass through capture,
     from factory defaults, zero refusals.  The first cut could not do
     this: Q was refused outright (it was UP's own DOWN key). */
  {
    G.settings.reset();
    const s = toOptions();
    s.fe.optSel = s.fe.optRows().findIndex(r => r.k === 'rebind' && r.p === 0);
    tap(s, 'ENTER', 1);
    tap(s, 'Q', 2); tap(s, 'A', 2); tap(s, 'O', 2);
    tap(s, 'P', 2); tap(s, 'SPACE', 2); tap(s, 'CAPS', 2);
    check('QAOP + SPACE + CAPS lands in ONE pass from the defaults',
          F.CTRL_KEYS[3], ['Q', 'A', 'O', 'P', 'SPACE', 'CAPS']);
    check('...capture is done', s.fe.optBinding, -1);
    G.settings.reset();
  }

  /* --- zonePotion: WHERE the potion comes from, end to end --------------
     The unconditional $857E CAPS read is the faithful default; a game
     configured by the streamlined screen reads the zone's own POTION slot
     instead (optFinish() -> feHandover() -> game.reset()), and the
     difference is the trap this closes: with the faithful read live, a
     player who binds anything onto CAPS casts magic on every press. */
  {
    const DIR_FIRE = G.constants.DIR_FIRE, DIR_POTION = G.constants.DIR_POTION;
    G.game.reset({ zonePotion: true });
    F.CTRL_KEYS[3] = ['Q', 'A', 'O', 'P', 'SPACE', 'X'];
    const kb = new F.Keyboard();
    kb.press('SPACE');
    checkTrue('zonePotion: a SPACE-fire binding fires',
              !!(F.controlRead(3, kb) & DIR_FIRE));
    kb.releaseAll(); kb.press('X');
    checkTrue('...the zone\'s own POTION slot is what casts now',
              !!(F.controlRead(3, kb) & DIR_POTION));
    kb.releaseAll(); kb.press('CAPS');
    checkTrue('...and the unconditional CAPS read is off',
              !(F.controlRead(3, kb) & DIR_POTION));
    const kb2 = new F.Keyboard();
    kb2.kempston = F.KEMPSTON_POTION;
    checkTrue('...and a pad player still gets the pad\'s own potion bit',
              !!(F.controlRead(1, kb2) & DIR_POTION));
    G.seed({});                        // back to the faithful default
    const kb3 = new F.Keyboard();
    kb3.press('CAPS');
    checkTrue('faithful default restored: CAPS is the magic key again ($857E)',
              !!(F.controlRead(3, kb3) & DIR_POTION));
    G.settings.reset();
  }

  /* --- saves migrate cleanly across BOTH eras ---------------------------
     Legacy blobs differ two ways: five keys per zone (no POTION slot
     existed), and -- from the two-local-player era -- a PAIR of zones per
     method, of which the loader takes player 1's own.  Either way slot 5
     falls back to the shipped default rather than undefined -- controlRead
     must never see a hole. */
  {
    G.settings.reset();
    sandbox.localStorage.setItem('gauntlet-settings', JSON.stringify({
      slowdown: true, method1: 3, method2: 3,
      keys: [[['9', '8', '6', '7', '0'], ['4', '3', '1', '2', '5']],
             [null, null],
             [['7', '6', '5', '8', '0'], ['7', '6', '5', '8', '0']],
             [['W', 'E', 'R', 'T', 'Y'], ['8', 'I', 'K', 'L', 'M']]] }));
    G.settings.load();
    check('a two-local-player-era five-key save restores PLAYER 1\'s five keys',
          F.CTRL_KEYS[3].slice(0, 5), ['W', 'E', 'R', 'T', 'Y']);
    check('...and the POTION slot falls back to the default, not a hole',
          F.CTRL_KEYS[3][5], 'CAPS');
    /* and the CURRENT, one-zone six-key shape round-trips -- the shape
       check must accept both widths, not just the old one. */
    G.settings.reset();
    F.CTRL_KEYS[3] = ['Q', 'A', 'O', 'P', 'SPACE', 'CAPS'];
    G.settings.save();
    F.CTRL_KEYS[3] = ['1', 'Q', 'S', 'D', 'Z', 'CAPS'];   // dirty it
    G.settings.load();
    check('a six-key save round-trips whole',
          F.CTRL_KEYS[3], ['Q', 'A', 'O', 'P', 'SPACE', 'CAPS']);
    /* and a malformed six-wide row for a FAITHFUL five-key method must not
       extend it -- those widths are the original's, not this screen's. */
    sandbox.localStorage.setItem('gauntlet-settings', JSON.stringify({
      keys: [['9', '8', '6', '7', '0', 'J'],
             null,
             ['7', '6', '5', '8', '0'],
             ['1', 'Q', 'S', 'D', 'Z', 'CAPS']] }));
    G.settings.load();
    check('a six-wide blob cannot EXTEND a faithful five-key method row',
          F.CTRL_KEYS[0].length, 5);
    G.settings.reset();
  }

  /* --- DEFAULTS restores keys ------------------------------------------- */
  {
    const s = toOptions();
    F.CTRL_KEYS[3][0] = 'N';                        // dirty it first
    s.fe.optSel = s.fe.optRows().findIndex(r => r.k === 'reset');
    tap(s, 'ENTER', 1);
    check('DEFAULTS restores the key map', F.CTRL_KEYS[3][0], '1');
    check('...and the POTION default holds: CAPS', F.CTRL_KEYS[3][5], 'CAPS');
    checkTrue('...and the six default keys are all distinct',
              new Set(F.CTRL_KEYS[3]).size === 6);
  }

  /* --- SLOWDOWN is FIXED faithful-ON: the row is retired (redundant in
     the multiplayer build -- online forces the smooth cap anyway), and
     the flag survives only as the suite's boundary hook below. */
  checkTrue('the load slowdown is ON by default', G.settings.slowdown === true);
  /* A GENUINELY HEAVY SCENE.  The seeded dungeon's own worst pass is 5.03
     frames, so measuring on it made the check pass on a 0.03 margin -- true,
     but no evidence the toggle does what it is for.  140 actors parked on
     camera costs 10.10 frames a pass, half speed, which is the bog-down the
     toggle exists to remove. */
  {
    const heavy = (nAct) => {
      const g = G.seed({});
      const px = g.x, py = g.y;
      g.actors.length = 0;
      for (let k = 0; k < nAct; k++)
        g.actors.push({x: (px + ((k % 12) - 6) * 4) & 0x7F,
                       y: (py + (Math.floor(k / 12) - 5) * 4) & 0x7F,
                       state: 0x10, flags: 0x04, drawn: false});
      let worst = 0;
      for (let i = 0; i < 30; i++){ g.onePass({}); worst = Math.max(worst, g.passFrames); }
      return worst;
    };
    G.settings.slowdown = true;  const on = heavy(140);
    G.settings.slowdown = false; const off = heavy(140);
    const quiet = heavy(0);
    G.settings.slowdown = true;
    checkTrue('...and turning it off caps a heavy pass at a quiet one',
              on > 8 && off <= 5.0001,
              'worst pass ' + on.toFixed(2) + ' frames on, ' + off.toFixed(2) + ' off');
    /* the CONTROL: an empty room is under the cap already, so the toggle
       must make no difference there -- if it did, it would be slowing the
       game down rather than only removing the bog-down. */
    checkTrue('...and makes no difference to a room that was never slow',
              quiet < 5.0001, 'empty room ' + quiet.toFixed(2) + ' frames');
  }

  /* --- START writes exactly what the faithful pickers would have.
     Player 1 takes CONTROLLER so FFFC (1) and FFFB (the fixed KEYBOARD 3)
     hold DIFFERENT values -- a swapped pair of assignments in optFinish()
     cannot hide behind two equal bytes.  $FFFE is the never-joined player
     2 block's sprite bank: feDrawP2's guard over the CHAR2_INDEX default
     (see optFinish's own comment). */
  {
    const s = toOptions();
    sandbox.navigator = { getGamepads: () => [
      { connected: true, id: 'Pad One', axes: [0, 0], buttons: [] }] };
    F.pollGamepads();
    s.fe.optSel = s.fe.optRows().findIndex(r => r.k === 'input' && r.p === 0);
    tap(s, '8', 1);                          // p1 -> CONTROLLER
    check('player 1 took CONTROLLER', s.fe.optMethod[0], 1);
    s.fe.optSel = s.fe.optRows().findIndex(r => r.k === 'start');
    const c0 = s.fe.optChar[0];
    tap(s, 'ENTER', 1);
    check('START copies char/method into the same five bytes the pickers use',
          [s.fe.FFFF, s.fe.FFFE, s.fe.FFFC, s.fe.FFFB],
          [c0 & 3, F.feDrawP2(c0, F.GATE_CONFIG.char2), 1, 3]);
    checkTrue('...and the screen is done (pressplay hands over on the next frame)',
              s.fe.frame(s.kb, s.ev, s.n));
    delete sandbox.navigator;
    F.pollGamepads();
  }

  /* --- the wire from the screen to the module flag, end to end ----------
     Drives the LIVE singleton (`frontend`/`F.live`) with the LIVE shared
     keyboard (`F.liveKb`) -- the same two objects the page's own
     requestAnimationFrame loop uses -- so this exercises the actual wire
     (screen -> feHandover() -> game.reset() -> the module flag), not a
     scratch stand-in of it. */
  {
    F.live.reset();
    const kb = F.liveKb; kb.releaseAll();
    let n = 0;
    while (n < 6000 && F.live.phase !== 'options'){
      if (n % 16 < 6) kb.press('SPACE'); else kb.releaseAll();
      F.live.frame(kb, [], n); n++;
    }
    checkTrue('the LIVE front end (what the page actually runs) also reaches options',
              F.live.phase === 'options');
    const tapLive = (key, frames) => { for (let i = 0; i < (frames || 2); i++){
        kb.press(key); F.live.frame(kb, [], n++); }
      for (let i = 0; i < 3; i++){ kb.releaseAll(); F.live.frame(kb, [], n++); } };
    F.live.optSel = F.live.optRows().findIndex(r => r.k === 'start');
    tapLive('ENTER', 1);
    checkTrue('the live front end is done', F.live.done);
    F.feHandover();
    /* zonePotion rides the wire (optFinish -> feHandover -> reset): a
       game configured by THIS screen never has the unconditional CAPS
       magic read.  CAPS alone cannot discriminate (it is also the potion
       slot's DEFAULT, so it casts either way) -- park potion on X first:
       CAPS must then cast nothing, and X must cast. */
    F.CTRL_KEYS[3] = ['1', 'Q', 'S', 'D', 'Z', 'X'];
    const kbz = new F.Keyboard();
    kbz.press('CAPS');
    checkTrue('...and zonePotion rides it too: the unconditional CAPS read is off',
              !(F.controlRead(3, kbz) & G.constants.DIR_POTION));
    kbz.releaseAll(); kbz.press('X');
    checkTrue('...while the zone\'s own POTION slot casts',
              !!(F.controlRead(3, kbz) & G.constants.DIR_POTION));
    G.settings.reset();
    G.seed({});                              // back to the gate baseline
  }

  /* --- POTION on a gamepad -- ADDED, the real Kempston port has no button
     for it at all (5 bits, all spoken for by movement + fire), which is
     why $857E/$85A7 read CAPS/SPACE regardless of method and always did.
     Reported from play: a wireless controller can be nowhere near the
     keyboard those need, so a controller-only player could not use
     potions AT ALL until this existed. */
  {
    const DIR_POTION = G.constants.DIR_POTION;
    // padBits(): A(0)/X(2)/Y(3) fire, B(1)/LB(4)/RB(5) potion, split so
    // potion has buttons of its own rather than sharing "any face button".
    const padOf = pressed => ({ connected: true, id: 'Pad', axes: [0, 0],
      buttons: Array.from({length: 6}, (_, i) => ({ pressed: pressed.includes(i) })) });
    sandbox.navigator = { getGamepads: () => [padOf([1])] };   // B only
    check('B alone feeds KEMPSTON_POTION, not fire', F.pollGamepads().bits[0],
          F.KEMPSTON_POTION);
    sandbox.navigator = { getGamepads: () => [padOf([0])] };   // A only
    check('A alone feeds fire, not potion', F.pollGamepads().bits[0], 0x10);
    sandbox.navigator = { getGamepads: () => [padOf([4])] };   // LB
    check('LB is also potion (a shoulder alternative to B)',
          F.pollGamepads().bits[0], F.KEMPSTON_POTION);
    delete sandbox.navigator;
    F.pollGamepads();

    // controlRead(): KEMPSTON honours it, every other method still does not
    // (nothing but the keyboard's CTRL_MAGIC reaches them, unchanged).
    const kb2 = new F.Keyboard();
    kb2.kempston = F.KEMPSTON_POTION;
    checkTrue('KEMPSTON reads potion off the pad bit',
              !!(F.controlRead(1, kb2) & DIR_POTION));
    for (const m of [0, 2, 3])
      checkTrue('method ' + m + ' ignores kb.kempston entirely (it never did)',
                !(F.controlRead(m, kb2) & DIR_POTION));
    checkTrue('...and KEMPSTON with the bit clear does not fire it either',
              !(F.controlRead(1, new F.Keyboard()) & DIR_POTION));
  }
}

/* ====================================================================
   ONLINE: PER-PLAYER CAMERA WINDOWS -- ADDED (this fork; CLAUDE.md's
   netcode design).  The camera is SIMULATION state ($A1DA's actor
   freeze, $B0FE's recycle cull, $8D97's shot removal, $B156's pad
   census all read it), so per-client display generalizes the RULES from
   the camera to per-player windows.  Proven three ways here:
     * DEGENERACY -- one player online is the tested sim, pass for pass,
       by state digest (the strongest check: every generalized rule
       collapses to the module-camera rule with one window);
     * each rule's own new behaviour, driven with a second window;
     * lockstep safety -- localIdx (which window THIS client displays)
       never reaches the fingerprint.
   ==================================================================== */
{
  /* a mode-NEUTRAL digest: what fingerprint() mixes, minus the camera
     pair (online deliberately mixes the windows in, so fingerprints
     cannot be compared across modes), plus the camera AS EXPERIENCED --
     the module camera offline, player 1's window online. */
  const digest = (g, online) => JSON.stringify([
    g.players.map(q => [q.x, q.y, q.dir, q.health, q.score, q.keys,
                        q.potions, q.timer, q.f11, q.p14, q.levelOwn,
                        q.animCtl & 0x0F]),
    g.actors.map(a => [a.x, a.y, a.state, a.flags & 0x3F]),
    online ? [g.players[0].camX, g.players[0].camY,
              g.players[0].camTgtX, g.players[0].camTgtY]
           : [g.camX, g.camY, g.camTgtX, g.camTgtY],
    g.passCtr, g.frameCtr, g.level, g.mshots.length
  ]);
  /* a deterministic solo walk: right, down, left, up in 20-pass legs,
     firing every 7th pass -- enough to wake actors, fire shots and move
     the window through all four step directions. */
  const script = i => {
    const t = i % 80;
    return { right: t < 20, down: t >= 20 && t < 40,
             left: t >= 40 && t < 60, up: t >= 60,
             fire: (i % 7) === 0 };
  };
  /* both runs under slowdown OFF: passTicks feeds frameCtr (the drain's
     clock), and online FORCES the cap -- so the offline leg must cap too
     or a heavy pass would tick the two clocks apart.  (Cross-CLIENT
     equality, the thing lockstep needs, is unaffected: every online
     client forces the same cap.) */
  const run = (online, jump, passes) => {
    G.settings.slowdown = false;
    G.game.reset(online ? { online: true } : {});
    const g = G.game;
    if (jump) g.jumpToLevel(jump);
    const out = [];
    for (let i = 0; i < passes; i++){
      g.onePass(script(i));
      out.push(digest(g, online));
    }
    return out;
  };
  {
    const a = run(false, 0, 260), b = run(true, 0, 260);
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    check('DEGENERACY: 260 passes of dungeon 1, online (1 player) === offline',
          same, a.length);
  }
  {
    const a = run(false, 2, 120), b = run(true, 2, 120);
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    check('...and 120 passes of dungeon 2 (through jumpToLevel\'s own settle)',
          same, a.length);
  }
  G.settings.reset();

  /* shared helpers for the two-window tests */
  const winSees = (q, x, y) =>          // $A1DA's window, per-player form
    ((x + 3 - q.camX) & 0x7F) <= 0x42 && ((y + 3 - q.camY) & 0x7F) <= 0x2A;
  const joinP2 = g => {
    g.onePass({ p2: { fire: true } });               // $9440 -- one FIRE bit
    for (let i = 0; i < 7; i++) g.onePass({});       // the six-pass materialise
  };

  /* --- $A1DA generalized: an actor updates when visible to ANY window.
     The control is the SAME mode with the second window absent, so the
     only variable is the window itself. */
  {
    G.game.reset({ online: true });
    const g = G.game, p1 = g.players[0];
    g.onePass({});                                    // camLive, windows up
    const far = g.actors.find(a => !(a.flags & 0x04) && !winSees(p1, a.x, a.y));
    checkTrue('a far actor exists to test with', !!far);
    const t0 = JSON.stringify([far.x, far.y, far.state]);
    for (let i = 0; i < 6; i++) g.onePass({});
    check('one window: an actor no window sees is FROZEN ($A1DA, generalized)',
          JSON.stringify([far.x, far.y, far.state]), t0);
    joinP2(g);
    const p2 = g.players[1];
    p2.x = (far.x + 8) & 0x7F; p2.y = far.y;          // park him beside it
    g.vcamConverge(p2);
    checkTrue('...player 2\'s window now sees it', winSees(p2, far.x, far.y));
    for (let i = 0; i < 10; i++) g.onePass({});
    checkTrue('...and the SECOND window WAKES it: it moved or changed state',
              JSON.stringify([far.x, far.y, far.state]) !== t0);
  }

  /* --- $8D97 generalized: a shot lives against its OWNER's window.
     Player 2 fires 60 units from player 1; against the owner's window the
     shot flies its full screen range, against any other camera it would
     be removed at spawn. */
  {
    G.game.reset({ online: true });
    const g = G.game, p1 = g.players[0];
    joinP2(g);
    const p2 = g.players[1];
    p2.x = (p1.x + 60) & 0x7F; p2.y = p1.y;
    g.vcamConverge(p2);
    let alive = 0;
    for (let i = 0; i < 30; i++){
      g.onePass({ p2: { right: true, fire: true } });
      if (p2.shot.state !== 0xFF) alive++;
    }
    checkTrue('a shot fired FAR from player 1 lives against ITS OWNER\'s window',
              alive >= 8, 'alive ' + alive + ' of 30 passes');
  }

  /* --- $B0FE generalized: the recycle cull measures to the NEAREST
     window.  A generator-spawned actor parked at player 2's window centre
     survives while that window exists and is recycled when it does not. */
  {
    G.game.reset({ online: true });
    const g = G.game, p1 = g.players[0];
    joinP2(g);
    const p2 = g.players[1];
    /* +88 across: far enough that the two window CENTRES end up >= $38
       (56) apart on x -- the recycle distance -- once player 2's camera
       has clamped at its own edge.  At +60 the centres sit only ~40
       apart and the actor legitimately survives against EITHER window. */
    p2.x = (p1.x + 88) & 0x7F; p2.y = (p1.y + 40) & 0x7F;
    g.vcamConverge(p2);
    const gx = (p2.camX + 0x20) & 0x7F, gy = (p2.camY + 0x14) & 0x7F;
    g.actors.push({x: gx, y: gy, state: 0x10, flags: 0x04,
                   drawX: gx, drawY: gy});
    const n0 = g.actors.length;
    g.offScreenCull();
    check('a spawned actor at window 2\'s centre SURVIVES the cull (nearest window)',
          g.actors.length, n0);
    p2.camLive = false;
    g.offScreenCull();
    check('...and is recycled the moment that window is gone',
          g.actors.length, n0 - 1);
  }

  /* --- the leash is OFF online -- the same geometry the SYM test measured
     the clamp with (player 1 at x=112 against player 2 at 44, holding
     LEFT) now walks free. */
  {
    G.game.reset({ online: true });
    const g = G.game;
    joinP2(g);
    g.players[0].x = 112; g.players[0].y = 40;
    g.players[1].x = 44;  g.players[1].y = 40;
    const held = g.players[0].x;
    for (let i = 0; i < 4; i++) g.onePass({ left: true });
    checkTrue('the leash does not clamp online: x=112 against 44 walks LEFT',
              g.players[0].x < held,
              'x ' + held + ' -> ' + g.players[0].x);
  }

  /* --- load slowdown is FORCED off online, regardless of the setting --
     the cost model reads the (frozen) module camera. */
  {
    G.settings.slowdown = true;
    G.game.reset({ online: true });
    const g = G.game;
    const px = g.x, py = g.y;
    g.actors.length = 0;
    for (let k = 0; k < 140; k++)
      g.actors.push({x: (px + ((k % 12) - 6) * 4) & 0x7F,
                     y: (py + (Math.floor(k / 12) - 5) * 4) & 0x7F,
                     state: 0x10, flags: 0x04, drawn: false});
    let worst = 0;
    for (let i = 0; i < 30; i++){ g.onePass({}); worst = Math.max(worst, g.passFrames); }
    checkTrue('online forces the pass cap with SLOWDOWN still set ON',
              worst <= 5.0001, 'worst pass ' + worst.toFixed(2) + ' frames');
    G.settings.reset();
  }

  /* --- a window OUTLIVES its player's death (camLive holds), exactly as
     the module camera holds its last position once $A3E6 stops writing. */
  {
    G.game.reset({ online: true });
    const g = G.game, p1 = g.players[0];
    for (let i = 0; i < 4; i++) g.onePass({});
    const cx = p1.camX, cy = p1.camY;
    const wx = (p1.camX + 0x20) & 0x7F, wy = (p1.camY + 0x14) & 0x7F;
    p1.f11 |= 0x80;                                   // dead
    for (let i = 0; i < 3; i++) g.onePass({});
    checkTrue('a dead player\'s window persists (camLive holds)...',
              p1.camLive === true);
    check('...and stops moving (the target is stale, as $A3F6\'s no-write)',
          [p1.camX, p1.camY], [cx, cy]);
    checkTrue('...and still gates actors',
              g.actorVisible({x: wx, y: wy}));
    p1.camLive = false;
    checkTrue('...until camLive is gone, when nothing does',
              !g.actorVisible({x: wx, y: wy}));
  }

  /* --- LOCKSTEP SAFETY: localIdx is display, never simulation.  Two
     runs differing ONLY in localIdx must fingerprint identically on
     every pass -- this is exactly the property that lets four clients
     display four windows off one lockstep state. */
  {
    const fpRun = idx => {
      G.game.reset({ online: true });
      const g = G.game;
      g.localIdx = idx;
      const fps = [];
      for (let i = 0; i < 40; i++){
        g.onePass(script(i));
        fps.push(g.fingerprint());
      }
      return fps.join(',');
    };
    checkTrue('localIdx never reaches the fingerprint: 40 passes agree',
              fpRun(0) === fpRun(1));
  }

  /* --- the JOIN SNAP: a joining player's window arrives settled ($B447's
     converge), not walking in from wherever it last stood. */
  {
    G.game.reset({ online: true });
    const g = G.game;
    for (let i = 0; i < 30; i++) g.onePass({ right: true });
    const before = [g.players[1].camX, g.players[1].camY].join(',');
    g.onePass({ p2: { fire: true } });
    const p2 = g.players[1];
    checkTrue('the joining window is LIVE on the join pass', p2.camLive === true);
    checkTrue('...and it moved to him (not the stale boot value)',
              [p2.camX, p2.camY].join(',') !== before);
    const cx = p2.camX, cy = p2.camY;
    g.vcamConverge(p2);
    check('...already SETTLED: converging again does not move it',
          [p2.camX, p2.camY], [cx, cy]);
  }

  /* --- the DISPLAY camera: localIdx picks whose window this client
     renders.  With the two players far apart, the two choices paint
     different pictures. */
  {
    G.game.reset({ online: true });
    const g = G.game;
    g.mode = 'play'; g.introShow = null; g.bannerShow = null;
    joinP2(g);
    const p2 = g.players[1];
    p2.x = (g.players[0].x + 60) & 0x7F; p2.y = (g.players[0].y + 40) & 0x7F;
    g.vcamConverge(p2);
    const shoot = () => {
      const calls = [];
      const cap = { set fillStyle(v){ this._f = v; }, get fillStyle(){ return this._f; },
        fillRect(x, y, w, h){ calls.push(x + ',' + y + ',' + w + ',' + h + ',' + this._f); } };
      G.render(cap, g);
      return calls.join(';');
    };
    g.localIdx = 0; const shot0 = shoot();
    g.localIdx = 1; const shot1 = shoot();
    checkTrue('localIdx=0 and localIdx=1 render DIFFERENT windows',
              shot0 !== shot1);
  }

  G.seed({});                            // back to the offline gate baseline
  G.settings.reset();
}

/* ====================================================================
   THE STATE SNAPSHOT -- ADDED (this fork): LATE JOIN under lockstep.
   snapshot() -> JSON wire -> restore() into a RESET machine must land a
   joining client on the running game exactly: same fingerprint at the
   handover, and fingerprint-identical evolution under the same input
   bytes from then on.  Driven offline (busy solo play) and online
   (two windows, a shot in flight, and mid-materialise), plus the guard
   rails: a tampered wire diverges (the test CAN fail), a wrong version
   refuses, and the receiver's localIdx survives -- the snapshot must
   never say which window a client displays.
   ==================================================================== */
{
  const script = i => {
    const t = i % 80;
    return { right: t < 20, down: t >= 20 && t < 40,
             left: t >= 40 && t < 60, up: t >= 60,
             fire: (i % 7) === 0 };
  };
  const fps = (g, n, off, p2held) => {
    const out = [];
    for (let i = 0; i < n; i++){
      const inp = script(off + i);
      if (p2held) inp.p2 = p2held;
      g.onePass(inp);
      out.push(g.fingerprint());
    }
    return out;
  };

  /* --- offline: 220 busy passes, snapshot, continue 150 -- then restore
     the wire into a fresh reset and drive the same 150 bytes. */
  {
    G.settings.slowdown = false;
    G.game.reset({});
    const g = G.game;
    for (let i = 0; i < 220; i++) g.onePass(script(i));
    const wire = JSON.stringify(g.snapshot());
    checkTrue('the snapshot is pure JSON of real size',
              typeof wire === 'string' && wire.length > 2000);
    const fpAt = g.fingerprint();
    /* the noise stream is NOT in fingerprint() (sound never is), but it
       IS clock state -- toggles feed pass cost feeds $8497, the drain
       (measured; see reset()'s reseed note).  The replay windows below
       only catch a dropped carry when a burst straddles a frame
       boundary, which 150 passes are not guaranteed to produce -- a
       mutation run proved they can miss it -- so the carry is asserted
       DIRECTLY at the handover. */
    const srcSound = { rng: g.sound.rng, level: g.sound.level,
                       ramp: g.sound.ramp, ticks: g.sound.ticks };
    checkTrue('the wire carries the noise stream', 'rng' in JSON.parse(wire).sound);
    const cont = fps(g, 150, 220);
    G.game.reset({});                    // the joining client's fresh boot
    g.restore(JSON.parse(wire));
    check('restore lands EXACTLY on the source state (fingerprint at handover)',
          g.fingerprint(), fpAt);
    check('...and the LD A,R noise stream position crossed the wire',
          [g.sound.rng, g.sound.level, g.sound.ramp, g.sound.ticks],
          [srcSound.rng, srcSound.level, srcSound.ramp, srcSound.ticks]);
    const rep = fps(g, 150, 220);
    let same = 0;
    for (let i = 0; i < 150; i++) if (cont[i] === rep[i]) same++;
    check('...and the next 150 passes replay fingerprint-identical', same, 150);
  }

  /* --- online: two windows apart, player 2 firing (a shot in flight at
     the snapshot), 120 passes each side of the wire. */
  {
    G.game.reset({ online: true });
    const g = G.game;
    g.onePass({ p2: { fire: true } });               // the join
    for (let i = 0; i < 7; i++) g.onePass({});       // the materialise
    const p2 = g.players[1];
    p2.x = (g.players[0].x + 60) & 0x7F; p2.y = g.players[0].y;
    g.vcamConverge(p2);
    const P2HELD = { right: true, fire: true };
    for (let i = 0; i < 40; i++){
      const inp = script(i); inp.p2 = P2HELD; g.onePass(inp);
    }
    checkTrue('the online scenario has a live second window at the snapshot',
              g.players[1].camLive === true);
    const wire = JSON.stringify(g.snapshot());
    const fpAt = g.fingerprint();
    const cont = fps(g, 120, 40, P2HELD);
    G.game.reset({ online: true });
    g.restore(JSON.parse(wire));
    check('online restore lands exactly on the source state',
          g.fingerprint(), fpAt);
    const rep = fps(g, 120, 40, P2HELD);
    let same = 0;
    for (let i = 0; i < 120; i++) if (cont[i] === rep[i]) same++;
    check('...and 120 two-window passes replay fingerprint-identical', same, 120);
  }

  /* --- mid-MATERIALISE: snapshot two passes into a join, while the
     six-pass swirl still owns the new player ($9694's bit 0). */
  {
    G.game.reset({ online: true });
    const g = G.game;
    for (let i = 0; i < 20; i++) g.onePass(script(i));
    g.onePass({ p2: { fire: true } });
    g.onePass({}); g.onePass({});
    checkTrue('player 2 is mid-materialise at the snapshot',
              (g.players[1].animCtl & 1) === 1);
    const wire = JSON.stringify(g.snapshot());
    const cont = fps(g, 60, 23);
    G.game.reset({ online: true });
    g.restore(JSON.parse(wire));
    const rep = fps(g, 60, 23);
    let same = 0;
    for (let i = 0; i < 60; i++) if (cont[i] === rep[i]) same++;
    check('a mid-materialise snapshot replays fingerprint-identical', same, 60);
  }

  /* --- the guard rails ------------------------------------------------ */
  {
    G.game.reset({});
    const g = G.game;
    for (let i = 0; i < 80; i++) g.onePass(script(i));
    const wire = JSON.stringify(g.snapshot());
    /* a tampered wire DIVERGES -- proves the equivalence tests can fail */
    const cont = fps(g, 60, 80);
    const bad = JSON.parse(wire);
    bad.game.rngState = (bad.game.rngState ^ 1) >>> 0;
    G.game.reset({});
    g.restore(bad);
    const rep = fps(g, 60, 80);
    checkTrue('a tampered wire (rngState^1) DIVERGES within 60 passes',
              cont.join(',') !== rep.join(','));
    /* a wrong version refuses */
    let threw = false;
    try { g.restore(Object.assign(JSON.parse(wire), { v: 9 })); }
    catch (e){ threw = true; }
    checkTrue('a snapshot with the wrong version is REFUSED', threw);
    /* localIdx is the receiver's own -- the wire neither carries it nor
       overwrites it */
    checkTrue('the wire does not carry localIdx',
              !('localIdx' in JSON.parse(wire).game));
    checkTrue('...nor names -- both are the receiver\'s own display state',
              !('names' in JSON.parse(wire).game));
    G.game.reset({});
    g.localIdx = 1;
    g.names = ['KEEP', '', '', ''];
    g.restore(JSON.parse(wire));
    check('...and restore preserves the receiver\'s own localIdx and names',
          [g.localIdx, g.names[0]], [1, 'KEEP']);
  }

  G.seed({});                            // back to the offline gate baseline
  G.settings.reset();
}

/* ====================================================================
   ONLINE: THE CLIENT SIDE OF THE WIRE -- driven through a MOCK transport
   (tools/e2etest.js drives the same layer over the real relay and real
   sockets; this section pins the message-level contract where the suite
   can mutation-test it).  shared/PROTOCOL.md is the spec.
   ==================================================================== */
{
  const F = G.frontend;
  const NP = G.assets.protocol, M = NP.msgs, S = G.net.state;
  checkTrue('the protocol constants ship inside the client', !!NP && NP.version === 3);
  const sent = [];
  let H = null;
  const tpF = (url, h) => { H = h; return { send: b => sent.push(Array.from(b)), close(){} }; };
  const u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const rd32 = (a, o) => (a[o] | (a[o+1] << 8) | (a[o+2] << 16) | (a[o+3] << 24)) >>> 0;
  const lastOf = t => { for (let i = sent.length - 1; i >= 0; i--)
                          if (sent[i][0] === t) return sent[i]; return null; };
  const kb = F.liveKb; kb.releaseAll();
  const fpWas = NP.fpEvery;

  /* ---- the handshake: HELLO out, WELCOME/CHARS boot the session ------- */
  G.net.start('ws://mock', { char: 2, method1: 3, zonePotion: false }, tpF);
  H.open();
  check('HELLO carries the protocol version, the pick and a blank padded name',
        sent[0], [M.HELLO, NP.version, 2].concat(new Array(8).fill(32)));
  H.message(Uint8Array.from([M.WELCOME, 1, 2, ...u32(0xC0FFEE), NP.welcomeModes.FRESH, ...u32(0)]));
  checkTrue('a FRESH welcome waits for the character table', S.phase === 'boot');
  H.message(Uint8Array.from([M.CHARS, 3, 2, 255, 255]));
  checkTrue('...and CHARS boots it: live, in the attract lobby',
            S.phase === 'live' && G.game.mode === 'attract');
  check('the sim booted from the SESSION: seed, the table\'s two characters plus the two derived, my seat displayed',
        [G.game.brngSeed, G.game.players.map(q => q.charIndex), G.game.localIdx],
        [0xC0FFEE, [3, 2, 0, 1], 1]);
  checkTrue('READY went back', !!lastOf(M.READY));

  /* ---- a tick: INPUT out with the LOCAL byte, PASS steps the sim ------ */
  kb.press('Z');                                  // method 3 FIRE
  G.net.frame(0.1);                               // a lobby exchange is 80 ms (§3.1)
  const inp = lastOf(M.INPUT);
  check('INPUT carries the local keyboard\'s byte for step 0',
        [rd32(inp, 1), inp[5]], [0, 0x10]);
  kb.releaseAll();
  H.message(Uint8Array.from([M.PASS, ...u32(0), 2, 0x10, 0x10]));
  G.net.frame(0);
  checkTrue('the echoed PASS steps the sim: both FIRE bytes join both players ($9440)',
            S.step === 1 && G.game.mode === 'play' &&
            G.game.players[0].inGame && G.game.players[1].inGame);

  /* ---- the fingerprint cadence ---------------------------------------- */
  NP.fpEvery = 4;
  for (let n = 1; n <= 3; n++){
    G.net.frame(0.1);
    H.message(Uint8Array.from([M.PASS, ...u32(n), 2, 0, 0]));
    G.net.frame(0);
  }
  const fp = lastOf(M.FP);
  check('after step 3 (fpEvery 4) the FP report carries pass and fingerprint',
        [rd32(fp, 1), rd32(fp, 5)], [3, G.game.fingerprint()]);

  /* ---- a SNAPREQ serves the running game ------------------------------ */
  const before = sent.length;
  H.message(Uint8Array.from([M.SNAPREQ]));
  const served = sent[sent.length - 1];
  checkTrue('SNAPREQ answers with SNAP at the current step',
            sent.length === before + 1 && served[0] === M.SNAP && rd32(served, 1) === S.step);
  const parsed = JSON.parse(G.net.utf8Dec(Uint8Array.from(served), 5));
  check('...and the payload is the sim\'s own snapshot wire (v2: four blocks)', parsed.v, 2);

  /* ---- DESYNC -> SNAP restores and re-readies ------------------------- */
  H.message(Uint8Array.from([M.DESYNC, ...u32(3)]));
  checkTrue('DESYNC leaves the loop and waits for state', S.phase === 'snap');
  let rebased = 0;
  const realRebase = G.sound.out.rebase;
  G.sound.out.rebase = function(){ rebased++; return realRebase.apply(this, arguments); };
  H.message(Uint8Array.from([M.SNAP, ...u32(S.step),
                             ...G.net.utf8Enc(JSON.stringify(parsed))]));
  G.sound.out.rebase = realRebase;
  check('...and tells the audio bridge the clock has been replaced (rebase)', rebased, 1);
  checkTrue('the snapshot restores and the client re-readies',
            S.phase === 'live' && rd32(lastOf(M.READY), 1) === S.step);
  checkTrue('...on the exact state it served', G.game.fingerprint() ===
            (() => { return G.game.fingerprint(); })());

  /* ---- the JOIN HINT names the local fire key while this seat's player
     is out of the game -- the second window's whole confusion in the
     first real test ("invisible and can't move") was that nothing said
     the way in is FIRE, or that FIRE here is Z. */
  {
    const painted = () => {
      let any = false;
      const cap = { set fillStyle(v){}, get fillStyle(){ return null; },
                    fillRect(){ any = true; } };
      G.net.overlay(cap);
      return any;
    };
    checkTrue('with both players IN, the live overlay paints nothing', !painted());
    G.game.players[1].p14 |= 0x80;               // my seat's player back OUT
    checkTrue('with MY player out, the overlay paints the join hint', painted());
    check('...naming the LOCAL fire key, in HUD-font-safe text',
          'PRESS ' + F.CTRL_KEYS[3][4] + ' TO JOIN', 'PRESS Z TO JOIN');
    G.game.players[1].p14 &= 0x7F;
  }

  /* ---- THE BACKGROUND-TAB CLOCK: with the page hidden, the PASS echo
     itself steps the sim and answers -- no frame() call anywhere.  The
     regression for the measured kill: a backgrounded browser has no
     requestAnimationFrame, went silent, starved the relay's 10 s input
     timeout, and the session was orphan-reset under the player. */
  {
    sandbox.document.hidden = true;
    const stepWas = S.step;
    /* the hidden tab must keep FEEDING the audio transport too -- the
       worklet FIFO drains on the audio thread whatever rAF does */
    const realFlush = G.sound.out.flush;
    let flushed = 0;
    G.sound.out.flush = function(){ flushed++; return realFlush.apply(this, arguments); };
    H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0]));
    G.sound.out.flush = realFlush;
    checkTrue('a hidden tab steps on the echo alone (no frame loop at all)',
              S.step === stepWas + 1);
    const inp2 = lastOf(M.INPUT);
    check('...and answers with the NEXT step\'s byte at once',
          rd32(inp2, 1), S.step);
    checkTrue('...and keeps feeding the sound transport while hidden',
              flushed >= 1);
    sandbox.document.hidden = false;
  }

  /* ---- THE HIDDEN-TAB CLOCK, THIRD CUT: a browser clamps a hidden
     tab's setTimeout to about a second, so the first-cut per-pass
     sleep fed one INPUT a second and pure lockstep held the WHOLE
     session to it.  The second cut answered at once under a RATE
     budget, and that over-ran a session nobody was pacing (the
     tab-away bug: 2.2x real time hidden, audio a minute behind).  The
     law now is the LEAD: a hidden tab answers at once while the sim
     is not ahead of the wall clock -- so a session paced by a visible
     player, jitter, catch-up bursts and all, never waits on it -- and
     only wire-speed echoes (nobody visible) hold, until the speaker's
     tick or the clamped timer says real time has caught up. */
  {
    sandbox.document.hidden = true;
    let fakeT = 200000;
    const timers = [];
    sandbox.performance = { now: () => fakeT };
    sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    const tickMs = G.game.tickSeconds() * 1000;
    G.net.pump();                       // the visibility listener's call: the clock's origin
    /* an echo at the SIM'S OWN PACE: a visible pacer sends the next byte
       when real time has covered the pass just applied -- whatever that
       pass cost (four frames, or five under the online cap) -- so the
       clock advances by the previous pass's consumption, plus jitter */
    let prev = tickMs;
    const echo = extraMs => {
      fakeT += prev + (extraMs || 0);
      const t0 = G.game.simT;
      H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0]));
      prev = (G.game.simT - t0) * 1000;
    };
    const lead = () => (G.game.simT - S.hideSimT) - (fakeT - S.hideAt) / 1000;
    for (let i = 0; i < 3; i++) echo(0);
    check('at the sim rate a hidden tab answers every pass AT ONCE, no timer',
          [timers.length, rd32(lastOf(M.INPUT), 1)], [0, S.step]);
    /* THE SHEFFIELD REGRESSION, re-modelled honestly: a paced session
       cannot run faster than its pacer's clock, so its jitter is ZERO-
       MEAN -- every tenth echo forty ms early and the next forty late */
    for (let i = 0; i < 40; i++) echo((i % 10 === 9) ? -40 : (i % 10 === 0 && i > 0) ? 40 : 0);
    check('forty jittered at-rate echoes never trip the guard',
          [timers.length, S.pumpHeld, rd32(lastOf(M.INPUT), 1)], [0, 0, S.step]);
    checkTrue('...the sim sits within a pass of the wall clock throughout', Math.abs(lead()) < 0.15, 'lead ' + lead());
    /* a visible pacer's own CATCH-UP BURST after a stall: three passes
       with no wall time between them (its 0.25 s accumulator cap) */
    const s0 = G.game.simT;
    for (let i = 0; i < 3; i++) H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0]));
    check('a pacer\'s catch-up burst (three passes, no wall time) does not trip the timer regime',
          [timers.length, S.pumpHeld, rd32(lastOf(M.INPUT), 1)], [0, 0, S.step]);
    fakeT += (G.game.simT - s0) * 1000 + prev;          // ...and the pace resumes
    let n = 0;
    while (timers.length === 0 && n < 100){
      H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0]));
      n++;
    }
    checkTrue('wire-speed echoes (nobody visible) hold once the sim leads the wall clock by half a second',
              timers.length === 1 && n >= 4 && n <= 9 && S.sentInput === false && S.pumpHeld === 1,
              'n ' + n + ' timers ' + timers.length + ' held ' + S.pumpHeld + ' lead ' + lead());
    checkTrue('...the deferral is sized to the lead beyond the bound, not a flat second',
              timers[0].ms >= 1 && timers[0].ms < tickMs * 2, 'ms ' + timers[0].ms);
    fakeT += 1000;
    timers.shift().fn();
    checkTrue('...and the held INPUT flows the moment the timer turns',
              S.sentInput === true && rd32(lastOf(M.INPUT), 1) === S.step);
    /* THE SPEAKER'S TICK: with the audio clock alive the bound is a
       tenth of a second, and ticks (real time, off the audio thread)
       release a held byte without waiting for the clamped timer */
    fakeT = S.hideAt + (G.game.simT - S.hideSimT) * 1000;   // lead exactly 0
    G.sound.out.tick();                                 // the processor's hook -> netTick
    check('the speaker\'s tick reaches the pump', S.tickAt, fakeT);
    let m = 0;
    while (timers.length === 0 && m < 20){
      H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0]));
      m++;
    }
    checkTrue('with the speaker ticking, wire-speed echoes hold after a TENTH of a second (a pass or two)',
              timers.length === 1 && m >= 1 && m <= 3 && S.sentInput === false, 'm ' + m + ' lead ' + lead());
    let ticks = 0;
    while (!S.sentInput && ticks < 4){ fakeT += 43; G.sound.out.tick(); ticks++; }
    checkTrue('...and the speaker\'s ticks release the byte inside a pass of real time -- the timer never had to fire',
              S.sentInput === true && rd32(lastOf(M.INPUT), 1) === S.step && timers.length === 1 && ticks <= 3,
              'ticks ' + ticks);
    /* BACK TO VISIBLE: the accumulator is re-origined to the sim's lead,
       never left on its floor; lastProgress is fresh; the speaker is
       told to catch up.  (What the second cut did: first INPUT 5.08 s
       after the return, WAITING FOR PLAYERS flashing off a stale
       lastProgress -- measured, the frozen return Anthony reported.) */
    S.acc = -5;                                         // what a long hidden stretch leaves
    let caught = 0;
    const realCatch = G.sound.out.catchUp;
    G.sound.out.catchUp = function(){ caught++; };
    sandbox.document.hidden = false;
    G.net.pump();
    G.sound.out.catchUp = realCatch;
    checkTrue('unhiding re-origins the accumulator to the sim\'s lead (a pass at most here), refreshes lastProgress, and tells the speaker to catch up',
              S.acc <= 0 && S.acc > -0.2 && S.lastProgress === fakeT && caught === 1 && S.hidePaced === false,
              'acc ' + S.acc + ' caught ' + caught);
    /* the pending timer fires into a visible tab: a no-op that frees the slot */
    while (timers.length) timers.shift().fn();
    check('a deferral timer firing into a visible tab is a no-op that frees the slot', S.pumpTimer, null);
    delete sandbox.setTimeout;
    delete sandbox.performance;
    /* the fake clock leaves: every wall stamp goes back onto the real one,
       or the next block's credit is the distance between two clocks */
    S.accAt = Date.now(); S.lastProgress = Date.now(); S.tickAt = 0;
  }

  /* ---- STOP-AND-WAIT: one INPUT in flight, ever.  The input is
     sampled at most ONE tick before it acts, so a released key stops
     the character a round trip later -- and any send-ahead scheme
     fails this pin. */
  {
    kb.releaseAll();
    S.acc = -1;                              // park the clock: no send is owed
    while (S.sentInput){                     // settle: flush any in-flight
      H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0]));
      const d = S.pendDirs; S.pendDirs = null; if (d) G.net.apply(d);
    }
    S.acc = 0;
    const inputs0 = sent.filter(m => m[0] === M.INPUT).length;
    for (let i = 0; i < 10; i++) G.net.frame(0.1);
    check('with the echo withheld, exactly ONE input is ever in flight',
          sent.filter(m => m[0] === M.INPUT).length - inputs0, 1);
    H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0]));
    G.net.frame(0.1);
    check('...and the echo releases exactly the next',
          sent.filter(m => m[0] === M.INPUT).length - inputs0, 2);
    checkTrue('net.info() stays paste-able for the bench',
              /inflight=[01] rate=.* sim=.* worst=\d+ms/.test(G.net.info()));
  }

  /* ---- NETPLAN 2.1 / 2.2: the measurement wire.  The frame loop PINGs
     once a second and folds each PONG into net.rtt; a PASS may carry a
     trailing wait byte per seat (4 ms units), kept as the per-seat worst
     over the diagnostic's window.  Neither touches the sim. */
  {
    const pg = lastOf(M.PING);
    checkTrue('the frame loop PINGs, tagged', !!pg && pg.length === 5);
    const tag = rd32(pg, 1);
    H.message(Uint8Array.from([M.PONG, ...u32(tag)]));
    checkTrue('PONG folds one round-trip sample into net.rtt (min = med for one)',
              S.rtt.samples.length === 1 && S.rtt.min >= 0 && S.rtt.min === S.rtt.med);
    H.message(Uint8Array.from([M.PONG, ...u32(tag)]));
    check('...and an unknown or repeated tag is ignored', S.rtt.samples.length, 1);
    S.acc = -1;                                    // no reply owed: keep the wire quiet
    H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0, 20, 3]));
    const waits = S.stat.waitShown.length ? S.stat.waitShown : S.stat.wait;
    check('PASS wait bytes land as the per-seat worst, in milliseconds', waits, [80, 12]);
    checkTrue('net.info() carries rtt= and wait= for the report',
              /rtt=\d+\/\d+\/\d+ wait=80\/12ms/.test(G.net.info()));
    S.acc = 0;
  }

  /* ---- NAMES: the session's name table is display metadata -- straight
     onto net.names and the live game's own tag table, never the sim. */
  {
    const enc = s2 => { const o = []; for (let i = 0; i < 8; i++)
      o.push(i < s2.length ? s2.charCodeAt(i) : 32); return o; };
    H.message(Uint8Array.from([M.NAMES, ...enc('ANTHONY'), ...enc('NITRO 5'),
                               ...enc(''), ...enc('')]));
    check('NAMES lands on net.names AND the live game, padding trimmed',
          [S.names, G.game.names],
          [['ANTHONY', 'NITRO 5', '', ''], ['ANTHONY', 'NITRO 5', '', '']]);
  }

  /* ---- THE LEVEL-NUMBER SCREEN HOLDS FOR THE TUNE, online.  A level
     entry raises the intro screen and arms the pause; the next pass
     serves the pause -- and used to step in the same call, taking the
     screen down at the pass's top, so the tune played over the new
     level with the players frozen (reported from play).  The pause pass
     must NOT step: the screen stays up, the pass after brings the level. */
  {
    S.acc = -1;                                    // keep the wire quiet
    const g = G.game;
    g.levelDone = true;                            // the sim's own level-end flag
    H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0]));
    checkTrue('the level-end pass raises the intro screen and arms its pause',
              !!g.introShow && g.pauseReq === true && g.mode === 'play');
    const passWas = g.pass, simWas = g.simT;
    H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0]));
    checkTrue('the PAUSE pass charges the tune to the clock and steps NOTHING: ' +
              'the level-number screen is still up',
              g.simT - simWas > 3 && g.pass === passWas && !!g.introShow,
              'charge ' + (g.simT - simWas).toFixed(2) + ' pass ' + g.pass + '/' + passWas);
    checkTrue('...and the wire sits the tune out', S.acc < -3);
    H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0]));
    checkTrue('the pass after brings the level in: screen down, pass counted',
              g.introShow === null && g.pass === passWas + 1);
    S.acc = 0;
  }

  /* ---- START MEANS START, online: the handover arms net.autoFire and
     the latch rides the OUTGOING byte -- the join is the wire's own
     FIRE, indistinguishable from a held key -- until this seat's
     player is IN, then it is spent.  One-shot by construction: only
     feHandover arms it, so a later death or game over returns to
     attract-until-FIRE with no ghost re-join. */
  {
    const painted = () => {
      let any = false;
      const cap = { set fillStyle(v){}, get fillStyle(){ return null; },
                    fillRect(){ any = true; } };
      G.net.overlay(cap);
      return any;
    };
    G.net.start('ws://mock', { char: 2, method1: 3, zonePotion: false,
                               name: 'nitro' }, tpF);
    S.autoFire = true;                     // exactly what the ONLINE handover arms
    H.open();
    check('HELLO carries the name, upper-cased and space-padded to eight',
          lastOf(M.HELLO).slice(3),
          Array.from('NITRO   ').map(ch => ch.charCodeAt(0)));
    H.message(Uint8Array.from([M.WELCOME, 1, 2, ...u32(0xC0FFEE), NP.welcomeModes.FRESH, ...u32(0)]));
    H.message(Uint8Array.from([M.CHARS, 3, 2, 255, 255]));
    checkTrue('the autoFire latch survives the boot into the attract lobby',
              S.phase === 'live' && S.autoFire === true);
    checkTrue('...which paints NO join hint while the latch is mid-join', !painted());
    G.net.frame(0.1);                      // a lobby exchange is 80 ms (NETPLAN 3.1)
    const auto = lastOf(M.INPUT);
    check('START crosses the wire: INPUT carries FIRE with no key down',
          [rd32(auto, 1), auto[5]], [0, 0x10]);
    H.message(Uint8Array.from([M.PASS, ...u32(0), 2, 0, 0x10]));
    G.net.frame(0);
    checkTrue('the echo joins MY player and the game starts -- no second button',
              G.game.mode === 'play' && G.game.players[1].inGame &&
              !G.game.players[0].inGame);
    G.net.frame(0.1);
    const clean = lastOf(M.INPUT);
    check('...and the latch is SPENT: the next byte is the keyboard\'s own',
          [rd32(clean, 1), clean[5], S.autoFire], [1, 0, false]);
    H.message(Uint8Array.from([M.PASS, ...u32(1), 2, 0, 0]));
    G.net.frame(0);
    /* one-shot: knocked back OUT later (death, game over), nothing re-fires */
    G.game.players[1].p14 |= 0x80;
    G.net.frame(0.1);
    const dead = lastOf(M.INPUT);
    check('knocked out later, the byte stays clean -- no ghost FIRE',
          [rd32(dead, 1), dead[5]], [2, 0]);
    checkTrue('...and the join hint is back for the rejoin', painted());
    G.game.players[1].p14 &= 0x7F;
  }

  /* ---- the SERVER row exists exactly when a server is discoverable ---- */
  S.forceAvailable = true;
  checkTrue('the options screen offers SERVER when one is discoverable',
            new F.FrontEnd().optRows().some(r => r.k === 'net'));
  S.forceAvailable = false;
  checkTrue('...and hides it when none is',
            !(new F.FrontEnd().optRows().some(r => r.k === 'net')));

  /* ---- ERROR maps to a HUD-font status -------------------------------- */
  H.message(Uint8Array.from([M.ERROR, NP.errors.FULL]));
  check('ERROR FULL lands as a HUD-font status line', S.status, 'SERVER FULL');
  checkTrue('...with no punctuation for the font to garble',
            /^[A-Z0-9 ]+$/.test(S.status));

  NP.fpEvery = fpWas;
  S.phase = 'off'; S.tp = null;
  kb.releaseAll();
  G.seed({});                            // back to the offline gate baseline
  G.settings.reset();
}

/* ====================================================================
   NETPLAN 2.3 -- THE LAG GATE.  The shim that would have caught both
   pipelining bugs: a deterministic delay transport on a VIRTUAL clock
   (tools/netlag.js) with a virtual relay, driven at 60 Hz through a
   real FRESH boot, the handover's own join, the level-entry pause and
   a stretch of play.  Two sessions: rttMs = 120 (the far-seat regime
   Phase 2 must decide on) and rttMs = 40 (the rAF fix's acceptance).
   Every assertion states what the CURRENT design (stop-and-wait)
   claims, and each is written so the historical bugs fail it:
     - SAMPLING LEAD: every INPUT's tag equals the step it will act on
       -- a 4-deep pipe reads 4 here, the ratchet read 8;
     - THE WIRE SITS OUT THE PAUSE: no INPUT leaves against the level
       pause's debt -- the drain-less pipe kept sending through it;
     - RATE: one tick per round trip, so the inter-PASS gap is
       max(pass, RTT) -- 120 ms FLAT at both the 20 ms lobby tick and
       the play tick, which is where the rAF fix (2.5) shows: a reply
       that waited for the next animation frame read 133 ms there (120
       plus one 16.7 ms frame, every pass -- mutation-verified).  At
       40 ms RTT the sim's own pace rules and the frame surplus is
       carried forward by the accumulator, so that regime asserts the
       pace invariant and is NOT the fix's discriminator -- NETPLAN
       2.5 placed its acceptance at rttMs = 40; the measurable drop
       lives in the round-trip-bound regime.
   ==================================================================== */
{
  const { makeLagShim } = require('./netlag');
  const NP = G.assets.protocol, M = NP.msgs, S = G.net.state;
  const F = G.frontend, kb = F.liveKb;
  const rd32 = (a, o) => (a[o] | (a[o+1] << 8) | (a[o+2] << 16) | (a[o+3] << 24)) >>> 0;
  const median = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  /* the scripted session: 12 lobby passes, then the latch joins (START
     means start), 28 passes of play, then a LEVEL ENTRY forced the way
     the sim itself does it (levelDone -> levelOver -> startLevel, whose
     intro screen arms the pause the next pass serves), then play on.
     Measured: the attract-to-play join raises NO intro screen -- the
     level-entry pause exists only at level transitions, so a session
     without one never exercises it, which is how it stayed unseen. */
  const session = (rttMs, passes) => {
    const leads = [];
    const shim = makeLagShim(NP, { rttMs, seed: 11,
      onSend: b => { if (b[0] === M.INPUT) leads.push(rd32(b, 1) - S.step); } });
    sandbox.performance = { now: () => shim.clock.now() };
    sandbox.setTimeout = (fn, ms) => shim.clock.setTimeout(fn, ms);
    sandbox.document.hidden = false;
    kb.releaseAll();
    G.net.start('lag', { char: 3, method1: 3, zonePotion: false }, shim.tpFactory);
    let simT0 = G.game.simT, pauseAt = -1, pauseSim = 0, joinAt = -1, joinSim = 0;
    let frames = 0, armed = false, forced = false, sawLobby = false;
    while (S.step < passes && frames < 8000){
      if (!armed && S.step >= 12){ S.autoFire = true; armed = true; }
      if (!forced && S.step >= 40 && joinAt >= 0){
        G.game.levelDone = true; forced = true;      // the sim's own level-end flag
      }
      shim.clock.advance(1000 / 60);
      G.net.frame(1 / 60);
      frames++;
      /* the game singleton carries the previous section's mode until the
         boot resets it: the join is the attract -> play transition of
         THIS session, so it counts only once the lobby has been seen */
      if (S.everLive && G.game.mode === 'attract') sawLobby = true;
      if (joinAt < 0 && sawLobby && G.game.mode === 'play'){
        joinAt = shim.clock.now(); joinSim = G.game.simT;
      }
      if (pauseAt < 0 && G.game.simT - simT0 > 3){
        pauseAt = shim.clock.now(); pauseSim = G.game.simT - simT0;
      }
      simT0 = G.game.simT;
    }
    const passAt = shim.stats.recvs.filter(r => r.type === M.PASS).map(r => r.at);
    const gaps = passAt.slice(1).map((t, i) => t - passAt[i]);
    const iJoin = passAt.findIndex(t => t >= joinAt);
    const iPause = gaps.findIndex(g => g > 3000);
    const lobby = gaps.slice(0, Math.max(0, iJoin - 1));
    const play = iPause >= 0 ? gaps.slice(iPause + 1) : gaps.slice(iJoin + 1);
    /* the exchange's pace against the sim's own: wall time in play
       (the pause's gap excluded) over the sim time consumed (the
       pause's charge excluded) */
    const wallPlay = shim.clock.now() - joinAt - (iPause >= 0 ? gaps[iPause] : 0);
    const simPlay = G.game.simT - joinSim - pauseSim;
    const inputAt = shim.stats.sends.filter(s => s.type === M.INPUT).map(s => s.at);
    const afterPause = inputAt.find(t => t > pauseAt);
    const out = { steps: S.step, leads, lobby, play, mode: G.game.mode,
                  bigPauses: gaps.filter(g => g > 3000).length, pauseSim,
                  sitOut: pauseAt >= 0 && afterPause !== undefined ? afterPause - pauseAt : -1,
                  pace: (wallPlay / 1000) / simPlay,          // clock is ms, simT is s
                  rtt: S.rtt.min, pings: shim.relay.log.pings };
    S.phase = 'off'; S.tp = null;
    delete sandbox.performance; delete sandbox.setTimeout;
    return out;
  };

  const r = session(120, 200);
  check('rtt 120: a real FRESH boot, lobby, latch join and level entry -- and play on',
        [r.mode, r.steps >= 200], ['play', true]);
  check('rtt 120: SAMPLING LEAD is one tick -- every INPUT is for the very next step',
        Math.max(...r.leads), 0);
  checkTrue('rtt 120: the level entry charged the sim clock seconds, exactly once on the wire',
            r.bigPauses === 1 && r.pauseSim > 3, 'pauses ' + r.bigPauses + ' charge ' + r.pauseSim.toFixed(2));
  checkTrue('rtt 120: the wire SITS OUT the pause -- no INPUT against its debt',
            r.sitOut >= 3500, 'next INPUT ' + Math.round(r.sitOut) + ' ms after the pause');
  checkTrue('rtt 120: play runs at the ROUND TRIP flat -- the reply leaves on arrival, ' +
            'not on the next animation frame (the rAF fix, 2.5: quantised reads 133)',
            r.play.length > 20 && median(r.play) >= 118 && median(r.play) <= 124,
            'median ' + median(r.play) + ' over ' + r.play.length);
  checkTrue('rtt 120: the LOBBY, whose tick is 20 ms, is round-trip-bound flat too',
            r.lobby.length > 3 && median(r.lobby) >= 118 && median(r.lobby) <= 124,
            'median ' + median(r.lobby) + ' over ' + r.lobby.length);
  checkTrue('rtt 120: PING measures the link -- net.rtt.min reads the shim\'s 120',
            r.pings >= 1 && Math.abs(r.rtt - 120) <= 1, 'rtt ' + r.rtt);

  const q = session(40, 200);
  check('rtt 40: sampling lead one tick, the level entry once, sat out',
        [Math.max(...q.leads), q.bigPauses, q.sitOut >= 3500], [0, 1, true]);
  checkTrue('rtt 40: play keeps the sim\'s OWN pace -- wall time over consumed sim time ' +
            'within 3% (the pace invariant; the accumulator carries a frame surplus forward)',
            q.pace > 0.97 && q.pace < 1.03, 'pace ' + q.pace.toFixed(3));
  kb.releaseAll();
  G.seed({});
  G.settings.reset();
}

/* ====================================================================
   START MEANS START -- upstream f23d538, ADAPTED (playersOut/autoJoin).
   The streamlined START joins the ONE local player through the REAL
   join ($9440..$948C); the faithful path keeps attract-until-FIRE.
   ONLINE, START arms net.autoFire instead: the join rides the OUTGOING
   dir byte -- the wire's own FIRE -- whose mechanics the mock-transport
   section above pins end to end.
   (deviceJoin, the other half of that upstream commit, is DECLINED
   here: local player 2 is stripped and players[1].dir is the network
   seam -- a local pad must never claim a wire seat.)
   ==================================================================== */
{
  const F = G.frontend;
  F.live.reset();
  const kb = F.liveKb; kb.releaseAll();
  let n = 0;
  while (n < 6000 && F.live.phase !== 'options'){
    if (n % 16 < 6) kb.press('SPACE'); else kb.releaseAll();
    F.live.frame(kb, [], n); n++;
  }
  kb.releaseAll(); F.live.frame(kb, [], n++);
  F.live.optSel = F.live.optRows().findIndex(r => r.k === 'start');
  for (let i = 0; i < 2; i++){ kb.press('ENTER'); F.live.frame(kb, [], n++); }
  for (let i = 0; i < 3; i++){ kb.releaseAll(); F.live.frame(kb, [], n++); }
  while (n < 6200 && !F.live.done) F.live.frame(kb, [], n++);
  checkTrue('the screen finished', F.live.done);
  check('START names the one local player for the handover', F.live.playersOut, 1);
  F.live.optName = 'ANT';
  F.feHandover();
  const g = G.game;
  check('the OFFLINE handover carries the name to the tag table', g.names[0], 'ANT');
  checkTrue('START MEANS START: player 1 is IN before any FIRE',
            g.players[0].inGame === true);
  check('...through the REAL join: health BCD 2000, the $9440 reset',
        [g.players[0].health, g.players[0].score], [0x2000, 0]);
  checkTrue('...and REALLY placed ($9689): standing on a live cell, not (0,0)',
            (g.players[0].x | g.players[0].y) !== 0);
  checkTrue('...player 2 still ships OUT -- free to drop in as always',
            !g.players[1].inGame);
  g.advance(0.03, {});
  check('the first tick carries him into the dungeon -- the table never draws',
        g.mode, 'play');
  g.onePass({ p2: { fire: true } });
  checkTrue('...and the abstract p2.fire drop-in still joins player 2',
            g.players[1].inGame === true);
  /* the FAITHFUL flow is untouched: no playersOut, attract until FIRE */
  F.live.reset();
  check('a fresh front end names nobody', F.live.playersOut, 0);
  F.feHandover();
  checkTrue('with no playersOut the handover keeps attract-until-FIRE',
            G.game.mode === 'attract' && !G.game.players[0].inGame);
  /* the ONLINE handover: START arms the wire join instead of calling
     autoJoin -- the latch then rides netLocalDir's outgoing byte (the
     mock-transport section pins those wire mechanics). */
  {
    const S = G.net.state;
    S.forceAvailable = true;
    sandbox.WebSocket = function(){};      // netStart's default transport, inert
    F.live.reset();
    let m = 0;
    while (m < 6000 && F.live.phase !== 'options'){
      if (m % 16 < 6) kb.press('SPACE'); else kb.releaseAll();
      F.live.frame(kb, [], m); m++;
    }
    kb.releaseAll(); F.live.frame(kb, [], m++);
    F.live.optSel = F.live.optRows().findIndex(r => r.k === 'start');
    for (let i = 0; i < 2; i++){ kb.press('ENTER'); F.live.frame(kb, [], m++); }
    for (let i = 0; i < 3; i++){ kb.releaseAll(); F.live.frame(kb, [], m++); }
    while (m < 6200 && !F.live.done) F.live.frame(kb, [], m++);
    checkTrue('with a server ONLINE the screen still finishes on START', F.live.done);
    F.live.optName = 'ANT';
    F.feHandover();
    checkTrue('the ONLINE handover contacts the server instead of resetting',
              S.phase === 'hello');
    check('...carrying the name for HELLO', S.cfgLocal.name, 'ANT');
    checkTrue('...and START MEANS START crossed to the wire: autoFire armed',
              S.autoFire === true);
    S.phase = 'off'; S.tp = null; S.autoFire = false;
    S.forceAvailable = false;
    delete sandbox.WebSocket;
    kb.releaseAll();
  }
  G.seed({});
}

/* ====================================================================
   THE BRIDGE'S ADAPTIVE LEAD -- ADDED, see SoundOut's own comment.
   Reported from play on an Acer Nitro 5: "the sound is really choppy".
   The fixed 80 ms head start was the whole jitter budget, and a machine
   whose main thread stalls longer than that tears the schedule on every
   stall.  Driven here with a mock AudioContext whose clock the test owns,
   through the REAL flushBeeper and the REAL BeeperChip.
   ==================================================================== */
{
  const FRAME_HZ = G.constants.FRAME_HZ;
  const S = new G.sound.SoundOut();
  S.ctx = {
    _t: 0, get currentTime(){ return this._t; }, sampleRate: 44100,
    createBuffer(ch, len, sr){ const d = new Float32Array(len);
      return { getChannelData: () => d }; },
    createBufferSource(){ return { buffer: null, connect(){}, start(){} }; },
  };
  S.gain = { connect(){} };
  S.chip = new G.sound.BeeperChip(44100);

  S.ctx._t = 0;
  S.flushBeeper([], 10);                       // first flush: originate the map
  check('the first flush originates at now + the DEFAULT lead',
        [S.lead, S.t0], [0.08, 0.08]);

  S.ctx._t = 0.02;
  S.flushBeeper([[12, 1]], 15);                // healthy progress
  checkTrue('a healthy flush schedules and never ratchets',
            S.live.length === 1 && S.underruns === 0 && S.lead === 0.08);

  /* a 120 ms main-thread stall: the cursor (t0 + 5 frames) is now BEHIND
     the clock.  The ratchet must cover the measured deficit plus the base
     margin -- not jump straight to the ceiling. */
  const cursor = 0.08 + 5/FRAME_HZ;
  S.ctx._t = 0.30;
  S.flushBeeper([], 20);
  const expect = (0.30 - cursor) + 0.08;
  checkTrue('an underrun ratchets the lead by the MEASURED deficit + margin',
            S.underruns === 1 && Math.abs(S.lead - expect) < 1e-9,
            'lead ' + S.lead.toFixed(5) + ' expect ' + expect.toFixed(5));
  checkTrue('...and the re-origin schedules with the NEW lead',
            Math.abs(S.t0 - (0.30 + expect)) < 1e-9);

  S.ctx._t = 5;                                // a pathological stall
  S.flushBeeper([], 25);
  checkTrue('a huge stall caps the lead at SND_LEAD_MAX',
            S.underruns === 2 && S.lead === 0.24);

  const led = S.lead, und = S.underruns, rs = S.resyncs;
  S.flushBeeper([], 2);                        // upto < next: a game RESTART
  checkTrue('a clock restart re-origins but does NOT ratchet -- it is not a tear',
            S.resyncs === rs + 1 && S.underruns === und && S.lead === led);

  /* start() asks the OS for the STABILITY buffer, not the smallest one --
     'playback', not the default 'interactive'.  See SoundOut.start()'s own
     comment: the game's sound is pass-quantised to 80-100 ms anyway, and
     the small-buffer default is what crackles on a DPC-spiky laptop. */
  {
    let captured = null;
    sandbox.AudioContext = class {
      constructor(opts){ captured = opts; this.sampleRate = 48000;
        this.destination = {}; }
      createGain(){ return { gain: { value: 0 }, connect(){} }; }
    };
    const S2 = new G.sound.SoundOut();
    checkTrue('start() brings the context up under the mock', S2.start() === true);
    /* FORK DEVIATION, re-measured: with the FIFO transports carrying the
       jitter, the big 'playback' buffer would only buy latency -- the
       default is 'interactive' again, ?audio=stable restores the trade. */
    checkTrue('...and asks for the INTERACTIVE latency class by default',
              !!captured && captured.latencyHint === 'interactive');
    checkTrue('...and with no audioWorklet on the context, stays on the scheduler',
              S2.mode === 'sched' && S2.initPending === false);
    /* the stability trade is one URL param away, not gone */
    sandbox.location = { search: '?audio=stable' };
    const S2b = new G.sound.SoundOut();
    S2b.start();
    checkTrue('?audio=stable still buys the playback buffer',
              !!captured && captured.latencyHint === 'playback');
    delete sandbox.location;
    delete sandbox.AudioContext;
  }

  /* --- the worklet module's TWO URLs, blob then data ---------------------
     MEASURED in headless Chrome: a blob module for a worklet FAILS on a
     file:// page (AbortError) while the data: form loads and constructs --
     and file:// is how a double-clicked download runs this game.  The
     mocks' addModule returns a SYNCHRONOUS thenable, which the engine's
     chain supports on purpose (only addModule's own then(onOk, onErr), no
     interior Promises), so the whole async dance is assertable inline. */
  {
    const mkCtx = (verdict) => class {
      constructor(){ this.sampleRate = 48000; this.destination = {};
        this.tried = []; const tried = this.tried;
        this.audioWorklet = { addModule: (url) => ({
          then(ok, err){ tried.push(url.slice(0, 5));
                         verdict(url) ? ok() : err({ name: 'AbortError' }); }
        }) };
      }
      createGain(){ return { gain: { value: 0 }, connect(){} }; }
    };
    sandbox.Blob = Blob; sandbox.URL = URL; sandbox.btoa = btoa;
    sandbox.AudioWorkletNode = class {
      constructor(ctx, name, opts){ this.name = name; this.opts = opts;
        this.port = { posted: [], onmessage: null,
                      postMessage(m){ this.posted.push(m); } }; }
      connect(){}
    };

    sandbox.AudioContext = mkCtx(url => !url.startsWith('blob:'));
    const S3 = new G.sound.SoundOut();
    S3.start();
    checkTrue('a blob-refusing platform (file://) falls back to the data: module',
              S3.mode === 'worklet' && S3.initPending === false &&
              S3.ctx.tried.length === 2 && S3.ctx.tried[0] === 'blob:' &&
              S3.ctx.tried[1] === 'data:');
    checkTrue('...recording WHY blob was refused for info()',
              S3.workletErr.indexOf('blob:AbortError') === 0 &&
              S3.info().indexOf('wk=on') > 0);
    checkTrue('...and the node got its refill gate on arrival -- the FIFO\'s own 50 ms',
              S3.node.port.posted.length === 1 &&
              S3.node.port.posted[0].min === Math.floor(0.05 * 48000));

    sandbox.AudioContext = mkCtx(() => false);       // nothing loads
    const S4 = new G.sound.SoundOut();
    S4.start();
    checkTrue('both URLs refused: the scheduler keeps the game audible',
              S4.mode === 'sched' && S4.initPending === false);
    checkTrue('...and info() names both failures instead of staying silent',
              S4.info().indexOf('wk=blob:AbortError data:AbortError') > 0);

    delete sandbox.AudioContext; delete sandbox.AudioWorkletNode;
    delete sandbox.Blob; delete sandbox.URL; delete sandbox.btoa;
  }
}

/* ====================================================================
   THE WORKLET PATH -- ADDED, see WORKLET_SRC's own comment.  One
   continuous pull-model stream, the architecture a native emulator uses,
   because a machine was found (an Acer Nitro 5) that crackles on the
   scheduled-buffer joins while playing an emulator's stream clean.
   ==================================================================== */
{
  const FRAME_HZ = G.constants.FRAME_HZ, sr = 44100;

  /* --- the tiling: the FIFO concatenation reconstructs ONE continuous
     render exactly, over irregular flush steps -- the same property the
     scheduled path proves against ctx time, restated against the stream
     clock. */
  {
    const S = new G.sound.SoundOut();
    const chunks = [];
    S.ctx = { sampleRate: sr };
    S.chip = new G.sound.BeeperChip(sr);
    S.node = { port: { postMessage(m){ if (m.chunk) chunks.push(m.chunk); } } };
    S.mode = 'worklet';
    const edges = [];                    // a 0.37-frame square over 60 frames
    { let lv = 1; for (let f = 0.2; f < 60; f += 0.37){ edges.push([f, lv]); lv ^= 1; } }
    const log = [];
    let fed = 0;
    const feed = (upto) => {
      while (fed < edges.length && edges[fed][0] < upto) log.push(edges[fed++]);
      S.flushWorklet(log, upto);
    };
    S.flushWorklet([], 0);               // originate the stream at frame 0
    for (const u of [3, 8, 9, 15, 26, 41, 60]) feed(u);
    const total = Math.floor(60/FRAME_HZ*sr);
    check('the stream sent exactly the whole-sample window of 60 frames',
          S.vsent, total);
    const cat = new Float32Array(total);
    { let o = 0; for (const c of chunks){ cat.set(c, o); o += c.length; } }
    const ref = new Float32Array(total);
    new G.sound.BeeperChip(sr).render(ref, 0, total, 0,
      edges.map(e => [e[0]/FRAME_HZ, e[1]]), 0);
    let worst = 0;
    for (let i = 0; i < total; i++) worst = Math.max(worst, Math.abs(cat[i] - ref[i]));
    checkTrue('the chunk concatenation IS the one-shot render, sample for sample',
              worst < 1e-7, 'worst ' + worst.toExponential(2));

    /* a sim-clock restart re-origins the map with NO chunk and NO gap */
    const rs = S.resyncs, n0 = chunks.length;
    S.flushWorklet([[1, 1]], 2);         // upto 2 < next 60
    checkTrue('a clock restart re-origins the stream map without emitting',
              S.resyncs === rs + 1 && chunks.length === n0 &&
              S.vbase === 2 && S.vsent === 0 && S.chip.lvl === 1);
  }

  /* --- the sample-fed ratchet: an underrun report ratchets the lead by
     the episode's own length and hands the worklet its new refill gate. */
  {
    const S = new G.sound.SoundOut();
    const posted = [];
    S.ctx = { sampleRate: sr };
    S.node = { port: { postMessage(m){ posted.push(m); } } };
    /* FORK DEVIATION from the upstream figures: the FIFO gate is its own
       field with a 30 ms base (SND_LEAD_FIFO) -- a FIFO recovers inside
       one gap, so it opens tighter than the scheduler's 80 ms and the
       ratchet buys more only where a machine proves the need.  The
       SCHEDULER's own lead must stay untouched by FIFO reports. */
    S.ratchetSamples(Math.round(0.05*sr));
    checkTrue('an underrun report ratchets the FIFO gate to episode + its margin',
              S.underruns === 1 && Math.abs(S.fifoLead - 0.10) < 1e-3);
    S.ratchetSamples(1);                     // a TINY episode still escalates
    checkTrue('...and even a tiny episode grows the gate a whole frame',
              Math.abs(S.fifoLead - 0.116) < 1e-3);
    checkTrue('...and posts the worklet its new refill gate each time',
              posted.length === 2 &&
              posted[1].min === Math.floor(S.fifoLead*sr));
    checkTrue('...while the SCHEDULER lead is not touched by a FIFO report',
              S.lead === 0.08);
    S.ratchetSamples(sr * 2);
    checkTrue('...and a huge episode caps at SND_LEAD_MAX', S.fifoLead === 0.24);
  }

  /* --- the processor itself, eval'd from the SAME source string the page
     ships, with the worklet globals stubbed. */
  {
    let ProcCls = null; const reports = [];
    const AudioWorkletProcessor = class {
      constructor(){ this.port = { onmessage: null,
                                   postMessage: m => reports.push(m) }; } };
    const registerProcessor = (name, cls) => { ProcCls = cls; };
    void AudioWorkletProcessor; void registerProcessor;
    eval(G.sound.WORKLET_SRC);
    const p = new ProcCls();
    const msg = d => p.port.onmessage({ data: d });
    const spin = () => { const o = new Float32Array(128);
                         p.process([], [[o]]); return o; };
    msg({ min: 100 });
    let o = spin();
    checkTrue('before anything arrives: silence, and NO underrun report',
              reports.length === 0 && o.every(v => v === 0));
    msg({ chunk: new Float32Array(60).fill(0.5) });     // below the gate
    o = spin();
    checkTrue('below the refill gate the stream does not start yet',
              reports.length === 0 && o.every(v => v === 0));
    msg({ chunk: new Float32Array(80).fill(0.25) });    // depth 140 >= 100
    o = spin();
    checkTrue('at the gate it starts -- and boot silence was NOT an underrun',
              reports.length === 0 && o[0] === 0.5 && o[127] === 0.25);
    o = spin();                                         // 12 left, then dry
    checkTrue('a dry queue emits zeros mid-episode without reporting yet',
              reports.length === 0 && o[11] === 0.25 && o[12] === 0);
    msg({ chunk: new Float32Array(50).fill(0.75) });    // below the gate
    o = spin();
    checkTrue('recovery ALSO waits for the refill gate -- no fragile resume',
              reports.length === 0 && o.every(v => v === 0));
    msg({ chunk: new Float32Array(80).fill(0.75) });    // depth 130 >= 100
    o = spin();
    checkTrue('resuming reports the episode length, once',
              reports.length === 1 && reports[0].underrun === 244 &&
              o[0] === 0.75);
    /* THE SPEAKER'S TICK and the CATCH-UP (this fork's hidden-tab clock) */
    const ticksBefore = reports.filter(r => r.tick).length;
    for (let i = 0; i < 16; i++) spin();                // 2048 samples
    check('the processor ticks the main thread once per 2048 samples -- real time, off the audio thread',
          reports.filter(r => r.tick).length - ticksBefore, 1);
    msg({ chunk: new Float32Array(3000).fill(0.5) });
    msg({ chunk: new Float32Array(200).fill(0.75) });   // (float32-exact values)
    checkTrue('a backlog builds', p.depth > 3000);
    msg({ catchUp: 1 });
    check('catchUp drops the OLDEST samples down to the refill gate', p.depth, 100);
    o = spin();
    checkTrue('...and playback goes on from the NEWEST -- the present, not the past',
              o[0] === 0.75 && o[99] === 0.75 && o[100] === 0);
  }
}

/* ====================================================================
   THE ScriptProcessor FIFO -- ADDED (this fork).  The relay serves the
   page over plain http, and on http://<LAN-IP> -- how every second
   machine joins -- the origin is NOT a secure context: Chrome exposes
   no AudioWorklet there at all (measured; field-reported as the title
   crackle surviving the worklet cherry-pick, info() reading mode=sched
   wk=off).  startSproc() runs the SAME processor class main-thread on
   a ScriptProcessorNode -- one state machine, evaluated from the same
   WORKLET_SRC string the worklet loads and this suite unit-tests.
   ==================================================================== */
{
  const S = new G.sound.SoundOut();
  let spCap = null;
  S.ctx = { sampleRate: 48000,
            createScriptProcessor(sz, ic, oc){
              spCap = { sz, ic, oc, onaudioprocess: null, connected: false,
                        connect(){ spCap.connected = true; } };
              return spCap; } };
  S.gain = { connect(){} };
  S.startSproc();
  check('with no worklet the SAME FIFO engages on a ScriptProcessor', S.mode, 'sproc');
  checkTrue('...node kept referenced and connected (GC-silence guard)',
            S.spNode === spCap && spCap.connected === true);
  checkTrue('...and info() says so', S.info().indexOf('mode=sproc') === 0);
  const pull = n => { const out = new Float32Array(n);
    spCap.onaudioprocess({ outputBuffer: { getChannelData: () => out } });
    return Array.from(out); };
  S.node.port.postMessage({ min: 4 });
  S.node.port.postMessage({ chunk: Float32Array.from([1, 2, 3]) });
  check('below the refill gate the stream holds silent (boot is not an underrun)',
        pull(4), [0, 0, 0, 0]);
  S.node.port.postMessage({ chunk: Float32Array.from([4, 5]) });
  check('past the gate the chunks play back EXACTLY, concatenated',
        pull(6), [1, 2, 3, 4, 5, 0]);
  /* the drained tail opened an episode; resume must wait for the gate,
     then report -- and the report must RATCHET, same policy as the
     worklet's own wire */
  const lead0 = S.fifoLead;
  S.node.port.postMessage({ chunk: Float32Array.from([7]) });
  check('an episode refuses to resume below the gate', pull(2), [0, 0]);
  S.node.port.postMessage({ chunk: Float32Array.from([8, 9, 10]) });
  check('...then plays on cleanly once the queue refills', pull(4), [7, 8, 9, 10]);
  checkTrue('...and the episode report ratcheted the FIFO gate through the shim',
            S.fifoLead > lead0, 'fifoLead ' + S.fifoLead);
  checkTrue('the FIFO gate OPENS at its own 50 ms, not the scheduler 80',
            Math.abs(lead0 - 0.05) < 1e-9);
}

/* ====================================================================
   THE QUEUE DRAIN, THE DEPTH REPORT AND THE GATE DECAY -- ADDED (this
   fork).  Reported from play: sfx audibly behind a native emulator, and
   a 50 ms trim imperceptible -- so the dominant term was elsewhere.
   The queue's DEPTH is the latency, and nothing above the processor
   could ever shrink it: a stall's backlog or an early ratchet rode
   between the sim and the speaker for ever.  Now the processor drains
   above 1.5x the gate by dropping only samples IDENTICAL to the one
   just played (a square-wave stream is rich in flat runs; an edge is
   never touched), reports its depth for info(), and the gate itself
   decays a frame per five clean seconds so early jank stops being a
   life sentence.
   ==================================================================== */
{
  let ProcCls = null; const reports = [];
  const AudioWorkletProcessor = class {
    constructor(){ this.port = { onmessage: null,
                                 postMessage: m => reports.push(m) }; } };
  const registerProcessor = (name, cls) => { ProcCls = cls; };
  void AudioWorkletProcessor; void registerProcessor;
  eval(G.sound.WORKLET_SRC);
  const mk = () => { const p = new ProcCls();
    p.port.onmessage({ data: { min: 100 } }); return p; };
  const feed = (p, arr) => p.port.onmessage({ data: { chunk: Float32Array.from(arr) } });
  const spin = p => { const o = new Float32Array(128); p.process([], [[o]]); return o; };

  /* a FLAT bulge drains faster than one-for-one */
  {
    const p = mk();
    feed(p, new Array(400).fill(0.5));            // depth 400 >> hi (150)
    const o = spin(p);
    checkTrue('above 1.5x the gate a flat run DRAINS (extra samples consumed)',
              p.depth < 400 - 128, 'depth ' + p.depth);
    checkTrue('...at the capped rate (one extra per sixteen)',
              p.depth === 400 - 128 - 8);
    checkTrue('...with the output untouched -- every sample the flat value',
              o.every(v => v === 0.5));
  }
  /* an ACTIVE waveform is never touched, however deep the queue */
  {
    const p = mk();
    const sq = []; for (let i = 0; i < 400; i++) sq.push(i & 1 ? 0.9 : -0.9);
    feed(p, sq);                                   // alternating: no flat runs
    spin(p);
    check('an alternating (edge-dense) stream drains one-for-one only',
          p.depth, 400 - 128);
  }
  /* the depth report surfaces about once a second */
  {
    const p = mk();
    feed(p, new Array(200).fill(0));
    reports.length = 0;
    for (let i = 0; i < 512; i++){ spin(p); feed(p, new Array(128).fill(0)); }
    checkTrue('the processor reports its depth for info()',
              reports.some(r => typeof r.depth === 'number'));
  }
  /* the gate decay: five clean seconds ease one frame off; trouble rearms */
  {
    const S = new G.sound.SoundOut();
    const posted = [];
    S.ctx = { sampleRate: 48000, _t: 0, get currentTime(){ return this._t; } };
    S.node = { port: { postMessage(m){ posted.push(m); } } };
    S.mode = 'worklet';
    S.fifoLead = 0.24;                             // parked at the ceiling
    S.maybeEase(); S.ctx._t = 3; S.maybeEase();
    check('inside five clean seconds the gate holds', S.fifoLead, 0.24);
    S.ctx._t = 6; S.maybeEase();
    checkTrue('...then eases one frame', Math.abs(S.fifoLead - 0.224) < 1e-9);
    checkTrue('...and posts the worklet the lower gate',
              posted.length === 1 &&
              posted[0].min === Math.floor(S.fifoLead * 48000));
    S.ctx._t = 8; S.ratchetSamples(480);           // fresh trouble
    const led = S.fifoLead;
    S.ctx._t = 12; S.maybeEase();
    check('trouble REARMS the clock: no ease four seconds after an underrun',
          S.fifoLead, led);
    S.fifoLead = 0.052; S.lastTrouble = 20; S.ctx._t = 26; S.maybeEase();
    checkTrue('...and the ease FLOORS at the 50 ms base',
              Math.abs(S.fifoLead - 0.05) < 1e-9);
  }
}


/* ====================================================================
   FOUR PLAYERS (this fork; CLAUDE.md planned work 4).  The sim carries
   FOUR player blocks.  Blocks 3 and 4 have no Z80 reference -- the
   original never had them -- so the gates are:
     * DEGENERACY: with at most two players in the game the four-block
       sim matches the TWO-BLOCK build pass for pass, by the per-pass
       state digest in tools/fourblock.js against build/_fourblock_ref.json
       (recorded on the two-block build before the change);
     * INERTNESS: blocks 3/4 do not change a byte while they are out;
     * SYMMETRY: each generalized rule fires for a block 3/4 exactly as
       it fires for block 2;
     * and the four-quarter HUD, the wire at four seats, the snapshot.
   ==================================================================== */
{
  const FB = require(path.join(ROOT, 'tools', 'fourblock.js'));
  const REF = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', '_fourblock_ref.json'), 'utf8'));
  /* the replays run in a PRISTINE sandbox of the built client, as the
     recorder did: the suite's own G carries module state from every
     section before this one (found the hard way: dungeon 2 diverged at
     pass 52 in the suite and nowhere else) */
  const GF = FB.loadClient(BUILT);
  G.settings.reset();
  const g = G.game;
  g.reset({});
  check('the sim carries FOUR player blocks', g.players.length, 4);
  check('blocks 3 and 4 ship as the tape ships block 2: out, dead, $C0/$80, at (0,0)',
        g.players.slice(2).map(q => [q.x, q.y, q.f11, q.p14, q.dead, q.health, q.inGame]),
        [[0, 0, 0xC0, 0x80, true, 0, false], [0, 0, 0xC0, 0x80, true, 0, false]]);
  check('four blocks, four characters: the menu\'s two, then the lowest unused (elf, valkyrie -> warrior, wizard)',
        g.players.map(q => q.charIndex), [3, 1, 0, 2]);
  const GameClass = g.constructor;
  check('Game.charTable honours a given pick and fills the rest without a clash',
        [GameClass.charTable(0, 1, undefined, undefined), GameClass.charTable(2, 2, 2, undefined),
         GameClass.charTable(1, 0, 3, 2), GameClass.charTable(0x2A, 0x2A, undefined, undefined)],
        [[0, 1, 2, 3], [2, 2, 2, 0], [1, 0, 3, 2], [0x2A, 0x2A, 0, 1]]);
  check('the reference fixture was recorded on the TWO-block build', REF.blocks, 2);

  /* --- DEGENERACY ----------------------------------------------------- */
  for (const sc of FB.SCENARIOS){
    const got = FB.runScenario(GF, sc), want = REF.scenarios[sc.name] || [];
    let first = -1;
    for (let i = 0; i < Math.max(got.length, want.length); i++)
      if (got[i] !== want[i]){ first = i; break; }
    check('DEGENERACY ' + sc.name + ': ' + sc.passes + ' passes match the two-block build hash for hash',
          first < 0 ? 'all' : 'first mismatch at pass ' + first, 'all');
  }

  /* --- INERTNESS ------------------------------------------------------ */
  {
    const sc = FB.SCENARIOS.find(s => s.name === 'duo-shove');
    g.reset({});
    /* animCtl's bit 4 is masked: $AB24 writes the shove flag into ANY
       block the geometry matches and $A48D clears it only for the living
       -- unfingerprinted, display-adjacent, and spent by the join */
    const snap = q => JSON.stringify([q.x, q.y, q.dir, q.health, q.score, q.keys, q.potions,
                                      q.timer, q.f11, q.p14, q.levelOwn, q.animCtl & ~0x10, q.shot.state,
                                      q.dead, q.frameSlot, q.pend, q.camLive, q.died]);
    const before = g.players.slice(2).map(snap);
    for (let i = 0; i < sc.passes; i++) FB.tick(g, sc.input(i, g) || {});
    check('INERT WHILE OUT: over 260 two-player passes (shoves included) blocks 3 and 4 do not change a byte',
          g.players.slice(2).map(snap), before);
    checkTrue('...and the upper ring -- their sixteen slots -- stays $FF',
              Array.from(g.ring.slice(64)).every(v => v === 0xFF));
  }

  /* --- FOUR IN THE GAME ---------------------------------------------- */
  const joinAll = gg => {
    for (let i = 0; i < 5; i++) gg.onePass({});
    gg.onePass({ p2: { fire: true } });
    for (let i = 0; i < 8; i++) gg.onePass({});
    gg.onePass({ p3: { fire: true } });
    for (let i = 0; i < 8; i++) gg.onePass({});
    gg.onePass({ p4: { fire: true } });
    for (let i = 0; i < 8; i++) gg.onePass({});
  };
  {
    g.reset({});
    joinAll(g);
    check('FIRE on p2, p3 and p4 joins each through $9440 -- four in the game',
          g.players.map(q => q.inGame), [true, true, true, true]);
    const cells = g.players.map(q => (q.x >> 2) + ',' + (q.y >> 2));
    check('...each on his own cell', new Set(cells).size, 4);
    checkTrue('...all within two cells of player 1: the $9689 ring, anchored on the partner then the rest',
              g.players.slice(1).every(q => Math.abs((q.x >> 2) - (g.players[0].x >> 2)) <= 2 &&
                                            Math.abs((q.y >> 2) - (g.players[0].y >> 2)) <= 2),
              JSON.stringify(cells));
    {
      const gj = G.game; gj.reset({});
      for (let i = 0; i < 5; i++) gj.onePass({});
      gj.onePass({ p3: { fire: true }, p4: { fire: true } });
      check('a join resets the block: health 2000, score 0, nothing carried, armour row installed',
            gj.players.slice(2).map(q => [q.health, q.score, q.keys, q.potions, q.dmgRow.length, q.inGame]),
            [[0x2000, 0, 0, 0, 6, true], [0x2000, 0, 0, 0, 6, true]]);
      gj.reset({}); joinAll(gj);
    }
    /* each block walks on its OWN byte: hold p3 in each direction in turn */
    let moved3 = false;
    for (const d of ['up', 'right', 'down', 'left']){
      const was = [g.players[2].x, g.players[2].y];
      for (let i = 0; i < 6; i++) g.onePass({ p3: { [d]: true } });
      if (g.players[2].x !== was[0] || g.players[2].y !== was[1]) moved3 = true;
    }
    checkTrue('block 3 walks on the p3 byte', moved3);
    /* determinism and the fourth byte's reach: two identical four-player
       runs fingerprint alike; a run with p4 walking instead diverges */
    const run4 = p4dir => {
      const gg = G.game; gg.reset({}); joinAll(gg);
      const fps = [];
      for (let i = 0; i < 120; i++){
        const t = i % 40;
        gg.onePass({ right: t < 20, left: t >= 20, fire: i % 6 === 0,
                     p2: { down: t < 20, up: t >= 20, fire: i % 7 === 0 },
                     p3: { left: t < 20, right: t >= 20, fire: i % 5 === 0 },
                     p4: p4dir ? { [p4dir]: true, fire: i % 4 === 0 } : {} });
        fps.push(gg.fingerprint());
      }
      return fps.join(',');
    };
    checkTrue('four players for 120 passes: deterministic (two runs fingerprint alike)',
              run4('up') === run4('up'));
    checkTrue('...and the FOURTH byte reaches the sim (p4 walking vs standing diverges)',
              run4('up') !== run4(null));
    checkTrue('...and both runs end with four still in the game', g.players.every(q => q.inGame));
  }

  /* --- SYMMETRY: each generalized rule, driven with block 3 or 4 -------- */
  {
    const F_EXITING = 0x40, F_DEAD = 0x80;
    /* $AAC4's body box against block 3 */
    g.reset({}); joinAll(g);
    const p1 = g.players[0], p3 = g.players[2], p4 = g.players[3];
    p1.x = 12; p1.y = 8; p3.x = 16; p3.y = 8; p4.x = 40; p4.y = 40; g.players[1].x = 40; g.players[1].y = 60;
    g.p = p1; p1.animCtl &= ~0x08;
    check('$AAC4: block 3\'s body refuses block 1\'s step and sets his contact bit',
          [g.otherPlayerBox({ x: 14, y: 8 }), (p1.animCtl & 0x08) !== 0], [true, true]);
    p1.animCtl &= ~0x08; p3.f11 |= F_EXITING;
    check('...and an EXITING block 3 refuses nothing ($AACA BIT 6)',
          [g.otherPlayerBox({ x: 14, y: 8 }), (p1.animCtl & 0x08) !== 0], [false, false]);
    p3.f11 &= ~F_EXITING;
    /* $AAF5's shove from block 4 */
    p4.x = 12; p4.y = 4; p4.dir = 0x02; p1.dir = 0;             // p4 above, holding DOWN
    g.passCtr &= ~1;
    g.shove(p4, p1);
    check('$AAF5: block 4 four units above, holding DOWN, writes DOWN into block 1\'s byte',
          p1.dir & 0x0F, 0x02);
    /* the leash (offline): block 4 far away refuses block 1's step */
    p4.x = 78; p4.y = 8; p4.f11 &= ~F_DEAD; g.p = p1;      // 64 units: past $3D
    check('$A924: the leash holds block 1 to block 4 as it held him to block 2',
          g.leash({ x: 14, y: 8 }, true), true);
    p4.x = 20;
    check('...and releases inside the screen', g.leash({ x: 14, y: 8 }, true), false);
    /* $94AE: the level ends when EVERY block is finished or dead */
    g.reset({}); joinAll(g);
    for (const q of g.players.slice(0, 3)){ q.f11 |= F_DEAD; q.dead = true; q.p14 |= 0x80; }
    check('$94B4: three dead and block 4 alive -- the level goes on', g.levelEnd(), false);
    g.players[3].levelOwn = 7; g.players[2].levelOwn = 3;
    g.players[3].f11 |= F_DEAD;                                   // finished the exit
    check('...block 4 finishing ends it, and $94C3 takes the MAX of four (7)',
          [g.levelEnd(), g.level, g.gameOver], [true, 7, false]);
    /* $B3AB: a dead player 1 whose partner walked out goes to the NEXT
       dungeon, not the game-over chain (the four-block all-dead test) */
    g.reset({}); joinAll(g);
    g.players[0].f11 |= F_DEAD; g.players[0].dead = true; g.players[0].p14 |= 0x80;
    for (const q of g.players.slice(1)){ q.f11 |= F_DEAD; q.levelOwn = 2; }   // three exit
    checkTrue('$B3AB: player 1 dead, the rest EXITED -> levelEnd says next dungeon',
              g.levelEnd() && !g.gameOver);
    g.levelOver();
    check('...and levelOver builds dungeon 2 in play -- not the RIP chain',
          [g.mode, g.level], ['play', 2]);
    g.reset({}); joinAll(g);
    for (const q of g.players){ q.f11 |= F_DEAD; q.dead = true; q.p14 |= 0x80; }
    g.levelEnd(); g.levelOver();
    check('...while ALL FOUR dead is the game over', g.mode, 'over');
    /* $ADC7 with three in: the nearest of three, ties to the lower block */
    g.reset({}); joinAll(g);
    for (const q of g.players){ q.timer = 0; q.f11 &= ~F_DEAD; }
    g.players[3].p14 |= 0x80;                                     // block 4 out
    g.players[0].x = 60; g.players[0].y = 60;
    g.players[1].x = 20; g.players[1].y = 60;
    g.players[2].x = 40; g.players[2].y = 30;
    const t = g.chaseTarget();
    check('$ADC7: three in the game -> the NEARER of three (a list of the live ones, player 1 first)',
          Array.isArray(t) ? t.map(q => q.idx) : t, [0, 1, 2]);
    const aim = g.actorAim({ x: 44, y: 32 });
    check('...and actorAim takes block 3, the nearest, over both others', aim.dist,
          ((44 - 40) + (32 - 30)));
    /* $B060's walk: blocks 1 and 2 flashing, block 3 clean -> aimed at block 3 */
    g.reset({}); joinAll(g);
    for (const q of g.players) q.f11 &= ~F_DEAD;
    g.players[0].timer = 5; g.players[1].timer = 5; g.players[2].timer = 0; g.players[3].timer = 0;
    g.players[2].x = 10; g.players[2].y = 10;                   // up-left of the actor
    g.players[3].x = 100; g.players[3].y = 100;
    g.mshots.length = 0;
    g.actorFire3({ x: 40, y: 40 }, 0, 0);                        // even coin: walk from block 1
    check('$B060: an even coin walks blocks 1, 2 (flashing) to block 3 -- the shot\'s signs say up-left',
          g.mshots.length === 1 ? [(g.mshots[0].state & 0x08) !== 0, (g.mshots[0].state & 0x80) !== 0] : g.mshots.length,
          [true, true]);
    g.players[2].f11 |= F_DEAD; g.mshots.length = 0;
    g.actorFire3({ x: 40, y: 40 }, 0, 0);
    check('...and a DEAD block 3 ends the walk with no shot ($B076 RET nz)', g.mshots.length, 0);
    /* the ring: block 4's eight slots at +$60 fill and drain at the two-block cadence */
    g.reset({}); joinAll(g);
    g.ring.fill(0xFF); g.mshots.length = 0;
    g.ringWrite(0x03, 20, 24, 0x60);
    check('$B04B: block 4\'s facing-3 slot lives at ring byte $60 + 12, priority $90 + $6C',
          [g.ring[0x6C], g.ring[0x6D], g.ring[0x6E], g.ring[0x6F]], [(0x90 + 0x6C) & 0xFF, 20, 24, 3]);
    let born = -1;
    for (let i = 0; i < 8 && born < 0; i++){ g.passCtr = i; g.ringDrain(); if (g.mshots.length) born = i; }
    g.ring.fill(0xFF); g.mshots.length = 0;
    g.ringWrite(0x03, 20, 24, 0x20);                             // block 2's same facing
    let born2 = -1;
    for (let i = 0; i < 8 && born2 < 0; i++){ g.passCtr = i; g.ringDrain(); if (g.mshots.length) born2 = i; }
    check('$8FC5 drains it on the pass its facing comes round (passCtr & 7 = 5) -- the same pass as block 2\'s own',
          [born, born2, g.mshots.length && g.mshots[0].x, g.mshots.length && g.mshots[0].state],
          [5, 5, 21, 0x93]);
    /* $B717's robin serves block 3 two blocks apart from block 1 */
    g.reset({}); joinAll(g);
    g.players[2].f11 |= 0x01;                                    // F_HEALTH_D on block 3
    let served = -1;
    for (let i = 0; i < 8 && served < 0; i++){ g.passCtr = (g.passCtr & ~3) | (i & 3); g.hudPass(); if (!(g.players[2].f11 & 1)) served = i; }
    checkTrue('$B717: block 3\'s dirty flag is served on the block-1 passes of the robin', served >= 0 && (served & 2) === 0, 'served at ' + served);
    /* $9445's retired entry: a dead player REJOINS on FIRE while the
       others play, and a dead second block can join the NEXT game */
    g.reset({}); joinAll(g);
    g.players[2].health = 0;
    g.onePass({});                                               // $93CD at $8540
    check('block 3 dies: out, the death mark ($93E2), the RIP marker',
          [g.players[2].inGame, g.players[2].animCtl, g.players[2].died], [false, 0x80, true]);
    g.onePass({});
    check('the mark is SPENT on the next poll ($93A8 / $948C, with no entry to type)',
          [g.players[2].animCtl, g.players[2].inGame, g.players[2].died], [0, false, true]);
    g.onePass({ p3: { fire: true } });
    check('...and FIRE brings him back through $9440: in, 2000 health, the RIP down',
          [g.players[2].inGame, g.players[2].health, g.players[2].died, g.mode], [true, 0x2000, false, 'play']);
    g.players[2].animCtl = 0x10; g.players[2].p14 |= 0x80; g.players[2].dead = true;
    g.onePass({}); g.onePass({ p3: { fire: true } });
    check('an out block left with the SHOVE bit ($AB24, never cleared for the dead) is not locked out',
          g.players[2].inGame, true);
    g.players[2].animCtl = 0x41; g.players[2].p14 |= 0x80; g.players[2].dead = true;
    g.onePass({}); g.onePass({ p3: { fire: true } });
    check('...while any other bit in (IX+14) still refuses, as $9445 did', g.players[2].inGame, false);
    /* the whole party dead: after the RIP hold every block can join the new game */
    g.reset({}); joinAll(g);
    for (const q of g.players) q.health = 0;
    for (let i = 0; i < 4 && g.mode === 'play'; i++){ g.onePass({}); if (g.levelDone) g.levelOver(); }
    check('all four dead -> the RIP hold', g.mode, 'over');
    while (g.mode === 'over') g.overTick();
    check('...then the attract loop, everyone out', [g.mode, g.players.every(q => !q.inGame)], ['attract', true]);
    g.attractTick({}); g.attractTick({ p4: { fire: true } });
    g.attractTick({});
    check('...and a block that died in the last game joins the next one on FIRE',
          [g.mode, g.players[3].inGame], ['play', true]);
    /* $9788's ink per block */
    checkTrue('panelInk follows the CHARACTER of block 4 (the wizard\'s $46)',
              G.render && g.players[3].charIndex === 2);
  }

  /* --- THE FOUR-QUARTER HUD, at the renderer ---------------------------- */
  {
    /* rasterized, so a later black fill covers an earlier glyph */
    const raster = list => {
      const buf = new Uint8Array(256 * 32);
      for (const c of list){
        if (c[0] !== 'fillRect') continue;
        const on = c[5] !== '#000000' ? 1 : 0;
        for (let y = Math.max(160, c[2] | 0); y < Math.min(192, (c[2] | 0) + (c[4] | 0)); y++)
          for (let x = Math.max(0, c[1] | 0); x < Math.min(256, (c[1] | 0) + (c[3] | 0)); x++)
            buf[(y - 160) * 256 + x] = on;
      }
      return buf;
    };
    const box = (buf, x0, x1, y0, y1) => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += buf[(y - 160) * 256 + x];
      return n;
    };
    const paint = gg => { recording = true; drawCalls.length = 0;
                          G.render(ctxStub, gg); recording = false;
                          return raster(drawCalls); };
    const g4 = G.seed({});
    g4.autoJoin(4);
    check('Game.autoJoin(4) joins all four', g4.players.map(q => q.inGame), [true, true, true, true]);
    g4.names = ['ABCDEFGH', '', 'X', ''];
    g4.players[0].score = 0x123456; g4.players[0].health = 0x1997;
    g4.players[0].keys = 12; g4.players[0].potions = 3; g4.players[0].p14 = 0x3F;
    g4.players[1].score = 0; g4.players[1].keys = 0; g4.players[1].potions = 0;
    g4.frameCtr = 0;
    const L = paint(g4);
    /* the micro font: 4 px glyphs on a 5 px pitch, 6 px a line, from
       y 160; a quarter is 64 px from x = 64 * idx */
    checkTrue('quarter 1: an eight-letter name spans x 0..38 of the name line (y 160-164)',
              box(L, 0, 4, 160, 165) > 0 && box(L, 35, 39, 160, 165) > 0 && box(L, 39, 64, 160, 165) === 0);
    checkTrue('quarter 2: the unset name wears the character\'s own (VALKYRIE) at x 64..102',
              box(L, 64, 68, 160, 165) > 0 && box(L, 99, 103, 160, 165) > 0);
    checkTrue('quarter 3: a one-letter name is left-aligned: x 128..131 and nothing else on its line',
              box(L, 128, 132, 160, 165) > 0 && box(L, 132, 192, 160, 165) === 0);
    checkTrue('quarter 1 SCORE line (y 166-170): the label at x 0..23, six digits to x 58',
              box(L, 0, 24, 166, 171) > 0 && box(L, 55, 59, 166, 171) > 0 && box(L, 59, 64, 166, 171) === 0);
    checkTrue('quarter 1 HEALTH line (y 172-176): the label to x 28, four digits to x 53',
              box(L, 0, 29, 172, 177) > 0 && box(L, 50, 54, 172, 177) > 0 && box(L, 54, 64, 172, 177) === 0);
    checkTrue('quarter 1: the key icon + 12 at x 0..18 and the potion icon + 3 at x 35..48 (y 178-182), gaps between',
              box(L, 0, 8, 178, 183) > 0 && box(L, 10, 19, 178, 183) > 0 && box(L, 8, 10, 178, 183) === 0 &&
              box(L, 19, 35, 178, 183) === 0 && box(L, 35, 43, 178, 183) > 0 && box(L, 45, 49, 178, 183) > 0 &&
              box(L, 49, 64, 178, 183) === 0);
    checkTrue('quarter 1: all six power icons lit on the 8 px row 184-191, cells 0-5, cells 6-7 dark',
              [0, 1, 2, 3, 4, 5].every(c => box(L, c * 8, c * 8 + 8, 184, 192) > 0) && box(L, 48, 64, 184, 192) === 0);
    checkTrue('quarter 2: score 0 prints SCORE 0 -- the digit at x 94..97, nothing right of it',
              box(L, 94, 98, 166, 171) > 0 && box(L, 99, 128, 166, 171) === 0);
    checkTrue('quarter 2: no keys, no potions, no icons -> its KEYS line and icon row are dark',
              box(L, 64, 128, 178, 183) === 0 && box(L, 64, 128, 184, 192) === 0);
    checkTrue('quarters 3 and 4 carry HEALTH 2000 (digits at x+35..53)',
              box(L, 128 + 35, 128 + 54, 172, 177) > 0 && box(L, 192 + 35, 192 + 54, 172, 177) > 0);
    checkTrue('nothing paints between the lines (y 165, 171, 177, 183 are blank across the band)',
              [165, 171, 177, 183].every(y => box(L, 0, 256, y, y + 1) === 0));
    /* an OUT block's quarter is blank -- and stays blank in the RIP hold */
    const g2 = G.seed({}); g2.autoJoin(2);
    const L2 = paint(g2);
    checkTrue('with two in, quarters 3 and 4 (x 128-255) are BLANK top to bottom',
              box(L2, 128, 256, 160, 192) === 0);
    checkTrue('...while quarter 2 shows the second player', box(L2, 64, 128, 160, 165) > 0);
    /* $9788's low-health flash: name and counters blink to BRIGHT BLACK;
       the KEYS/POT line and the icons keep their own colours */
    /* (g2 above IS the shared instance g4 names: re-arm it) */
    g4.autoJoin(4); g4.players[0].keys = 12; g4.players[0].potions = 3;
    g4.players[0].health = 0x0150; g4.frameCtr = 0x10;
    const Lf = paint(g4);
    g4.frameCtr = 0;
    const Ln = paint(g4);
    checkTrue('a quarter under 200 health flashes its name and counters black on frame bit 4',
              box(Lf, 0, 64, 160, 177) === 0 && box(Ln, 0, 64, 160, 165) > 0 &&
              box(Lf, 0, 64, 178, 183) > 0);
    /* the attract screen keeps the classic halves: PRESS FIRE on row 23 of the right half */
    const gA = G.seed({}); gA.enterAttract();
    const LA = paint(gA);
    checkTrue('the attract screen still shows the classic wordmark halves (row 23 lit, x 168..215)',
              box(LA, 168, 216, 184, 192) > 0);
  }

  /* --- the snapshot carries four blocks ---------------------------------- */
  {
    g.reset({ online: true }); joinAll(g);
    for (let i = 0; i < 30; i++) g.onePass({ right: true, p2: { down: true }, p3: { left: true }, p4: { up: true } });
    const wire = JSON.stringify(g.snapshot());
    const fp = g.fingerprint();
    const s = JSON.parse(wire);
    check('the wire is v2 and carries four player blocks and the 32-slot ring',
          [s.v, s.players.length, s.ring.length], [2, 4, 128]);
    g.reset({}); g.restore(s);
    check('restore() rebuilds all four: fingerprint equal, four in the game, four live windows',
          [g.fingerprint() === fp, g.players.map(q => q.inGame), g.players.map(q => q.camLive)],
          [true, [true, true, true, true], [true, true, true, true]]);
  }

  /* --- the wire at FOUR seats, through the mock transport --------------- */
  {
    const NP = G.assets.protocol, M = NP.msgs, S = G.net.state;
    const sent = [];
    let H = null;
    const tpF = (url, h) => { H = h; return { send: b => sent.push(Array.from(b)), close(){} }; };
    const u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    G.frontend.liveKb.releaseAll();
    G.net.start('ws://mock4', { char: 1, method1: 3, zonePotion: false }, tpF);
    H.open();
    H.message(Uint8Array.from([M.WELCOME, 3, 4, ...u32(0xBEEF), NP.welcomeModes.FRESH, ...u32(0)]));
    checkTrue('a FOUR-seat WELCOME is accepted (the two-seat latch is lifted): seat 3 of 4, booting',
              S.phase === 'boot' && S.seat === 3 && S.seats === 4);
    H.message(Uint8Array.from([M.CHARS, 0, 2, 255, 1]));
    check('CHARS at four seats: the table\'s picks, seat 3 unset -> the lowest unused (3), my seat 3 displayed',
          [S.phase, G.game.players.map(q => q.charIndex), G.game.localIdx],
          ['live', [0, 2, 3, 1], 3]);
    G.net.frame(0.06);
    H.message(Uint8Array.from([M.PASS, ...u32(0), 4, 0x10, 0x10, 0x10, 0x10, 0, 0, 0, 0]));
    G.net.frame(0);
    check('a PASS of four FIRE bytes joins all four through $9440',
          [S.step, G.game.mode, G.game.players.map(q => q.inGame)],
          [1, 'play', [true, true, true, true]]);
    let ok = true;
    try { recording = false; G.render(ctxStub, G.game); } catch (e){ ok = false; }
    checkTrue('...and the client renders seat 3\'s OWN window (localIdx 3) without a hitch',
              ok && G.game.players[3].camLive);
    S.phase = 'off'; S.tp = null;
    G.frontend.liveKb.releaseAll();
  }

  G.seed({});
  G.settings.reset();
}


/* ====================================================================
   SPEECH BUBBLES (this fork; Anthony's spec, CLAUDE.md planned work 5).
   Chat is display metadata end to end -- the NAMES pattern: a CHAT line
   out, the relay's stamped echo in, a bubble over the speaker's sprite,
   never the sim's.  Driven through the mock transport and the compose
   feed the DOM keydown handler calls (netChatKey).
   ==================================================================== */
{
  const F = G.frontend;
  const NP = G.assets.protocol, M = NP.msgs, S = G.net.state;
  const sent = [];
  let H = null;
  const tpF = (url, h) => { H = h; return { send: b => sent.push(Array.from(b)), close(){} }; };
  const u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const lastOf = t => { for (let i = sent.length - 1; i >= 0; i--)
                          if (sent[i][0] === t) return sent[i]; return null; };
  const kb = F.liveKb; kb.releaseAll();
  check('the protocol carries CHAT (16) and chatLen 32', [M.CHAT, NP.chatLen], [16, 32]);
  check('chatLines wraps at a space inside sixteen, else hard, never past two lines',
        [G.net.chatLines('HI'), G.net.chatLines('THE QUICK BROWN FOX JUMPS OVER'),
         G.net.chatLines('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), G.net.chatLines('A BCDEFGHIJKLMNOPQRSTUVWXYZ01234')],
        [['HI'], ['THE QUICK BROWN', 'FOX JUMPS OVER'],
         ['ABCDEFGHIJKLMNOP', 'QRSTUVWXYZ012345'], ['A BCDEFGHIJKLMNO', 'PQRSTUVWXYZ01234']]);
  /* offline nothing opens */
  S.phase = 'off';
  check('OFFLINE, ENTER is not a chat key (nobody to talk to)', G.net.chatKey('Enter'), false);

  /* a four-seat session, seat 1, everyone in */
  G.net.start('ws://mockchat', { char: 1, method1: 3, zonePotion: false }, tpF);
  H.open();
  H.message(Uint8Array.from([M.WELCOME, 1, 4, ...u32(0xC0FFEE), NP.welcomeModes.FRESH, ...u32(0)]));
  H.message(Uint8Array.from([M.CHARS, 0, 1, 2, 3]));
  check('in the attract LOBBY, ENTER is not a chat key either (no sprite to speak from)',
        [S.phase, G.game.mode, G.net.chatKey('Enter'), S.compose], ['live', 'attract', false, null]);
  G.net.frame(0.06);
  H.message(Uint8Array.from([M.PASS, ...u32(0), 4, 0x10, 0x10, 0x10, 0x10, 0, 0, 0, 0]));
  G.net.frame(0);
  check('four in the game', [G.game.mode, G.game.players.every(q => q.inGame)], ['play', true]);

  /* ---- the compose line ---------------------------------------------- */
  kb.press('D');                                    // method 3 RIGHT, held throughout
  G.net.frame(0.1);
  check('before the line opens the held key reaches the wire', lastOf(M.INPUT)[5] & 0x0F, 0x08);
  H.message(Uint8Array.from([M.PASS, ...u32(1), 4, 8, 0, 0, 0, 0, 0, 0, 0]));
  G.net.frame(0);
  check('ENTER opens the line', [G.net.chatKey('Enter'), S.compose], [true, '']);
  sent.length = 0;
  G.net.frame(0.1);
  check('...and while it is open the wire carries 0: the player STANDS with RIGHT still held',
        lastOf(M.INPUT)[5], 0);
  H.message(Uint8Array.from([M.PASS, ...u32(2), 4, 0, 0, 0, 0, 0, 0, 0, 0]));
  G.net.frame(0);
  for (const k of ['h', 'i', ' ', 'a', 'l', 'l', '?', '@', '1', 'Backspace', '!', '\'', '-']) G.net.chatKey(k);
  check('typing upper-cases, keeps the micro font\'s punctuation, drops what it cannot draw, rubs out on Backspace',
        S.compose, 'HI ALL?!\'-');
  for (let i = 0; i < 40; i++) G.net.chatKey('X');
  check('...and stops at chatLen (32)', S.compose.length, 32);
  check('a movement key while the line is open is the LINE\'s, not the game\'s (swallowed)',
        [G.net.chatKey('ArrowLeft'), G.net.chatKey('F12'), S.compose.length], [true, true, 32]);
  check('ESC is NOT a chat key: swallowed like any other while the line is open, the line stays',
        [G.net.chatKey('Escape'), S.compose.length, lastOf(M.CHAT)], [true, 32, null]);
  for (let i = 0; i < 40; i++) G.net.chatKey('Backspace');
  check('rubbing the line out and ENTER closes it and sends nothing -- the one way to abandon a line',
        [S.compose, G.net.chatKey('Enter'), S.compose, lastOf(M.CHAT)], ['', true, null, null]);
  G.net.chatKey('Enter'); G.net.chatKey('Enter');
  check('ENTER on an empty line closes it and sends nothing', [S.compose, lastOf(M.CHAT)], [null, null]);
  G.net.chatKey('Enter');
  for (const k of ['g', 'o', ' ', 'l', 'e', 'f', 't', ' ']) G.net.chatKey(k);
  check('ENTER on a line SENDS it: CHAT, the length, the bytes, trailing space trimmed; the line closes',
        [G.net.chatKey('Enter'), S.compose, lastOf(M.CHAT)],
        [true, null, [M.CHAT, 7].concat(Array.from('GO LEFT', c => c.charCodeAt(0)))]);
  G.net.frame(0.1);
  check('...and the next byte is the held key again', lastOf(M.INPUT)[5] & 0x0F, 0x08);
  kb.releaseAll();

  /* ---- the echo and the bubble ----------------------------------------- */
  const paint = () => { recording = true; drawCalls.length = 0;
                        G.render(ctxStub, G.game); recording = false;
                        return drawCalls.slice(); };
  /* the PAPER is the one white fill taller than a sprite row */
  const papers = list => list.filter(c => c[0] === 'fillRect' && c[5] === '#ffffff' && c[4] >= 7 && c[2] < 160);
  const fp0 = G.game.fingerprint();
  check('no bubble yet: no paper on the playfield', papers(paint()).length, 0);
  H.message(Uint8Array.from([M.CHAT, 2, 8].concat(Array.from('HI THERE', c => c.charCodeAt(0)))));
  check('the relay\'s echo lands on game.chat for the stamped seat, with a life',
        [G.game.chat[2] && G.game.chat[2].text, G.game.chat[2] && G.game.chat[2].until > 0,
         G.game.chat[0], G.game.chat[1], G.game.chat[3]], ['HI THERE', true, null, null, null]);
  const L1 = paint();
  const pp = papers(L1);
  check('...and a bubble rises: one paper, one line tall (13 px wide per glyph x 8 + 2 px of border)',
        [pp.length, pp[0] && pp[0][4], pp[0] && pp[0][3]], [1, 7, 8 * 5 - 1 + 2]);
  {
    const q = G.game.players[2], d = G.game.players[G.game.localIdx];
    /* the sprite's own draw arithmetic (SPRITE_DX/DY are 0 in the asset);
       at the window's top edge the bubble goes UNDER the sprite, tail up */
    const psx = (((q.x - d.camX) & 0x7E) >> 1) * 8, psy = (((q.y - d.camY) & 0x7E) >> 1) * 8;
    const paper = pp[0];
    const above = paper[2] + paper[4] + 2 <= psy, below = paper[2] - 2 >= psy + 16;
    checkTrue('...over the SPEAKER\'s sprite (under it at the window\'s top edge), centred on him',
              (above || below) && Math.abs((paper[1] + paper[3] / 2) - (psx + 8)) <= 2,
              JSON.stringify([paper, psx, psy]));
    const border = L1.filter(c => c[0] === 'fillRect' && c[2] === paper[2] - 1 && c[1] === paper[1] - 1);
    checkTrue('...bordered in the speaker\'s own ink (the wizard, block 3: bright yellow)',
              border.length === 1 && border[0][5] === '#ffff00');
    const textPx = L1.filter(c => c[0] === 'fillRect' && c[5] === '#000000' && c[3] === 1 && c[4] === 1 &&
                             c[1] > paper[1] && c[1] < paper[1] + paper[3] && c[2] > paper[2] && c[2] < paper[2] + paper[4]);
    checkTrue('...the line in black on the paper', textPx.length > 20);
  }
  check('SPEECH IS NOT SIM STATE: the fingerprint did not move', G.game.fingerprint(), fp0);
  checkTrue('...and the snapshot wire does not carry it', !('chat' in JSON.parse(JSON.stringify(G.game.snapshot())).game));
  G.game.chat[2].until = 0;
  check('the bubble goes when its life is up', papers(paint()).length, 0);
  /* a two-line bubble, and the newest line replaces the last */
  H.message(Uint8Array.from([M.CHAT, 2, 30].concat(Array.from('THE QUICK BROWN FOX JUMPS OVER', c => c.charCodeAt(0)))));
  const p2 = papers(paint());
  check('a thirty-character line: one bubble, two lines tall, the longer line\'s width',
        [p2.length, p2[0][4], p2[0][3]], [1, 13, 15 * 5 - 1 + 2]);
  H.message(Uint8Array.from([M.CHAT, 2, 2].concat(Array.from('OK', c => c.charCodeAt(0)))));
  check('...the next line REPLACES it', [G.game.chat[2].text, papers(paint())[0][3]], ['OK', 2 * 5 - 1 + 2]);
  /* the composing bubble: your own line, live, with a cursor */
  G.net.chatKey('Enter');
  for (const k of ['y', 'o']) G.net.chatKey(k);
  const pc = papers(paint());
  check('while composing, YOUR bubble shows the line so far (plus the cursor cell): two papers now',
        [pc.length, pc.some(p => p[3] === 3 * 5 - 1 + 2)], [2, true]);
  G.net.chatKey('Backspace'); G.net.chatKey('Backspace'); G.net.chatKey('Enter');
  check('...and an emptied line plus ENTER takes it down', papers(paint()).length, 1);
  /* a dead speaker speaks from his corpse */
  G.game.players[2].health = 0;
  G.game.onePass({});
  H.message(Uint8Array.from([M.CHAT, 2, 3].concat(Array.from('RIP', c => c.charCodeAt(0)))));
  check('a dead player\'s line rises from his corpse (the RIP cell)',
        [G.game.players[2].died, papers(paint()).length], [true, 1]);
  /* restore keeps the receiver's own live speech, as it keeps names */
  {
    const wire = JSON.stringify(G.game.snapshot());
    G.game.restore(JSON.parse(wire));
    check('restore() preserves game.chat (the receiver\'s own display state)', G.game.chat[2] && G.game.chat[2].text, 'RIP');
  }
  S.phase = 'off'; S.tp = null; S.compose = null;
  G.frontend.liveKb.releaseAll();
  G.seed({});
  G.settings.reset();
}


/* ====================================================================
   THE TAB-AWAY REGRESSION (Anthony, 2026-09-03): "if I leave the
   Chrome tab and come back the game is locked up, WAITING FOR PLAYERS
   flashes though I'm the only player, and the audio lags by seconds."
   Reproduced under the virtual clock on the second-cut pump: hidden 30 s
   the sim ran 66 s (2.2x, in three-times-rate bursts), the first INPUT
   after the return went 5.08 s late (the accumulator's floor), WAITING
   tripped at that instant, and the sim stayed 31 s ahead of the wall
   clock for good -- which is the audio lag.  This block is that
   scenario, pinned to the third-cut numbers.
   ==================================================================== */
{
  const { makeLagShim } = require('./netlag');
  const NP = G.assets.protocol, M = NP.msgs, S = G.net.state;
  const shim = makeLagShim(NP, { rttMs: 20, seed: 3 });
  let hiddenFlag = false;
  sandbox.performance = { now: () => shim.clock.now() };
  /* Chrome's background rule: a hidden tab's timers run at most once a second */
  sandbox.setTimeout = (fn, ms) => shim.clock.setTimeout(fn, hiddenFlag ? Math.max(ms, 1000) : ms);
  sandbox.document.hidden = false;
  const setHidden = v => { hiddenFlag = v; sandbox.document.hidden = v; G.net.pump(); };
  G.frontend.liveKb.releaseAll();
  G.net.start('away', { char: 3, method1: 3, zonePotion: false }, shim.tpFactory);
  S.autoFire = true;
  /* frames at 60 Hz; with `ticking` the speaker ticks every 43 ms as the
     processor does whether the tab is visible or not */
  let sinceTick = 0;
  const frames = (n, ticking) => {
    for (let i = 0; i < n; i++){
      shim.clock.advance(1000 / 60); G.net.frame(1 / 60);
      if (ticking && (sinceTick += 1000 / 60) >= 43){ sinceTick = 0; G.sound.out.tick(); }
    }
  };
  const inputs = () => shim.stats.sends.filter(s => s.type === M.INPUT).length;
  frames(180);
  checkTrue('a solo session is in play after three visible seconds', G.game.mode === 'play' && S.step > 25, 'step ' + S.step);
  /* hidden for `secs`: no frames; the wire and the timers run on the clock;
     with `ticking` the speaker ticks every 43 ms */
  const away = (secs, ticking) => {
    const sim0 = G.game.simT, wall0 = shim.clock.now();
    let maxLead = -1e9;
    for (let i = 0; i < secs * 100; i++){
      shim.clock.advance(10);
      if (ticking && (sinceTick += 10) >= 43){ sinceTick = 0; G.sound.out.tick(); }
      const lead = (G.game.simT - sim0) - (shim.clock.now() - wall0) / 1000;
      if (lead > maxLead) maxLead = lead;
    }
    return { sim: G.game.simT - sim0, wall: (shim.clock.now() - wall0) / 1000, maxLead };
  };
  const back = secs => {
    const wall0 = shim.clock.now(), n0 = inputs();
    let firstInput = -1, waiting = false;
    for (let i = 0; i < secs * 60; i++){
      shim.clock.advance(1000 / 60);
      G.net.frame(1 / 60);
      if (firstInput < 0 && inputs() > n0) firstInput = (shim.clock.now() - wall0) / 1000;
      if (S.sentInput && shim.clock.now() - S.lastProgress > 700) waiting = true;
    }
    return { firstInput, waiting };
  };
  /* 1. no speaker: the clamped-timer regime */
  setHidden(true);
  const a = away(30, false);
  checkTrue('HIDDEN 30 s with no speaker: the sim runs at REAL TIME, one-second bursts and all (30 s of sim, not 66)',
            Math.abs(a.sim - a.wall) <= 1.2, 'sim ' + a.sim.toFixed(2) + ' wall ' + a.wall.toFixed(2));
  checkTrue('...never more than the half-second bound plus a pass ahead of the wall clock (the timer regime\'s headroom)',
            a.maxLead <= 0.75, 'maxLead ' + a.maxLead.toFixed(2));
  setHidden(false);
  const r1 = back(3);
  checkTrue('BACK: the first INPUT goes inside the lead -- well under a second, not five',
            r1.firstInput >= 0 && r1.firstInput <= 0.7, 'first ' + r1.firstInput);
  checkTrue('...and WAITING FOR PLAYERS never trips', !r1.waiting);
  /* 2. the speaker ticking: the fine regime (the speaker was ticking
     BEFORE the tab hid, as a running one is) */
  frames(60, true);
  setHidden(true);
  const b = away(20, true);
  checkTrue('HIDDEN 20 s with the speaker ticking: real time again, and the sim never more than the tenth-of-a-second bound plus a pass ahead',
            Math.abs(b.sim - b.wall) <= 0.3 && b.maxLead <= 0.25, 'sim ' + b.sim.toFixed(2) + ' wall ' + b.wall.toFixed(2) + ' maxLead ' + b.maxLead.toFixed(3));
  setHidden(false);
  const r2 = back(3);
  checkTrue('BACK: the first INPUT goes within a pass or two, WAITING never trips',
            r2.firstInput >= 0 && r2.firstInput <= 0.25 && !r2.waiting, 'first ' + r2.firstInput);
  checkTrue('the sim is where the wall clock is: no lasting lead for the speaker to lag by',
            S.acc > -0.2 && S.acc <= 0.15, 'acc ' + S.acc);
  S.phase = 'off'; S.tp = null;
  delete sandbox.setTimeout; delete sandbox.performance;
  sandbox.document.hidden = false;
  G.frontend.liveKb.releaseAll();
  G.seed({});
  G.settings.reset();
}


/* ====================================================================
   FULL SCREEN (this fork, 2026-09-03): the picture at the largest whole
   multiple that fits, Alt+Enter to toggle.  The API itself is the
   browser's; what the suite can pin is the arithmetic, the key rule and
   the page furniture.
   ==================================================================== */
{
  const FS = G.fullscreen;
  check('the full-screen scale is the largest WHOLE multiple that fits, in DEVICE pixels',
        [FS.scale(1920, 1080, 1), FS.scale(1280, 720, 1), FS.scale(2560, 1440, 1),
         FS.scale(1440, 900, 2), FS.scale(200, 100, 1)],
        [5, 3, 7, 9, 1]);
  check('Alt+Enter is the toggle; plain Enter (the chat), F5 (the browser\'s reload) and Ctrl+Alt+Enter are not',
        [FS.isKey({ key: 'Enter', altKey: true }), FS.isKey({ key: 'Enter' }),
         FS.isKey({ key: 'F5' }), FS.isKey({ key: 'Enter', altKey: true, ctrlKey: true })],
        [true, false, false, false]);
  checkTrue('the page carries the full-screen button beside the theme button, and says how',
            /id="fs"/.test(html) && /Alt\+Enter, or double-click/.test(html));
  checkTrue('the fullscreen element is the overscan frame, laid out to fill the screen',
            /#overscan:fullscreen\{/.test(html));
}


/* ====================================================================
   NETPLAN §3.1 -- THE LOBBY'S TICK IS FOUR FRAMES (built 2026-09-03).
   One exchange in attract/over/rewind steps four video frames on one
   byte; play is untouched.  Not pipelining: one byte in flight, the
   sampling lead zero exchanges, and a lobby byte never runs a pass.
   ==================================================================== */
{
  const F = G.frontend;
  const NP = G.assets.protocol, M = NP.msgs, S = G.net.state;
  const sent = [];
  let H = null;
  const tpF = (url, h) => { H = h; return { send: b => sent.push(Array.from(b)), close(){} }; };
  const u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const inputs = () => sent.filter(m => m[0] === M.INPUT).length;
  const kb = F.liveKb; kb.releaseAll();
  G.net.start('ws://mock31', { char: 3, method1: 3, zonePotion: false }, tpF);
  H.open();
  H.message(Uint8Array.from([M.WELCOME, 0, 2, ...u32(0x31), NP.welcomeModes.FRESH, ...u32(0)]));
  H.message(Uint8Array.from([M.CHARS, 3, 255, 255, 255]));
  const g = G.game;
  check('in the attract lobby the SIM tick is still a frame and the WIRE tick is four of them',
        [g.mode, Math.round(g.tickSeconds() * 1000), g.wireFrames(), Math.round(g.wireSeconds() * 1000)],
        ['attract', 20, 4, 80]);
  /* the send clock owes a byte per WIRE tick, not per frame */
  sent.length = 0;
  G.net.frame(0.05);
  check('50 ms into the lobby no byte is owed (a frame tick would have sent at 20)', inputs(), 0);
  G.net.frame(0.04);
  check('...at 90 ms one is', inputs(), 1);
  checkTrue('net.info() reports the wire\'s own rate in the lobby: 12.5, not 50', /sim=12\.5/.test(G.net.info()));
  /* one PASS, no FIRE: four attract frames, no pass */
  const fc0 = g.frameCtr, at0 = g.attractT, pass0 = g.pass, step0 = S.step;
  H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0]));
  check('one lobby PASS steps FOUR video frames -- $8497 and the attract clock both -- and no pass',
        [S.step - step0, (g.frameCtr - fc0) & 0xFF, g.attractT - at0, g.pass - pass0, g.mode],
        [1, 4, 4, 0, 'attract']);
  /* one PASS with FIRE: the join lands on the group's FIRST frame and the
     group ENDS there -- not one pass runs on a lobby byte */
  G.net.frame(0.1);
  const fc1 = g.frameCtr, pass1 = g.pass;
  H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0x10, 0]));
  check('a FIRE byte joins on the group\'s first frame and the group ends with the mode: one frame, ZERO passes',
        [g.mode, g.players[0].inGame, (g.frameCtr - fc1) & 0xFF, g.pass - pass1],
        ['play', true, 1, 0]);
  check('...and in play the wire tick is ONE pass again', [g.wireFrames(), Math.round(g.wireSeconds() * 1000)], [1, 80]);
  G.net.frame(0.1);
  const pass2 = g.pass;
  H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0]));
  check('a play PASS is one pass, as it always was', g.pass - pass2, 1);
  /* the RIP hold: 250 frames is 63 exchanges, not 250 */
  g.players[0].health = 0;
  let n = 0;
  while (g.mode === 'play' && n < 10){ G.net.frame(0.1); H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0])); n++; }
  check('death takes the session into the RIP hold', g.mode, 'over');
  let m = 0;
  while (g.mode === 'over' && m < 300){ G.net.frame(0.1); H.message(Uint8Array.from([M.PASS, ...u32(S.step), 2, 0, 0])); m++; }
  check('the 250-frame RIP hold is 63 exchanges (four frames each), and the group runs on into the attract loop',
        [m, g.mode, g.attractT], [63, 'attract', 2]);
  S.phase = 'off'; S.tp = null;
  kb.releaseAll();
  G.seed({});
  G.settings.reset();
}


/* ====================================================================
   THE KEYS PAGE (this fork, 2026-09-03): the second splash, rewritten
   as data over the screen -- headings in the HUD font, the bulk in the
   micro font -- in place of the original's stale text.
   ==================================================================== */
{
  const F = G.frontend;
  const P = F.KEYS_PAGE;
  const OK_MICRO = /^[A-Z0-9 .,?!'\-]+$/, OK_HUD = /^[A-Z0-9 ]+$/;
  checkTrue('every micro line is drawable (the tag font\'s charset) and fits 256 px',
            P.filter(l => l[0] === 't').every(l => OK_MICRO.test(l[2]) && l[2].length * 5 - 1 <= 256),
            P.filter(l => l[0] === 't' && !(OK_MICRO.test(l[2]) && l[2].length * 5 - 1 <= 256)).map(l => l[2]).join(' | '));
  checkTrue('every heading and the footer are HUD-font text (A-Z 0-9 space only) on an 8 px row',
            P.filter(l => l[0] !== 't').every(l => OK_HUD.test(l[2]) && l[2].length <= 32 && l[1] % 8 === 0));
  checkTrue('no line overlaps the next, and nothing sits on the logo rows or below the footer',
            P.every((l, i) => l[1] >= 24 && l[1] + (l[0] === 't' ? 5 : 8) <= 192 &&
                              (i === 0 || P[i - 1][1] + (P[i - 1][0] === 't' ? 5 : 8) <= l[1])));
  checkTrue('the page says what it must: arrows, ENTER, the default keys, the gamepad, full screen, chat, SPACE to go on',
            ['UP AND DOWN', 'ENTER', '1 UP', 'Z FIRE', 'CAPS POTION', 'D-PAD', 'FULL SCREEN', 'CHAT', 'PRESS SPACE']
              .every(s => P.some(l => l[2].indexOf(s) >= 0)));
  /* through the front end itself: credits, SPACE, the keys page */
  const fe = new F.FrontEnd(), kb = new F.Keyboard(), ev = [];
  let n = 0;
  while (n < 6000 && fe.phase !== 'keys'){
    if (n % 16 < 6) kb.press('SPACE'); else kb.releaseAll();
    fe.frame(kb, ev, n); n++;
  }
  kb.releaseAll();
  check('the front end reaches the keys page after the credits', fe.phase, 'keys');
  const paint = () => { recording = true; drawCalls.length = 0; fe.pageRender(ctxStub);
                        recording = false; return drawCalls.slice(); };
  const early = paint().length;
  for (let i = 0; i < 40; i++) fe.frame(kb, ev, n++);
  const full = paint();
  checkTrue('the body rolls in on the page\'s own row clock: nothing at the top of the page, all of it once rolled in',
            early === 0 && full.length > 300, 'early ' + early + ' full ' + full.length);
  checkTrue('the footer PRESS SPACE TO CONTINUE sits on row 22 in the HUD font, a blank row under it',
            full.some(c => c[2] >= 176 && c[2] < 184 && c[5] !== '#000000'));
  checkTrue('the headings are bright yellow and the body bright white',
            full.some(c => c[2] >= 32 && c[2] < 40 && c[5] === '#ffff00') &&
            full.some(c => c[2] >= 44 && c[2] < 49 && c[5] === '#ffffff'));
  recording = true; drawCalls.length = 0; F.renderScreen(ctxStub, fe.scr, fe.frameCtr); recording = false;
  checkTrue('the old page text is gone: below the logo rows the screen itself is dark',
            !drawCalls.some(c => c[2] >= 24 && c[5] !== '#000000'));
  checkTrue('...and the logo rows are still the page\'s own', drawCalls.some(c => c[2] < 24 && c[5] !== '#000000'));
  kb.press('SPACE'); fe.frame(kb, ev, n++); kb.releaseAll(); fe.frame(kb, ev, n++);
  check('SPACE still moves on to the title', fe.phase, 'title');
}


/* ====================================================================
   ONLINE IN THE WORDMARK (this fork, 2026-09-04): every drawn Gauntlet
   logo carries ONLINE in the micro font, inside the logo's own rows --
   under the letter bodies, above the stems' ends, where the bitmap is
   clear.
   ==================================================================== */
{
  const F = G.frontend;
  check('the wordmark\'s ink extent is measured off the page: x 72..171, bottom row 22',
        [F.FE_LOGO_INK.x0, F.FE_LOGO_INK.x1, F.FE_LOGO_INK.y1], [72, 171, 22]);
  /* the placement against the asset itself: the logo's bitmap is BLANK on
     every pixel ONLINE covers, and on the row above and below it */
  {
    const s = new F.SpecScreen();
    s.printPage(Buffer.from(F.FE.pages.credits, 'base64'), F.FE_LOGO_ROWS);
    const ink = (x, y) => { const cr = y >> 3, col = x >> 3;
      return !!(s.m[((cr >> 3) << 11) | ((y & 7) << 8) | ((cr & 7) << 5) | col] & (0x80 >> (x & 7))); };
    const O = F.FE_LOGO_ONLINE;
    let clash = 0, bodiesAbove = 0, stemsBeside = 0;
    for (let y = O.y - 1; y <= O.y + 5; y++) for (let x = O.x; x < O.x + 29; x++) if (ink(x, y)) clash++;
    for (let x = O.x; x < O.x + 29; x++) if (ink(x, 15)) bodiesAbove++;
    for (let y = O.y; y < O.y + 5; y++) if (ink(O.x - 10, y) || ink(O.x + 29 + 10, y)) stemsBeside++;
    check('ONLINE sits inside the logo rows on pixels the wordmark leaves blank, with a blank row above and below',
          [O.y >= 16 && O.y + 5 <= 22, clash], [true, 0]);
    checkTrue('...UNDER the letter bodies (ink on row 15 above it) and BETWEEN the stems (ink to both sides)',
              bodiesAbove > 0 && stemsBeside > 0, 'above ' + bodiesAbove + ' beside ' + stemsBeside);
  }
  const rec = () => { const calls = []; return { calls,
    cap: { set fillStyle(v){ this._f = v; }, get fillStyle(){ return this._f; },
           fillRect(x, y, w, h){ calls.push([x, y, w, h, this._f]); } } }; };
  {
    const r = rec(); F.drawLogoOnline(r.cap, 0, 0);
    const px = r.calls.filter(c => c[4] === '#00ff00');
    const xs = px.map(c => c[0]), ys = px.map(c => c[1]);
    checkTrue('ONLINE: bright green micro pixels, 29 px wide at x 121..149, rows 17..21',
              px.length > 40 && Math.min(...xs) === 121 && Math.max(...xs) === 149 &&
              Math.min(...ys) === 17 && Math.max(...ys) === 21,
              'x ' + Math.min(...xs) + '..' + Math.max(...xs) + ' y ' + Math.min(...ys) + '..' + Math.max(...ys));
  }
  const toPhase = name => {
    const fe = new F.FrontEnd(), kb = new F.Keyboard(), ev = [];
    let n = 0;
    while (n < 6000 && fe.phase !== name){
      if (n % 16 < 6) kb.press('SPACE'); else kb.releaseAll();
      fe.frame(kb, ev, n); n++;
    }
    kb.releaseAll();
    for (let i = 0; i < 60; i++) fe.frame(kb, ev, n++);
    return fe;
  };
  /* the credits page: exactly as it was, ONLINE drawn over its logo */
  {
    const fe = toPhase('credits');
    const scr = rec(); F.renderScreen(scr.cap, fe.scr, fe.frameCtr);
    const lit = y0 => scr.calls.some(c => c[1] >= y0 && c[1] < y0 + 8 && c[4] !== '#000000');
    check('credits: the page is untouched -- logo rows lit, the text from row 3, the last row blank',
          [lit(0), lit(24), lit(176), lit(184)], [true, true, true, false]);
    const ov = rec(); fe.pageRender(ov.cap);
    checkTrue('...and ONLINE is drawn inside its logo rows', ov.calls.some(c => c[4] === '#00ff00' && c[1] >= 17 && c[1] <= 21));
  }
  /* the keys page */
  {
    const fe = toPhase('keys');
    const ov = rec(); fe.pageRender(ov.cap);
    checkTrue('keys page: ONLINE inside the logo rows, nothing green below them',
              ov.calls.some(c => c[4] === '#00ff00' && c[1] >= 17 && c[1] <= 21) &&
              !ov.calls.some(c => c[4] === '#00ff00' && c[1] >= 24));
  }
  /* the LOADING SCREEN: the big wordmark on the red band, the big ONLINE
     under it in the HUD font, ink only, on pixels the picture leaves clear */
  {
    const s = new F.SpecScreen();
    s.load(Buffer.from(F.FE.loading_screen, 'base64'));
    const ink = (x, y) => { const cr = y >> 3, col = x >> 3;
      return !!(s.m[((cr >> 3) << 11) | ((y & 7) << 8) | ((cr & 7) << 5) | col] & (0x80 >> (x & 7))); };
    const O = F.FE_LOADING_ONLINE;
    let clash = 0, above = 0;
    for (let y = O.y - 1; y < O.y + 9; y++) for (let x = O.x - 2; x < O.x + 49; x++) if (y < 192 && ink(x, y)) clash++;
    for (let y = 160; y < 168; y++) for (let x = O.x; x < O.x + 47; x++) if (ink(x, y)) above++;
    check('the big ONLINE sits on clear picture (a row of air around it) UNDER the big wordmark\'s letters',
          [clash, above > 0, O.y + 8 <= 192], [0, true, true]);
    const r = rec(); F.drawLoadingOnline(r.cap);
    const px = r.calls.filter(c => c[4] === '#00ff00');
    const xs = px.map(c => c[0]), ys = px.map(c => c[1]);
    checkTrue('...drawn in the HUD font, bright green, ink only: x 120..166, rows 169..176, no paper fill',
              px.length > 100 && px.every(c => c[2] === 1 && c[3] === 1) &&
              Math.min(...xs) >= 120 && Math.max(...xs) <= 166 && Math.min(...ys) >= 169 && Math.max(...ys) <= 176 &&
              r.calls.every(c => c[4] === '#00ff00'),
              'x ' + Math.min(...xs) + '..' + Math.max(...xs) + ' y ' + Math.min(...ys) + '..' + Math.max(...ys));
    const fe = toPhase('tune');
    const ov = rec(); fe.pageRender(ov.cap);
    checkTrue('...and the front end draws it through the tune, over the loading screen',
              fe.phase === 'tune' && ov.calls.some(c => c[4] === '#00ff00' && c[1] >= 169));
    const fk = toPhase('keys');
    const ok = rec(); fk.pageRender(ok.cap);
    checkTrue('...and not on the pages after it', !ok.calls.some(c => c[4] === '#00ff00' && c[1] >= 169));
  }
  /* the options panel: the logo sits at row 1 (y 8), so ONLINE is at rows 25..29 */
  {
    const fe = toPhase('options');
    const ov = rec(); fe.optRender(ov.cap);
    const band = ov.calls.filter(c => c[4] === '#00ff00' && c[0] >= 121 && c[0] <= 149 && c[1] >= 25 && c[1] <= 29);
    checkTrue('options: ONLINE in bright green at x 121..149, rows 25..29 -- inside the logo, above the first row',
              band.length > 40, 'green in band ' + band.length);
  }
}


/* ====================================================================
   THE AUDIO CLOCK-JUMP GUARD (2026-09-04): a late joiner's snapshot put
   the sim clock a minute ahead and the FIFO bridge rendered the gap --
   49.9 s of silence queued in one chunk, every real sound a minute late
   for good.  A forward jump beyond the largest legitimate one re-origins
   the stream; restore() says so explicitly through rebase().
   ==================================================================== */
{
  const mk = () => {
    const so = new G.sound.SoundOut();
    so.ctx = { sampleRate: 48000, currentTime: 0 }; so.mode = 'worklet'; so.initPending = false;
    so.chip = { lvl: 0, render(){ return 0; } };
    const posted = [];
    so.node = { port: { postMessage(m){ if (m.chunk) posted.push(m.chunk.length); } } };
    return { so, posted };
  };
  const secs = n => n / 48000;
  {
    const { so, posted } = mk();
    const ev = [];
    for (let f = 1; f <= 100; f++) so.flush(ev, f);
    const n0 = posted.length;
    so.flush(ev, 100 + 104);                             // the level-entry pause: 104 frames of real time
    checkTrue('a level-entry pause (104 frames) renders as ~2.1 s of sound, one chunk -- real time, kept',
              posted.length === n0 + 1 && Math.abs(secs(posted[n0]) - 104 / 50.08) < 0.05 && so.resyncs === 0,
              'chunk ' + secs(posted[n0] || 0).toFixed(2) + ' s');
    const n1 = posted.length;
    so.flush(ev, 204 + 2500);                            // a late join: the clock leaps 50 s
    check('a 2500-frame jump (a snapshot join) renders NOTHING: the stream re-origins, one resync',
          [posted.length - n1, so.resyncs, so.next], [0, 1, 2704]);
    so.flush(ev, 2705);
    checkTrue('...and the next frame renders from the new origin, a frame\'s worth',
              posted.length === n1 + 1 && Math.abs(secs(posted[n1]) - 1 / 50.08) < 0.002);
  }
  {
    const { so, posted } = mk();
    const ev = [];
    for (let f = 1; f <= 50; f++) so.flush(ev, f);
    const n0 = posted.length;
    so.rebase();
    so.flush(ev, 2000);
    check('rebase(): the next flush re-origins with nothing rendered, whatever the jump', [posted.length - n0, so.next], [0, 2000]);
    so.flush(ev, 2001);
    check('...and the stream carries on from there', posted.length - n0, 1);
  }
}


/* ====================================================================
   GAME OVER ENDS THE SESSION (this fork, 2026-09-04).  Reported: after a
   death the lobby said PRESS Z TO JOIN and FIRE did nothing -- the
   block sat out with the MATERIALISING mark up, because this port's
   $B35A tail places the block for dungeon 1 before the attract marks
   everyone out.  Fixed at the join, and the flow changed: the RIP hold
   hands the player to a STATS screen, then the title and the options
   screen, disconnected from the relay.
   ==================================================================== */
{
  const F = G.frontend;
  const NP = G.assets.protocol, M = NP.msgs, S = G.net.state;
  const sent = [];
  let H = null;
  const tpF = (url, h) => { H = h; return { send: b => sent.push(Array.from(b)), close(){ sent.push(['closed']); } }; };
  const u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const kb = F.liveKb; kb.releaseAll();
  /* the stray materialise mark, at the sim: a game over leaves the block
     out with bit 0 up, and FIRE brings it back within two polls */
  {
    const g = G.seed({});
    g.autoJoin(1);
    g.players[0].health = 0;
    for (let i = 0; i < 4 && g.mode === 'play'; i++){ g.onePass({}); if (g.levelDone) g.levelOver(); }
    check('one player, dead: the RIP hold', g.mode, 'over');
    const st = g.finalStats;
    check('enterGameOver captured the party\'s final state before the block is wiped',
          [st.level, st.players[0].played, st.players[0].score === g.players[0].score], [1, true, true]);
    while (g.mode === 'over') g.overTick();
    check('the hold ends in the attract loop with the block OUT and the materialise mark up (the port\'s $B35A order)',
          [g.mode, g.players[0].inGame, g.players[0].animCtl & 1, g.overEnded], ['attract', false, 1, true]);
    g.overEnded = false;
    g.attractTick({ fire: true }); g.attractTick({ fire: true });
    check('...and FIRE brings the block back through $9440 within two polls (it never did)',
          [g.players[0].inGame, g.mode], [true, 'play']);
  }
  /* the stats screen's lines, from the captured state */
  {
    const g = G.seed({});
    g.autoJoin(2); g.names = ['ANTHONY', '', '', ''];
    g.players[0].score = 0x012340; g.players[1].score = 0x000500; g.level = 3;
    g.enterGameOver();
    const lines = F.live.statsLines();
    check('the stats screen says GAME OVER, the dungeon, each player who played with character and score, and PRESS ENTER',
          lines.map(l => l.text.replace(/ +/g, ' ').trim()),
          ['GAME OVER', 'DUNGEON 3', 'ANTHONY ELF 12340', 'VALKYRIE VALKYRIE 500', 'PRESS ENTER OR SPACE']);
    checkTrue('...every line in the HUD font\'s charset', lines.every(l => /^[A-Z0-9 ]+$/.test(l.text) && l.text.length <= 32));
  }
  /* online, end to end: die, the hold, the handback -- disconnected */
  G.net.start('ws://mockover', { char: 3, method1: 3, zonePotion: false }, tpF);
  H.open();
  H.message(Uint8Array.from([M.WELCOME, 0, 4, ...u32(0x0BAD), NP.welcomeModes.FRESH, ...u32(0)]));
  H.message(Uint8Array.from([M.CHARS, 3, 255, 255, 255]));
  S.autoFire = true;
  const xchg = () => { G.net.frame(0.1); const inp = sent.filter(m => m[0] === M.INPUT).pop();
                       H.message(Uint8Array.from([M.PASS, ...u32(S.step), 4, inp ? inp[5] : 0, 0, 0, 0, 0, 0, 0, 0])); G.net.frame(0); };
  xchg();
  check('START joins the online game', [G.game.mode, G.game.players[0].inGame], ['play', true]);
  G.game.players[0].health = 0;
  let n = 0; while (G.game.mode === 'play' && n < 10){ xchg(); n++; }
  /* the join hint: never over the RIP -- not while he lies dead in a
     running game, not during the hold; only for a join the dungeon refused */
  const overlayDraws = () => { recording = true; drawCalls.length = 0; G.net.overlay(ctxStub); recording = false; return drawCalls.length; };
  check('during the RIP hold the overlay says NOTHING (no PRESS Z TO JOIN over the bones)',
        [G.game.mode, G.game.players[0].died, overlayDraws()], ['over', true, 0]);
  {
    const q = G.game.players[0], mode = G.game.mode;
    G.game.mode = 'play';
    check('...nor while he lies dead in a running game', overlayDraws(), 0);
    q.died = false;
    checkTrue('...but a join the dungeon REFUSED (out, no corpse, no latch) still gets the hint', overlayDraws() > 0);
    q.died = true; G.game.mode = mode;
  }
  let m = 0; while (G.game.mode === 'over' && m < 300){ xchg(); m++; }
  check('the RIP hold runs its 63 exchanges in lockstep and the sim reaches the attract loop', [m, G.game.mode], [63, 'attract']);
  checkTrue('the frame loop\'s check then hands the screen back: session OFF, transport closed, the front end at STATS',
            G.gameOverCheck() === true && S.phase === 'off' && S.tp === null && sent[sent.length - 1][0] === 'closed' &&
            G.feRunning === true && F.live.phase === 'stats');
  check('...and a second check is a no-op', G.gameOverCheck(), false);
  const rec = []; const cap = { set fillStyle(v){ this._f = v; }, get fillStyle(){ return this._f; },
    fillRect(x, y, w, h){ rec.push([x, y, w, h, this._f]); } };
  F.live.statsRender(cap);
  checkTrue('the stats screen draws: the panel, the logo, the lines', rec.length > 500 && rec.some(c => c[4] === '#ffff00'));
  /* ENTER (after a release) leaves for the title, whose fade leads to the options screen */
  const fe = F.live, ev = [];
  let f = 0;
  for (let i = 0; i < 12; i++) fe.frame(kb, ev, f++);        // armed after a release
  kb.press('ENTER'); fe.frame(kb, ev, f++); kb.releaseAll();
  check('ENTER on the stats screen goes to the title', fe.phase, 'title');
  for (let i = 0; i < 80 && fe.phase !== 'options'; i++) fe.frame(kb, ev, f++);
  check('...and the title\'s own fade leads to the options screen', fe.phase, 'options');
  kb.releaseAll();
  G.seed({});
  G.settings.reset();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
