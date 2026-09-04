/* fourblock.js -- THE FOUR-BLOCK DEGENERACY FIXTURE (this fork).
 *
 * The sim grew from two player blocks to four (CLAUDE.md, planned work
 * 4).  Blocks 3 and 4 have NO Z80 reference -- the original never had
 * them -- so the gate is DEGENERACY, not faithfulness: with at most two
 * players in the game, the four-block sim must match the two-block sim
 * PASS FOR PASS.  This module holds the scenarios and the per-pass state
 * digest both sides use:
 *
 *   node tools/fourblock.js [built.html] [out.json]
 *                                  records build/_fourblock_ref.json from
 *                                  a BUILT client (run on the two-block
 *                                  build, once; the file is the reference
 *                                  -- `git show <two-block>:client/gauntlet.html`
 *                                  is where that build comes from now)
 *   tools/headless.js              replays the same scenarios on the
 *                                  current build and compares hash by hash
 *
 * The digest covers everything fingerprint() mixes for players 0-1 and
 * the shared state, plus the display-adjacent counters the two-player
 * gates print (frameSlot, the corpse marker), and the FIRST SIXTEEN ring
 * slots -- the two blocks' own.  Blocks 3/4 are deliberately not in it:
 * their inertness while out is a separate symmetry check. */
'use strict';

