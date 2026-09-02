/* netlag.js -- NETPLAN 2.3: the test shim that would have caught both
 * pipelining bugs.  A deterministic delay/jitter/loss transport for the
 * headless harness, plus a VIRTUAL RELAY that speaks the relay's own
 * protocol for one client, all on a VIRTUAL CLOCK the test advances.
 *
 *   const shim = makeLagShim(P, {rttMs: 120, jitterMs: 10, lossPct: 0, seed: 7});
 *   sandbox.performance = { now: () => shim.clock.now() };
 *   sandbox.setTimeout  = (fn, ms) => shim.clock.setTimeout(fn, ms);
 *   G.net.start('lag', cfg, shim.tpFactory);
 *   for (...) { shim.clock.advance(1000 / 60); G.net.frame(1 / 60); }
 *
 * Rules, all deliberate:
 *   - DETERMINISTIC: a seeded xorshift PRNG, never Math.random; a failing
 *     run reproduces exactly from its seed.
 *   - VIRTUAL CLOCK, never setTimeout: the test owns time, so a loaded CI
 *     box cannot make the result flaky, and a 60 s session runs in ms.
 *   - LOSS IS MODELLED THE WAY TCP SHOWS IT.  The transport under test is
 *     a WebSocket over TCP: a lost segment is not a dropped message but a
 *     retransmit -- that message AND everything behind it on the same
 *     direction arrives one RTO late (head-of-line blocking).  Reordering
 *     cannot reach the application at all, so there is no reorder knob;
 *     both directions are strictly FIFO here for the same reason.
 */
'use strict';

function prng(seed){
  let s = (seed >>> 0) || 0x9E3779B9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

class VClock {
  constructor(){ this.t = 0; this.q = []; this.seq = 0; this.ids = 0; }
  now(){ return this.t; }
  at(when, fn){ this.q.push({when, fn, seq: this.seq++}); }
  /* browsers clamp a timer to at least a millisecond; so does this clock
     (a sub-ms timer at t=1000 would land on t itself in floating point) */
  setTimeout(fn, ms){ this.at(this.t + Math.max(1, ms || 0), fn); return ++this.ids; }
  /* run every event due inside the next `ms`, in time order (ties in
     scheduling order), then land the clock on the end of the span */
  advance(ms){
    const end = this.t + ms;
    let fired = 0;
    for (;;){
      let best = -1;
      for (let i = 0; i < this.q.length; i++){
        const e = this.q[i];
        if (e.when > end) continue;
        if (best < 0 || e.when < this.q[best].when ||
            (e.when === this.q[best].when && e.seq < this.q[best].seq)) best = i;
      }
      if (best < 0) break;
      const e = this.q.splice(best, 1)[0];
      if (e.when > this.t) this.t = e.when;
      /* an event that re-schedules itself inside the same span forever
         is a bug in the thing under test, not in the clock: name it */
      if (++fired > 10000)
        throw new Error('VClock event storm: ' + fired + ' events inside one ' + ms +
                        ' ms span at t=' + this.t + ', ' + this.q.length + ' still queued');
      e.fn();
    }
    this.t = end;
  }
}

const u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const rd32 = (b, o) => (b[o] | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)) >>> 0;

/* one client, seat 0 of a two-seat FRESH session; seat 1 stays empty and
   is substituted 0x00 exactly as the real relay does.  Answers PING at
   once (the relay's own rule), stamps the trailing wait bytes, and logs
   every INPUT and PASS with its virtual timestamp for the gate. */
class VirtualRelay {
  constructor(P, clock){
    this.P = P; this.clock = clock;
    this.pass = 0; this.ready = false;
    this.hasIn = false; this.inDir = 0; this.inAt = 0;
    this.log = { inputs: [], passes: [], pings: 0 };
  }
  onMessage(b, deliver){
    const M = this.P.msgs, t = b[0];
    if (t === M.HELLO){
      deliver([M.WELCOME, 0, 2, ...u32(0xC0FFEE), this.P.welcomeModes.FRESH, ...u32(0)]);
      deliver([M.CHARS, b[2] & 3, 255, 255, 255]);
      deliver([M.NAMES].concat(new Array(this.P.maxSeats * this.P.nameLen).fill(32)));
      deliver([M.SEATS, 1]);
    } else if (t === M.READY){
      this.ready = true; this.advance(deliver);
    } else if (t === M.INPUT){
      const ip = rd32(b, 1);
      if (ip !== this.pass) return;                  // stale -- ignore
      this.hasIn = true; this.inDir = b[5]; this.inAt = this.clock.now();
      this.log.inputs.push({ pass: ip, dir: b[5], at: this.inAt });
      this.advance(deliver);
    } else if (t === M.PING){
      this.log.pings++;
      deliver([M.PONG, b[1], b[2], b[3], b[4]]);
    }
    /* FP, SNAPREQ, SNAP: nothing to arbitrate with one seat */
  }
  advance(deliver){
    if (!this.ready || !this.hasIn) return;
    const w = Math.min(255, Math.floor((this.clock.now() - this.inAt) / 4));
    deliver([this.P.msgs.PASS, ...u32(this.pass), 2, this.inDir, 0, w, 0]);
    this.log.passes.push({ pass: this.pass, at: this.clock.now() });
    this.pass++; this.hasIn = false;
  }
}

function makeLagShim(P, opts){
  opts = opts || {};
  const clock = new VClock();
  const rnd = prng(opts.seed || 1);
  const relay = new VirtualRelay(P, clock);
  const rtoMs = opts.rtoMs || 200;
  const oneWay = () => Math.max(0, (opts.rttMs || 0) / 2 +
                                    (opts.jitterMs ? (rnd() * 2 - 1) * opts.jitterMs : 0));
  const lane = { up: 0, down: 0 };            // FIFO: last delivery time per direction
  const stats = { sends: [], recvs: [] };
  let h = null;
  const post = (dir, delay, fn) => {
    let at = clock.now() + delay;
    if (opts.lossPct && rnd() * 100 < opts.lossPct) at += rtoMs;   // TCP: a retransmit, not a loss
    if (at < lane[dir]) at = lane[dir];                            // TCP: in order, always
    lane[dir] = at;
    clock.at(at, fn);
  };
  const tpFactory = (url, handler) => {
    h = handler;
    clock.at(clock.now(), () => h.open());
    return {
      send(bytes){
        const b = Uint8Array.from(bytes);
        stats.sends.push({ at: clock.now(), type: b[0], bytes: b });
        if (opts.onSend) opts.onSend(b, clock.now());
        post('up', oneWay(), () => relay.onMessage(b, out => {
          const ob = Uint8Array.from(out);
          post('down', oneWay(), () => {
            stats.recvs.push({ at: clock.now(), type: ob[0] });
            h.message(ob);
          });
        }));
      },
      close(){ if (h) h.close(); },
    };
  };
  return { clock, relay, tpFactory, stats };
}

module.exports = { makeLagShim, VClock, VirtualRelay, prng };
