/* wsmini.js -- a WebSocket client small enough to trust, shared by
 * tools/relaytest.js (protocol conversations) and tools/e2etest.js (real
 * sims over the real relay).  Node net + crypto only; the test controls
 * every frame byte, which is the point.
 *
 * Two delivery modes: pull (await next()/expect(), relaytest) or push
 * (set ws.push = fn before/after connect, e2etest wiring it straight
 * into the client's transport handler). */
'use strict';
const net = require('net');
const crypto = require('crypto');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Ws {
  constructor(){ this.q = []; this.waiters = []; this.buf = Buffer.alloc(0);
                 this.closed = false; this.sock = null;
                 this.push = null; this.onclose = null; }
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
        s.on('close', () => { this.closed = true; this.wake();
                              if (this.onclose) this.onclose(); });
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
      if (op === 0x8){ this.closed = true; this.wake();
                       if (this.onclose) this.onclose(); continue; }
      if (op === 0x9){ this.frame(pay, 0xA); continue; }      // ping -> pong
      if (op === 0xA) continue;
      if (this.push){ this.push(Buffer.from(pay)); continue; }
      this.q.push(Buffer.from(pay));
      this.wake();
    }
  }
  wake(){ const ws = this.waiters.splice(0); for (const w of ws) w(); }
  frame(pay, op){
    const mask = crypto.randomBytes(4);
    const head = [0x80 | op];
    if (pay.length < 126) head.push(0x80 | pay.length);
    else if (pay.length < 65536) head.push(0x80 | 126, pay.length >> 8, pay.length & 0xFF);
    else {
      head.push(0x80 | 127);
      for (let i = 7; i >= 0; i--)
        head.push(Number((BigInt(pay.length) >> BigInt(8 * i)) & 0xFFn));
    }
    const masked = Buffer.from(pay);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([Buffer.from(head), mask, masked]));
  }
  send(pay){ this.frame(Buffer.from(pay), 0x2); }
  msg(type, ...parts){
    const bufs = [Buffer.from([type])];
    for (const p of parts){
      if (typeof p === 'number') bufs.push(Buffer.from([p & 0xFF]));
      else if (p && p.u32 !== undefined){
        const b = Buffer.alloc(4); b.writeUInt32LE(p.u32 >>> 0); bufs.push(b);
      } else bufs.push(Buffer.from(p));
    }
    this.send(Buffer.concat(bufs));
  }
  /* pull mode.  `skipType`: broadcast types the caller wants dropped. */
  async next(timeout, skipType){
    const t0 = Date.now();
    for (;;){
      while (this.q.length){
        const m = this.q.shift();
        if (skipType !== undefined && m[0] === skipType) continue;
        return m;
      }
      if (this.closed) return null;
      const left = timeout - (Date.now() - t0);
      if (left <= 0) return null;
      await new Promise(r => { this.waiters.push(r); setTimeout(r, left); });
    }
  }
  close(){ if (this.sock) this.sock.destroy(); this.closed = true; }
}

module.exports = { Ws, sleep };
