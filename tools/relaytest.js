/* relaytest.js -- the relay's empirical gate.  Spawns the built server,
 * speaks real RFC 6455 WebSocket at it (own tiny client -- Node's net +
 * crypto -- so the test controls every frame byte), and plays the whole
 * protocol conversation from shared/PROTOCOL.md: seating, the fresh
 * boot, 100 lockstep passes with byte-order checks, the stall property,
 * fingerprint agreement and desync arbitration, the FULL refusal, a
 * disconnect with zero-substitution, a late join with a 20 KB snapshot
 * forwarded verbatim, and the orphaned-session reset.
 *
 *   node tools/relaytest.js [path\to\gauntlet-relay.exe]
 */
'use strict';
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
const EXE = process.argv[2] ||
  path.join(ROOT, 'server', 'build', 'gauntlet-relay.exe');
const P = require(path.join(ROOT, 'shared', 'protocol.json'));
const PORT = 33913;                       // a test port, not the shipped one
const M = P.msgs, E = P.errors, MODE = P.welcomeModes;

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
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- a WebSocket client small enough to trust ------------------------ */
class Ws {
  constructor(){ this.q = []; this.waiters = []; this.buf = Buffer.alloc(0);
                 this.closed = false; this.sock = null; }
  connect(port){
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const want = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      const s = this.sock = net.connect(port, '127.0.0.1');
      s.on('error', e => reject(e));
      let hs = '';
      const onHs = d => {
        hs += d.toString('latin1');
        const end = hs.indexOf('\r\n\r\n');
        if (end < 0) return;
        s.off('data', onHs);
        if (!/ 101 /.test(hs) || hs.indexOf(want) < 0)
          return reject(new Error('handshake refused: ' + hs.slice(0, 120)));
        const rest = Buffer.from(hs.slice(end + 4), 'latin1');
        s.on('data', d => this.onData(d));
        s.on('close', () => { this.closed = true; this.wake(); });
        if (rest.length) this.onData(rest);
        resolve(this);
      };
      s.on('data', onHs);
      s.on('connect', () => {
        s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
                'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                'Sec-WebSocket-Key: ' + key + '\r\n' +
                'Sec-WebSocket-Version: 13\r\n\r\n');
      });
    });
  }
  onData(d){
    this.buf = Buffer.concat([this.buf, d]);
    for (;;){
      const b = this.buf;
      if (b.length < 2) return;
      const op = b[0] & 0x0F;
      let len = b[1] & 0x7F, off = 2;
      if (len === 126){ if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127){ if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const pay = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      if (op === 0x8){ this.closed = true; this.wake(); continue; }
      if (op === 0x9){ this.frame(pay, 0xA); continue; }      // ping -> pong
      if (op === 0xA) continue;
      this.q.push(Buffer.from(pay));
      this.wake();
    }
  }
  wake(){ const ws = this.waiters.splice(0); for (const w of ws) w(); }
  frame(pay, op){
    const mask = crypto.randomBytes(4);
    const head = [0x80 | op];
    if (pay.length < 126) head.push(0x80 | pay.length);
    else if (pay.length < 65536){ head.push(0x80 | 126, pay.length >> 8, pay.length & 0xFF); }
    else {
      head.push(0x80 | 127);
      for (let i = 7; i >= 0; i--) head.push(Number((BigInt(pay.length) >> BigInt(8 * i)) & 0xFFn));
    }
    const masked = Buffer.from(pay);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([Buffer.from(head), mask, masked]));
  }
  send(pay){ this.frame(Buffer.from(pay), 0x2); }
  msg(type, ...parts){
    const bufs = [Buffer.from([type])];
    for (const p of parts){
      if (typeof p === 'number'){                       // u8
        bufs.push(Buffer.from([p & 0xFF]));
      } else if (p && p.u32 !== undefined){
        const b = Buffer.alloc(4); b.writeUInt32LE(p.u32 >>> 0); bufs.push(b);
      } else bufs.push(Buffer.from(p));                 // raw bytes
    }
    this.send(Buffer.concat(bufs));
  }
  /* next protocol message; SEATS broadcasts are skipped unless asked
     for, because they interleave with everything */
  async next(timeout, keepSeats){
    const t0 = Date.now();
    for (;;){
      while (this.q.length){
        const m = this.q.shift();
        if (m[0] === M.SEATS && !keepSeats) continue;
        return m;
      }
      if (this.closed) return null;
      const left = timeout - (Date.now() - t0);
      if (left <= 0) return null;
      await new Promise(r => { this.waiters.push(r); setTimeout(r, left); });
    }
  }
  async expect(type, timeout){
    const m = await this.next(timeout || 3000);
    if (!m) throw new Error('timed out waiting for type ' + type +
                            (this.closed ? ' (closed)' : ''));
    if (m[0] !== type) throw new Error('expected type ' + type + ', got ' + m[0] +
                                       ' [' + m.subarray(0, 12).join(',') + ']');
    return m;
  }
  async silent(ms){
    const m = await this.next(ms);
    if (m) throw new Error('expected silence, got type ' + m[0]);
  }
  close(){ if (this.sock) this.sock.destroy(); this.closed = true; }
}

