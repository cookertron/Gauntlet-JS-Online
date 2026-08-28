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
/* ===================================================================
   dungeonshot.js -- every element of a dungeon, as a PNG.

     node tools/dungeonshot.js [first] [last] [outdir]

   Defaults to dungeons 1..16 into build/dungeons/.

   THE WHOLE MAP, not a screenshot.  A Spectrum screen shows 16x10 of a
   32x32 dungeon, so a capture of the display is a quarter of the level.
   This scans the camera across the map, renders the PLAYFIELD at each
   position with the engine's own render() -- so the tiles, the objects,
   the actors and the player are drawn exactly as the game draws them,
   not re-invented here -- and composites the results into one 512x512
   image (32 cells x 4 units x 4 pixels).

   The camera positions overlap deliberately.  Actors are CULLED by
   distance from the camera ($B0FE), so an actor only paints while the
   camera is near it; overlapping steps guarantee every actor is drawn at
   least once.  Compositing is last-write-wins over identical content.

   Levels are reached with jumpToLevel(), which replays the game's own
   selection from the start -- so these are the dungeons that level has
   WHEN PLAYED STRAIGHT THROUGH, and the same one every run.  Level 8+
   dungeon selection is stateful (see selectAndBuild()'s own comment), so a
   player who WARPS there (level 1's $37/$38 tiles) reaches it with much
   less of the build stream spent and gets a different, equally genuine
   dungeon -- confirmed against the real Z80 by tools/warpgate.py.  These
   PNGs are the no-warps reference, not the only valid layout for a level.
   =================================================================== */
const fs2 = require('fs'), zlib = require('zlib'), path2 = require('path');

const CRC = (() => { const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c; } return t; })();
function crc32(buf){ let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0; }
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgb){
  const stride = w * 3, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++){
    raw[y * (stride + 1)] = 0;                       // filter type 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;                          // 8 bits, truecolour
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, {level: 9})),
    chunk('IEND', Buffer.alloc(0))]);
}

const UNIT_PX = 4;                                   // 1 map unit = 4 pixels
const MAP_UNITS = 128;                               // 32 cells x 4 units
const SIZE = MAP_UNITS * UNIT_PX;                    // 512
const VIEW_W = 256, VIEW_H = G.constants.PLAYFIELD_ROWS * 8;   // 256 x 160

function hex(c){
  if (c[0] !== '#') return [0,0,0];
  if (c.length === 4) return [parseInt(c[1]+c[1],16), parseInt(c[2]+c[2],16),
                              parseInt(c[3]+c[3],16)];
  return [parseInt(c.slice(1,3),16), parseInt(c.slice(3,5),16),
          parseInt(c.slice(5,7),16)];
}

function shoot(g){
  const buf = Buffer.alloc(SIZE * SIZE * 3);
  /* SKIP BLACK.  Every camera position repaints its whole background, so a
     later one would black out what an earlier one drew where they overlap --
     and they overlap on purpose, because actors are culled by distance and
     only paint while the camera is near them.  Black is the background here,
     so dropping it composites the ink from every position instead. */
  const put = (px, py, rgb) => {
    if (!rgb[0] && !rgb[1] && !rgb[2]) return;
    const x = ((px % SIZE) + SIZE) % SIZE, y = ((py % SIZE) + SIZE) % SIZE;
    const o = (y * SIZE + x) * 3;
    buf[o] = rgb[0]; buf[o+1] = rgb[1]; buf[o+2] = rgb[2];
  };
  let ox = 0, oy = 0;
  const cap = {
    set fillStyle(v){ this._c = hex(v); }, get fillStyle(){ return this._f; },
    fillRect(x, y, w, h){
      for (let yy = y; yy < y + h; yy++){
        if (yy < 0 || yy >= VIEW_H) continue;         // playfield only, no HUD
        for (let xx = x; xx < x + w; xx++){
          if (xx < 0 || xx >= VIEW_W) continue;
          put(ox + xx, oy + yy, this._c || [0,0,0]);
        }
      }
    } };
  /* Overlapping steps.  The viewport is 64 units across and 40 down, so
     camX 0 and 64 tile the 128-unit map exactly and 32 is pure overlap; camY
     needs 88 on the end or the last 8 units of the map are never in view --
     stepping by 20 to 80 stops at unit 120 and the map is 128. */
  for (const cy of [0, 20, 40, 60, 80, 88])
    for (const cx of [0, 32, 64]){
      g.camX = cx & 0x7F; g.camY = cy & 0x7F;
      ox = g.camX * UNIT_PX; oy = g.camY * UNIT_PX;
      G.render(cap, g);
    }
  return buf;
}

const argv = process.argv.slice(2);
const first = Number(argv[0]) || 1;
const last  = Number(argv[1]) || 16;
const outdir = argv[2] || path2.join(ROOT, 'build', 'dungeons');
fs2.mkdirSync(outdir, {recursive: true});

const g = G.seed({});
g.mode = 'play';
const made = [];
for (let lv = first; lv <= last; lv++){
  g.jumpToLevel(lv);
  /* jumpToLevel leaves the LEVEL-ENTRY SCREEN raised, exactly as arriving at
     the level does -- and render() paints it over the playfield, once per
     camera position.  The first run of this tool produced sixteen pictures of
     "LEVEL : 1" tiled over the dungeon.  Take both overlays down; we want the
     room, not the announcement. */
  g.introShow = null; g.bannerShow = null;
  const wall = (() => { let n = 0;
    for (let r = 0; r < 32; r++) for (let c = 0; c < 32; c++){
      const a = g.map[r][c] & 0x7F; if (a >= 1 && a <= 0x10) n++; }
    return n; })();
  const buf = shoot(g);
  const name = 'dungeon-' + String(lv).padStart(2, '0') +
               (g.treasure ? '-treasure' : '') + '.png';
  fs2.writeFileSync(path2.join(outdir, name), encodePng(SIZE, SIZE, buf));
  made.push(name);
  console.log('SHOT ' + name + '  ' + wall + ' wall cells, ' +
              g.actors.length + ' actors, mirror $84C7&3=' + (g.mirrorBits & 3) +
              (g.treasure ? '  TREASURE ROOM' : ''));
}
console.log('SHOT wrote ' + made.length + ' PNGs to ' + outdir);
