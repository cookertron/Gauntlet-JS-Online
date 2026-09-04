/* uishot.js -- the HUD and the options screen, as PNGs.
 *
 *   node tools/uishot.js [outdir]
 *
 * Reuses the built artifact's own render()/optRender() the same way
 * dungeonshot.js does, at full screen resolution (256x192, HUD included)
 * rather than dungeonshot's playfield-only camera scan.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.dirname(__dirname);
const BUILT = path.join(ROOT, 'client', 'gauntlet.html');

/* ---------- minimal DOM stub, lifted from headless.js ------------------ */
const ctxStub = {
  set fillStyle(v) { this._fill = v; },
  get fillStyle() { return this._fill; },
  fillRect() {},
};
function makeEl(id) {
  const set = new Set();
  return {
    id, _text: '', innerHTML: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    getContext() { return ctxStub; },
    style: {}, classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) },
    blur() {}, focus() {},
    width: 256, height: 192,
  };
}
const els = new Map();
const sandbox = {
  console,
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  document: { getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); } },
  addEventListener() {},
  requestAnimationFrame() { return 1; },
  Math, JSON, Uint8Array, Buffer, String, Number, Array, Object, Error,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const html = fs.readFileSync(BUILT, 'utf8');
const jsonMatch = html.match(/<script type="application\/json" id="assets">([\s\S]*?)<\/script>/);
els.set('assets', Object.assign(makeEl('assets'), { _text: jsonMatch[1].split('<' + String.fromCharCode(92) + '/').join('</') }));
const codeMatch = html.match(/<script>([\s\S]*?)<\/script>\s*$/);
vm.runInContext(codeMatch[1], sandbox, { filename: 'gauntlet.html' });
const G = sandbox.globalThis.__GAUNTLET__;

/* ---------- PNG encoder, lifted from dungeonshot.js --------------------- */
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
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, {level: 9})),
    chunk('IEND', Buffer.alloc(0))]);
}
function hex(c){
  if (!c || c[0] !== '#') return [0,0,0];
  if (c.length === 4) return [parseInt(c[1]+c[1],16), parseInt(c[2]+c[2],16), parseInt(c[3]+c[3],16)];
  return [parseInt(c.slice(1,3),16), parseInt(c.slice(3,5),16), parseInt(c.slice(5,7),16)];
}
const W = 256, H = 192;
/* scale up 3x -- native res is legible on a real screen, but tiny in a
   chat thumbnail; nearest-neighbour keeps every pixel a sharp square,
   which a Spectrum picture should be. */
const SCALE = 3;
function shoot(drawFn){
  const buf = Buffer.alloc(W * H * 3);
  const cap = {
    set fillStyle(v){ this._c = hex(v); }, get fillStyle(){ return this._f; },
    fillRect(x, y, w, h){
      for (let yy = Math.max(0,y); yy < Math.min(H,y+h); yy++)
        for (let xx = Math.max(0,x); xx < Math.min(W,x+w); xx++){
          const o = (yy * W + xx) * 3, c = this._c || [0,0,0];
          buf[o] = c[0]; buf[o+1] = c[1]; buf[o+2] = c[2];
        }
    } };
  drawFn(cap);
  const out = Buffer.alloc(W*SCALE * H*SCALE * 3);
  for (let y = 0; y < H*SCALE; y++)
    for (let x = 0; x < W*SCALE; x++){
      const so = (Math.floor(y/SCALE) * W + Math.floor(x/SCALE)) * 3;
      const o = (y * W*SCALE + x) * 3;
      out[o] = buf[so]; out[o+1] = buf[so+1]; out[o+2] = buf[so+2];
    }
  return out;
}
function save(outdir, name, drawFn){
  fs.writeFileSync(path.join(outdir, name), encodePng(W*SCALE, H*SCALE, shoot(drawFn)));
  console.log('SHOT ' + name);
}

const outdir = process.argv[2] || path.join(ROOT, 'build', 'ui');
fs.mkdirSync(outdir, {recursive: true});