function fnv(s){
  let h = 0x811C9DC5;
  for (let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function digest(g){
  const P = g.players.slice(0, 2).map(q => [
    q.x, q.y, q.dir, q.health, q.score, q.keys, q.potions, q.timer, q.f11,
    q.p14, q.p15, q.levelOwn, q.animCtl & 0x0F, q.pend, q.pendCol, q.pendRow,
    q.exitCtr, q.millions, q.hoardKey, q.charIndex, q.shotTag, q.dead ? 1 : 0,
    q.shot.x, q.shot.y, q.shot.state, q.frameSlot, q.died ? 1 : 0,
    q.diedX, q.diedY, q.camX, q.camY, q.camTgtX, q.camTgtY, q.camLive ? 1 : 0,
    q.eBits, q.bannerBonus]);
  let mh = 0x811C9DC5;
  for (const row of g.map) for (const v of row){
    mh ^= v; mh = Math.imul(mh, 0x01000193) >>> 0;
  }
  return fnv(JSON.stringify([
    P,
    g.actors.map(a => [a.x, a.y, a.state, a.flags & 0x3F]),
    g.mshots.map(a => [a.x, a.y, a.state, a.flags]),
    Array.from(g.ring.slice(0, 64)),
    [g.camX, g.camY, g.camTgtX, g.camTgtY, g.passCtr, g.frameCtr, g.level,
     g.hurry, g.ff, g.drainPhase, g.rngState, g.brngState, g.srngState,
     g.levelDone ? 1 : 0, g.gameOver ? 1 : 0, g.mode, g.pass,
     g.potionArmed ? 1 : 0, g.potionBy, g.potionK, g.potionT, g.bannerCode,
     g.bannerBy, g.hoardCount, g.doorState, g.b3, g.treasure ? 1 : 0,
     g.overFrames, g.attractPage, g.f847E_bit0 ? 1 : 0, g.animCtr,
     g.animTick ? 1 : 0, g.introShow ? 1 : 0, g.bannerShow, g.tcd,
     g.forcedOver ? 1 : 0, g.hurryDoors ? 1 : 0, g.hurryExits ? 1 : 0],
    g.padList.map(p => [p.x, p.y, p.mask]),
    mh, g.drain, g.hoard,
  ]));
}

/* the walk every scenario uses: right, down, left, up in 20-pass legs,
   firing every 7th pass; `phase` shifts a second player off the first */
const walk = (i, phase) => {
  const t = (i + phase) % 80;
  return { right: t < 20, down: t >= 20 && t < 40,
           left: t >= 40 && t < 60, up: t >= 60, fire: (i % 7) === 0 };
};
const walk2 = (i, phase) => Object.assign(walk(i, phase), { fire: (i % 5) === 0 });

/* one tick of the driver: a pass in play, the level change when a pass
   ends the level, the RIP hold in 'over', the attract loop after it */
function tick(g, input){
  if (g.mode === 'play'){
    g.onePass(input);
    if (g.levelDone) g.levelOver();
  } else if (g.mode === 'over') g.overTick();
  else if (g.mode === 'attract') g.attractTick(input);
}

const duo = i => i < 10 ? walk(i, 0)
                : i === 10 ? Object.assign(walk(i, 0), { p2: { fire: true } })
                : Object.assign(walk(i, 0), { p2: walk2(i, 37) });

/* each scenario: name, cfg, optional jump, passes, input(i, g) */
const SCENARIOS = [
  { name: 'solo-d1', cfg: {}, passes: 260, input: i => walk(i, 0) },
  { name: 'solo-d1-online', cfg: { online: true }, passes: 200, input: i => walk(i, 0) },
  { name: 'duo-d1', cfg: {}, passes: 300, input: duo },
  { name: 'duo-d1-online', cfg: { online: true }, passes: 300, input: duo },
  { name: 'duo-d2', cfg: {}, jump: 2, passes: 200, input: duo },
  /* head-on, then a push, then the pushed one walks away: $AAC4's box,
     the contact bit, $A38A's order swap and both shove entries */
  { name: 'duo-shove', cfg: {}, passes: 260,
    input: i => {
      if (i < 10) return {};
      if (i === 10) return { p2: { fire: true } };
      if (i < 20) return {};
      if (i < 60) return { right: true, p2: { left: true } };
      if (i < 120) return { right: true, p2: {} };
      if (i < 180) return { p2: { down: true } };
      if (i < 220) return { up: true, p2: { up: true } };
      return { left: true, fire: (i % 3) === 0, p2: { right: true, fire: (i % 4) === 0 } };
    } },
  /* player 1 dies with player 2 alive (the actors' one-pass aim at a
     corpse, the drop, the RIP marker), then player 2 dies too: the
     game-over chain, the hold, the new game's attract loop */
  /* 371 passes, not 420: the reference ran on into the attract loop, but
     the two-block build left the block out with the MATERIALISING mark
     up (its $B35A tail places the block before the attract marks it
     out) and the four-block build spends that mark on the first attract
     poll (2026-09-04, the FIRE-does-nothing fix) -- so the comparison
     ends with the hold, pass 371, and the fix is pinned on its own */
  { name: 'duo-death', cfg: {}, passes: 371,
    input: (i, g) => {
      if (i === 60) g.players[0].health = 0;
      if (i === 120) g.players[1].health = 0;
      /* no FIRE from a corpse: the four-block build lets a dead player
         rejoin on FIRE (the retired entry's mark is spent), the two-block
         build never did -- that fix is pinned on its own, not here */
      const d = duo(i);
      if (i > 60) d.fire = false;
      if (i > 120 && d.p2) d.p2.fire = false;
      return d;
    } },
];

/* run one scenario on a client's G; returns the per-pass hashes */
function runScenario(G, sc){
  G.game.reset(sc.cfg);
  const g = G.game;
  if (sc.jump) g.jumpToLevel(sc.jump);
  const out = [];
  for (let i = 0; i < sc.passes; i++){
    tick(g, sc.input(i, g) || {});
    out.push(digest(g));
  }
  return out;
}

/* a pristine sandbox of a built client -- the recorder's and the suite's
   replays both run here, so neither carries state the other lacks */
function loadClient(file){
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const ctxStub = { set fillStyle(v){}, get fillStyle(){ return null; }, fillRect(){} };
  const els = new Map();
  const makeEl = id => { const set = new Set(); return { id, _text: '', innerHTML: '',
    get textContent(){ return this._text; }, set textContent(v){ this._text = String(v); },
    getContext(){ return ctxStub; }, style: {},
    classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) },
    blur(){}, focus(){}, width: 256, height: 192 }; };
  const sandbox = { console, atob: s => Buffer.from(s, 'base64').toString('binary'),
    document: { getElementById(id){ if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); } },
    addEventListener(){}, requestAnimationFrame(){ return 1; },
    localStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} },
    Math, JSON, Uint8Array, Buffer, String, Number, Array, Object, Error, Date };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const html = fs.readFileSync(file, 'utf8');
  const jsonMatch = html.match(/<script type="application\/json" id="assets">([\s\S]*?)<\/script>/);
  els.set('assets', Object.assign(makeEl('assets'),
    { _text: jsonMatch[1].split('<' + String.fromCharCode(92) + '/').join('</') }));
  const codeMatch = html.match(/<script>([\s\S]*?)<\/script>\s*$/);
  vm.runInContext(codeMatch[1], sandbox, { filename: path.basename(file) });
  const G = sandbox.globalThis.__GAUNTLET__;
  /* the sandbox itself, for probes that need to install a clock, a
     setTimeout or document.hidden -- non-enumerable, the client's own
     object is untouched otherwise */
  Object.defineProperty(G, '__sandbox', { value: sandbox, enumerable: false });
  return G;
}

module.exports = { SCENARIOS, digest, runScenario, tick, loadClient };

if (require.main === module){
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.dirname(__dirname);
  /* node tools/fourblock.js [built.html] [out.json] */
  const G = loadClient(process.argv[2] || path.join(ROOT, 'client', 'gauntlet.html'));
  const ref = { _source: 'tools/fourblock.js on the two-block build; the degeneracy reference',
                blocks: G.game.players.length, scenarios: {} };
  for (const sc of SCENARIOS){
    const h = runScenario(G, sc);
    ref.scenarios[sc.name] = h;
    const p1 = G.game.players[0], p2 = G.game.players[1];
    console.log(sc.name.padEnd(16), h.length, 'passes, mode at end', G.game.mode,
                'p1', [p1.x, p1.y, p1.inGame], 'p2', [p2.x, p2.y, p2.inGame],
                'actors', G.game.actors.length, 'level', G.game.level);
  }
  const out = process.argv[3] || path.join(ROOT, 'build', '_fourblock_ref.json');
  fs.writeFileSync(out, JSON.stringify(ref));
  console.log('wrote', out);
}
