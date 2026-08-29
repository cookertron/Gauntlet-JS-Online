/* e2etest.js -- the whole stack, end to end: TWO real client sims (the
 * built gauntlet.html, each in its own vm sandbox) playing through the
 * real C++ relay over real WebSocket.  This is the proof that two
 * browser windows would play: fresh boot with the character table, the
 * attract lobby in lockstep, FIRE joining through $9440 on both sims at
 * once, movement, a disconnect, and a THIRD sim late-joining off the
 * live snapshot -- fingerprints compared between the actual Game objects
 * at every barrier.
 *
 *   node tools/e2etest.js [path\to\gauntlet-relay.exe]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { Ws, sleep } = require('./wsmini');

const ROOT = path.dirname(__dirname);
const EXE = process.argv[2] ||
  path.join(ROOT, 'server', 'build', 'gauntlet-relay.exe');
const BUILT = path.join(ROOT, 'client', 'gauntlet.html');
const PORT = 33917;

let checks = 0, failures = 0;
const check = (label, got, want) => {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('  ok    ' + label);
  else { failures++; console.log('  FAIL  ' + label + '  got ' + g + ' want ' + w); }
};
const checkTrue = (label, v, extra) => {
  checks++;
  if (v) console.log('  ok    ' + label);
  else { failures++; console.log('  FAIL  ' + label + (extra ? '  [' + extra + ']' : '')); }
};

/* ---- one sandboxed client, the uishot recipe ------------------------- */
const html = fs.readFileSync(BUILT, 'utf8');
const jsonMatch = html.match(/<script type="application\/json" id="assets">([\s\S]*?)<\/script>/);
const assetsText = jsonMatch[1].split('<' + String.fromCharCode(92) + '/').join('</');
const codeMatch = html.match(/<script>([\s\S]*?)<\/script>\s*$/);

function loadClient(name){
  const ctxStub = { set fillStyle(v){}, get fillStyle(){ return null; }, fillRect(){} };
  const els = new Map();
  const makeEl = id => {
    const set = new Set();
    return { id, _text: '', innerHTML: '',
      get textContent(){ return this._text; },
      set textContent(v){ this._text = String(v); },
      getContext(){ return ctxStub; }, style: {},
      classList: { add: c=>set.add(c), remove: c=>set.delete(c), contains: c=>set.has(c) },
      blur(){}, focus(){}, width: 256, height: 192 };
  };
  const sandbox = {
    console, atob: s => Buffer.from(s, 'base64').toString('binary'),
    document: { getElementById(id){ if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); } },
    addEventListener(){}, requestAnimationFrame(){ return 1; },
    localStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} },
    Math, JSON, Uint8Array, Buffer, String, Number, Array, Object, Error, Date,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  els.set('assets', Object.assign(makeEl('assets'), { _text: assetsText }));
  vm.runInContext(codeMatch[1], sandbox, { filename: name + '.html' });
  const G = sandbox.globalThis.__GAUNTLET__;
  return { name, G, kb: G.frontend.liveKb, net: G.net.state };
}

/* ---- a real-WebSocket transport for a sandboxed client --------------- */
function vmTransport(){
  return (url, h) => {
    const ws = new Ws();
    ws.push = m => h.message(new Uint8Array(m));
    ws.onclose = () => h.close();
    let open = false;
    const pending = [];
    ws.connect(PORT).then(() => {
      open = true;
      h.open();
      for (const b of pending) ws.send(Buffer.from(b));
    }).catch(() => h.close());
    return { send: b => { if (open) ws.send(Buffer.from(b)); else pending.push(b); },
             close: () => ws.close(),
             _ws: ws };
  };
}

/* pump every client's net frame and let the sockets breathe */
async function pump(clients, iters, dt){
  for (let i = 0; i < iters; i++){
    for (const c of clients) c.G.net.frame(dt === undefined ? 0.02 : dt);
    await sleep(2);
  }
}
/* pump until pred() -- polled between iterations -- or fail loudly */
async function until(clients, pred, label, iters){
  for (let i = 0; i < (iters || 800); i++){
    if (pred()) return true;
    for (const c of clients) c.G.net.frame(0.02);
    await sleep(2);
  }
  checkTrue(label, false, 'timed out');
  return false;
}
/* a lockstep barrier: both at the same step with nothing buffered --
   the moment their two Game objects are comparable byte for byte.
   frame(0) DRAINS deliveries without advancing the send clock, so the
   exchange quiesces instead of always having a PASS in flight (localhost
   answers inside the sleep, which starved the naive predicate). */
async function barrier(a, b, label){
  for (let i = 0; i < 1500; i++){
    a.G.net.frame(0); b.G.net.frame(0);
    if (a.net.step === b.net.step && !a.net.pendDirs && !b.net.pendDirs &&
        a.net.phase === 'live' && b.net.phase === 'live') return true;
    await sleep(2);
  }
  checkTrue(label + ' (barrier)', false, 'timed out');
  return false;
}