/* ---------- a populated HUD --------------------------------------------- */
const g = G.seed({});
g.mode = 'play';
g.jumpToLevel(1);
g.introShow = null; g.bannerShow = null;
const q = g.players[0];
q.health = 0x1500;      // packed BCD, all nibbles valid digits
q.score  = 0x123450;
q.keys = 5; q.potions = 3;
q.p14 = 0x3F;            // in game (bit 7 clear), all six inventory icons lit
g.autoJoin(4);           // FOUR players in and adjacent: tags show on a MEETING
g.names[0] = 'ANTHONY';  // an unset name wears the character's own
g.names[2] = 'NITRO 5';
g.players[1].score = 0x004200; g.players[1].keys = 1;
g.players[2].score = 0x017350; g.players[2].health = 0x0850; g.players[2].potions = 2;
g.players[3].score = 0x000090; g.players[3].keys = 12; g.players[3].p14 |= 0x05;
save(outdir, 'hud.png', cap => G.render(cap, g));
/* ---------- speech bubbles: two lines over one player, one over another,
   the third's stacked under a name tag ----------------------------------- */
{
  const c = G.seed({});
  c.mode = 'play'; c.jumpToLevel(1); c.introShow = null; c.bannerShow = null;
  c.autoJoin(4); c.names[0] = 'ANTHONY'; c.names[2] = 'NITRO 5';
  for (let i = 0; i < 12; i++) c.onePass({ down: true, p2: { down: true, right: true },
                                          p3: { down: true }, p4: { down: true, right: true } });
  c.chat[0] = { text: 'THE QUICK BROWN FOX JUMPS OVER', until: Infinity };
  c.chat[1] = { text: 'HI ALL!', until: Infinity };
  c.chat[3] = { text: 'WHO HAS THE KEY?', until: Infinity };
  save(outdir, 'chat.png', cap => G.render(cap, c));
}
/* ...and the same band with two seats empty: an out block's quarter is blank */
{
  const g2 = G.seed({});
  g2.mode = 'play'; g2.jumpToLevel(1); g2.introShow = null; g2.bannerShow = null;
  g2.autoJoin(2); g2.names[0] = 'ANTHONY';
  save(outdir, 'hud2.png', cap => G.render(cap, g2));
}

/* ---------- death: the RIP hold over the frozen dungeon ----------------- */
{
  const d = G.seed({});
  d.names[0] = 'ANTHONY';
  d.health = 0;
  for (let i = 0; i < 6 && d.mode === 'play'; i++){
    d.onePass({});
    if (d.levelDone) d.levelOver();
  }
  save(outdir, 'rip.png', cap => G.render(cap, d));
}

/* ---------- the front end's pages: credits, then the keys page ---------- */
const F = G.frontend;
function toPhase(name){
  const fe = new F.FrontEnd(), kb = new F.Keyboard(), ev = [];
  let n = 0;
  while (n < 6000 && fe.phase !== name){
    if (n % 16 < 6) kb.press('SPACE'); else kb.releaseAll();
    fe.frame(kb, ev, n); n++;
  }
  kb.releaseAll();
  for (let i = 0; i < 40; i++) fe.frame(kb, ev, n++);   // the page rolls fully in
  return fe;
}
for (const name of ['credits', 'keys', 'title', 'tune']){
  const fe = toPhase(name);
  save(outdir, name + '.png', cap => { F.renderScreen(cap, fe.scr, fe.frameCtr);
                                       if (fe.pageRender) fe.pageRender(cap); });
}

/* ---------- the options screen, boot-time, replacing the old escape menu */
function toOptions(){
  const fe = new F.FrontEnd(), kb = new F.Keyboard(), ev = [];
  let n = 0;
  while (n < 6000 && fe.phase !== 'options'){
    if (n % 16 < 6) kb.press('SPACE'); else kb.releaseAll();
    fe.frame(kb, ev, n); n++;
  }
  kb.releaseAll(); fe.frame(kb, ev, n++);
  return {fe, kb, ev, n};
}
function optShot(name, setup){
  const {fe} = toOptions();
  if (setup) setup(fe);
  save(outdir, name, cap => { F.renderScreen(cap, fe.scr, fe.frameCtr); fe.optRender(cap); });
}

/* the ACTUAL boot state: untouched, 1 player, cursor on PLAYERS */
optShot('options-default.png', null);

/* mid-rebind: capture waiting on a key, the guided footer up */
optShot('options-rebind.png', fe => {
  fe.optSel = fe.optRows().findIndex(r => r.k === 'rebind');
  // activate REBIND the same way a real ENTER press would
  fe.frame(Object.assign(new F.Keyboard(), {held: new Set(['ENTER'])}), [], 99999);
});

/* a connected gamepad offered and taken for player 1 */
sandbox.navigator = { getGamepads: () => [
  {connected: true, id: 'Xbox Wireless Controller', axes: [0, 0], buttons: []}] };
optShot('options-controller.png', fe => {
  F.pollGamepads();
  const kb = Object.assign(new F.Keyboard(), {held: new Set(['8'])});
  fe.optSel = fe.optRows().findIndex(r => r.k === 'input' && r.p === 0);
  fe.frame(kb, [], 99999);
  fe.optSel = fe.optRows().findIndex(r => r.k === 'pad' && r.p === 0);
});
delete sandbox.navigator;
F.pollGamepads();

console.log('SHOT wrote 4 PNGs to ' + outdir);