/* ---- helpers over the message shapes --------------------------------- */
const u32 = { u32: 0 };
const U32 = v => ({ u32: v });
const rdWelcome = m => ({ seat: m[1], seats: m[2], seed: m.readUInt32LE(3),
                          mode: m[7], pass: m.readUInt32LE(8) });
const rdPass = m => ({ pass: m.readUInt32LE(1), n: m[5],
                       dirs: Array.from(m.subarray(6, 6 + m[5])) });

async function main(){
  console.log('relaytest: ' + EXE);
  const proc = spawn(EXE, ['--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', d => { out += d.toString(); });
  proc.stderr.on('data', d => { out += d.toString(); });
  const t0 = Date.now();
  while (!/RELAY LISTENING/.test(out)){
    if (Date.now() - t0 > 5000) throw new Error('server never listened: ' + out);
    await sleep(20);
  }
  checkTrue('the server starts and listens', /RELAY LISTENING 33913 seats=2/.test(out));

  try {
    /* ---- seating and the fresh boot -------------------------------- */
    const c0 = await new Ws().connect(PORT);
    c0.msg(M.HELLO, P.version);
    const w0 = rdWelcome(await c0.expect(M.WELCOME));
    check('first client seats at 0, fresh, pass 0',
          [w0.seat, w0.seats, w0.mode, w0.pass], [0, 2, MODE.FRESH, 0]);
    checkTrue('...with a nonzero buildSeed', w0.seed !== 0);

    const c1 = await new Ws().connect(PORT);
    c1.msg(M.HELLO, P.version);
    const w1 = rdWelcome(await c1.expect(M.WELCOME));
    check('second client seats at 1, still fresh (pass 0)',
          [w1.seat, w1.mode, w1.pass], [1, MODE.FRESH, 0]);
    check('...and both clients share the ONE buildSeed', w1.seed, w0.seed);

    /* the wrong protocol version is refused */
    const cv = await new Ws().connect(PORT);
    cv.msg(M.HELLO, P.version + 9);
    const ev = await cv.expect(M.ERROR);
    check('a wrong HELLO version gets ERROR VERSION', ev[1], E.VERSION);
    cv.close();

    /* ---- 100 lockstep passes, byte order checked -------------------- */
    c0.msg(M.READY, U32(0));
    c1.msg(M.READY, U32(0));
    let pass = 0, ok = 0;
    for (let i = 0; i < 100; i++){
      const b0 = (i * 3 + 1) & 0x3F, b1 = (i * 7 + 2) & 0x3F;
      c0.msg(M.INPUT, U32(pass), b0);
      c1.msg(M.INPUT, U32(pass), b1);
      const p0 = rdPass(await c0.expect(M.PASS));
      const p1 = rdPass(await c1.expect(M.PASS));
      if (p0.pass === pass && p1.pass === pass &&
          JSON.stringify(p0.dirs) === JSON.stringify([b0, b1]) &&
          JSON.stringify(p1.dirs) === JSON.stringify([b0, b1])) ok++;
      pass++;
    }
    check('100 passes relay both bytes to both clients, in seat order and in step',
          ok, 100);

    /* ---- pure lockstep: a missing input HOLDS the loop --------------- */
    c0.msg(M.INPUT, U32(pass), 0x11);
    await c0.silent(300);
    checkTrue('with one input missing the loop holds (no PASS inside 300ms)', true);
    c1.msg(M.INPUT, U32(pass), 0x22);
    const held = rdPass(await c0.expect(M.PASS));
    check('...and releases the moment it arrives', [held.pass, held.dirs], [pass, [0x11, 0x22]]);
    await c1.expect(M.PASS); pass++;

    /* ---- fingerprints: agreement is silent --------------------------- */
    c0.msg(M.FP, U32(pass - 1), U32(0xDEAD1234));
    c1.msg(M.FP, U32(pass - 1), U32(0xDEAD1234));
    await c0.silent(250); await c1.silent(50);
    checkTrue('matching fingerprints pass without comment', true);

    /* ---- a desync: minority notified, resynced via snapshot ---------- */
    c0.msg(M.FP, U32(pass - 1), U32(0xAAAA0001));
    c1.msg(M.FP, U32(pass - 1), U32(0xBBBB0002));
    const dm = await c1.expect(M.DESYNC);
    check('the tied vote goes to the LOWEST seat: seat 1 gets DESYNC',
          dm.readUInt32LE(1), pass - 1);
    await c0.expect(M.SNAPREQ);
    const resyncJson = Buffer.from(JSON.stringify({ v: 1, note: 'resync' }));
    c0.msg(M.SNAP, U32(pass), resyncJson);
    const sn = await c1.expect(M.SNAP);
    check('...the majority client is asked, and its snapshot arrives verbatim',
          [sn.readUInt32LE(1), sn.subarray(5).toString()],
          [pass, resyncJson.toString()]);
    c1.msg(M.READY, U32(pass));
    c0.msg(M.INPUT, U32(pass), 5); c1.msg(M.INPUT, U32(pass), 6);
    const pr = rdPass(await c0.expect(M.PASS));
    check('...and the loop resumes after the resynced READY', [pr.pass, pr.dirs], [pass, [5, 6]]);
    await c1.expect(M.PASS); pass++;

    /* ---- FULL -------------------------------------------------------- */
    const c2 = await new Ws().connect(PORT);
    c2.msg(M.HELLO, P.version);
    const e2 = await c2.expect(M.ERROR);
    check('a third client is refused: ERROR FULL (seats=2)', e2[1], E.FULL);
    c2.close();

    /* ---- a disconnect frees the seat and the loop substitutes 0 ------ */
    c1.close();
    await sleep(300);                     // let the server notice
    c0.msg(M.INPUT, U32(pass), 0x2A);
    const pd = rdPass(await c0.expect(M.PASS));
    check('after seat 1 disconnects its byte is substituted 0x00',
          [pd.pass, pd.dirs], [pass, [0x2A, 0]]);
    pass++;

    /* ---- late join: WELCOME(SNAPSHOT), 20 KB forwarded verbatim ------ */
    const c3 = await new Ws().connect(PORT);
    c3.msg(M.HELLO, P.version);
    const w3 = rdWelcome(await c3.expect(M.WELCOME));
    check('a late joiner takes the freed seat in SNAPSHOT mode at the live pass',
          [w3.seat, w3.mode, w3.pass], [1, MODE.SNAPSHOT, pass]);
    check('...same session, same seed', w3.seed, w0.seed);
    await c0.expect(M.SNAPREQ);
    const big = { v: 1, blob: 'x'.repeat(20000), pass };
    const bigJson = Buffer.from(JSON.stringify(big));
    c0.msg(M.SNAP, U32(pass), bigJson);
    const s3 = await c3.expect(M.SNAP, 5000);
    const gotJson = s3.subarray(5);
    check('a 20 KB snapshot crosses the relay intact (16-bit frame path)',
          [s3.readUInt32LE(1), gotJson.length,
           crypto.createHash('sha1').update(gotJson).digest('hex')],
          [pass, bigJson.length,
           crypto.createHash('sha1').update(bigJson).digest('hex')]);
    c3.msg(M.READY, U32(pass));
    for (let i = 0; i < 5; i++){
      c0.msg(M.INPUT, U32(pass), 1); c3.msg(M.INPUT, U32(pass), 2);
      const pp = rdPass(await c0.expect(M.PASS));
      check('post-join pass ' + i + ' needs BOTH inputs again',
            [pp.pass, pp.dirs], [pass, [1, 2]]);
      await c3.expect(M.PASS); pass++;
    }

    /* ---- orphaned session resets ------------------------------------- */
    c0.close(); c3.close();
    await sleep(300);
    const c4 = await new Ws().connect(PORT);
    c4.msg(M.HELLO, P.version);
    const w4 = rdWelcome(await c4.expect(M.WELCOME));
    check('with every seat emptied the session reset: next client is FRESH at pass 0',
          [w4.seat, w4.mode, w4.pass], [0, MODE.FRESH, 0]);
    c4.close();
  } finally {
    proc.kill();
  }

  console.log(`\n${checks - failures}/${checks} relay checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('ABORT: ' + (e.stack || e)); process.exit(1); });