async function main(){
  console.log('e2etest: ' + EXE);
  const proc = spawn(EXE, ['--port', String(PORT)],
                     { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', d => { out += d.toString(); });
  proc.stderr.on('data', d => { out += d.toString(); });
  const t0 = Date.now();
  while (!/RELAY LISTENING/.test(out)){
    if (Date.now() - t0 > 5000) throw new Error('server never listened: ' + out);
    await sleep(20);
  }

  try {
    /* ---- A boots the session; B joins the LIVE lobby ------------------
       A's solo lobby is already stepping by the time B arrives, so B is
       a SNAPSHOT joiner even at the attract screen -- the design's own
       consequence: the character table froze with A's boot (his pick,
       plus the derived default for the empty seat), and B inherits the
       blocks as they stand.  The CHARS bump path is relaytest's to
       check; what matters here is that a mid-LOBBY join restores clean. */
    const A = loadClient('A'), B = loadClient('B');
    A.G.net.start('e2e', { char: 3, method1: 3, zonePotion: false }, vmTransport());
    await until([A], () => A.net.phase === 'live', 'client A goes live');
    B.G.net.start('e2e', { char: 3, method1: 3, zonePotion: false }, vmTransport());
    await until([A, B], () => B.net.phase === 'live',
                'client B snapshot-joins the live lobby');
    check('seats: A=0 B=1, two-seat session', [A.net.seat, B.net.seat, A.net.seats], [0, 1, 2]);
    check('one buildSeed', A.net.buildSeed === B.net.buildSeed, true);
    check('both sims field the SAME blocks: A\'s pick + the derived default',
          [A.G.game.players.map(q => q.charIndex), B.G.game.players.map(q => q.charIndex)],
          [[3, 1], [3, 1]]);
    check('both sims sit in the attract LOBBY',
          [A.G.game.mode, B.G.game.mode], ['attract', 'attract']);
    check('each displays its OWN window', [A.G.game.localIdx, B.G.game.localIdx], [0, 1]);

    await pump([A, B], 30);
    await barrier(A, B, 'attract lockstep');
    checkTrue('the lobby runs in lockstep: fingerprints equal at step ' + A.net.step,
              A.G.game.fingerprint() === B.G.game.fingerprint());

    /* ---- FIRE joins through $9440, on both sims at once --------------- */
    A.kb.press('Z');                                  // method 3 FIRE
    await until([A, B], () => A.G.game.mode === 'play' && B.G.game.mode === 'play',
                'FIRE takes both sims into play');
    A.kb.releaseAll();
    await barrier(A, B, 'post-join');
    check('player 1 is IN on both sims (the join-in model, over the wire)',
          [A.G.game.players[0].inGame, B.G.game.players[0].inGame], [true, true]);
    checkTrue('...fingerprints equal', A.G.game.fingerprint() === B.G.game.fingerprint());

    /* ---- movement relays ---------------------------------------------- */
    const x0 = A.G.game.players[0].x;
    A.kb.press('D');                                  // method 3 RIGHT
    await pump([A, B], 60);
    A.kb.releaseAll();
    await barrier(A, B, 'post-walk');
    checkTrue('the walk crossed the wire: player 1 moved on BOTH sims',
              A.G.game.players[0].x !== x0 &&
              A.G.game.players[0].x === B.G.game.players[0].x,
              'x ' + x0 + ' -> ' + A.G.game.players[0].x + '/' + B.G.game.players[0].x);
    checkTrue('...fingerprints equal', A.G.game.fingerprint() === B.G.game.fingerprint());

    /* ---- the second player joins from the second keyboard ------------- */
    B.kb.press('Z');
    await until([A, B], () => A.G.game.players[1].inGame && B.G.game.players[1].inGame,
                'B\'s FIRE joins player 2 on both sims');
    B.kb.releaseAll();
    await barrier(A, B, 'both in');
    checkTrue('two players in, fingerprints equal',
              A.G.game.fingerprint() === B.G.game.fingerprint());

    /* ---- B leaves; A plays on with the seat substituted 0 ------------- */
    const stepAtLeave = A.net.step;
    B.net.tp.close();
    await until([A], () => A.net.step > stepAtLeave + 5,
                'A keeps stepping after B disconnects');
    checkTrue('...and B\'s sim player still stands in A\'s game (bytes 0)',
              A.G.game.players[1].inGame === true);

    /* ---- C late-joins off the live snapshot --------------------------- */
    const C = loadClient('C');
    C.G.net.start('e2e', { char: 1, method1: 3, zonePotion: false }, vmTransport());
    await until([A, C], () => C.net.phase === 'live', 'client C restores and goes live', 2000);
    check('C took the freed seat and displays its window', [C.net.seat, C.G.game.localIdx], [1, 1]);
    await barrier(A, C, 'post-late-join');
    checkTrue('THE LATE JOIN: C\'s restored sim locksteps with A -- fingerprints equal at step ' + A.net.step,
              A.G.game.fingerprint() === C.G.game.fingerprint());
    checkTrue('...and C sees B\'s abandoned player standing where he was left',
              C.G.game.players[1].inGame === true);

    await pump([A, C], 40);
    await barrier(A, C, 'post-late-join play');
    checkTrue('...and they STAY in step over 40 more exchanges',
              A.G.game.fingerprint() === C.G.game.fingerprint());

    check('no desyncs anywhere', [A.net.desyncs, C.net.desyncs], [0, 0]);
    checkTrue('the relay never arbitrated a desync', out.indexOf('DESYNC') < 0);
  } finally {
    proc.kill();
  }

  console.log(`\n${checks - failures}/${checks} end-to-end checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('ABORT: ' + (e.stack || e)); process.exit(1); });
