/* =======================================================================
   gauntlet-relay -- the lockstep relay server.  shared/PROTOCOL.md is the
   contract; this file is its C++ half.
   =======================================================================
   WHAT THIS PROGRAM IS: a session owner and a byte relay.  It seats
   clients, advances the lockstep pass loop only when every seated READY
   client has delivered its one direction byte, broadcasts the collected
   bytes, compares the fingerprints the clients volunteer, and moves a
   state snapshot -- verbatim, never parsed -- from a healthy client to a
   joining or desynced one.

   WHAT IT DELIBERATELY IS NOT: a simulation.  It never runs the game,
   never looks inside a snapshot, and holds no game state beyond the pass
   number and the one shared buildSeed.  That is the whole reason it fits
   in one file with no dependencies beyond ws2_32.

   Browsers can only speak WebSocket, so the RFC 6455 server side is
   implemented here directly -- the handshake (SHA-1 + base64 of the
   key magic), the frame codec with client masking enforced, ping/pong,
   and continuation-frame assembly.  Single thread, select(), and a
   per-connection transmit queue so a 20 KB snapshot survives a
   non-blocking partial send.

   Build (see server/CMakeLists.txt, toolchain notes in CLAUDE.md):
     vcvars64 && cmake -S server -B server/build -G Ninja
              && ninja -C server/build
   Run:
     gauntlet-relay [--port 33792] [--seats 2]
   Test:
     node tools/relaytest.js server/build/gauntlet-relay.exe          */

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <memory>
#include <string>
#include <vector>

#pragma comment(lib, "ws2_32.lib")

/* ==== protocol constants -- MUST match shared/protocol.json ============
   tools/protocheck.py parses this block by the `= value;` on each line;
   change shared/protocol.json first, then here, and the checker holds
   the two together. */
constexpr uint8_t  PROTO_VERSION       = 1;
constexpr uint16_t DEFAULT_PORT        = 33792;
constexpr int      MAX_SEATS           = 4;
constexpr int      DEFAULT_SEATS       = 2;
constexpr uint32_t FP_EVERY            = 32;
constexpr uint32_t LIM_FRAME_MAX       = 262144;
constexpr uint32_t LIM_MESSAGE_MAX     = 1048576;
constexpr uint32_t LIM_HANDSHAKE_MAX   = 8192;
constexpr uint32_t LIM_INPUT_MS        = 10000;
constexpr uint32_t LIM_HANDSHAKE_MS    = 5000;
constexpr uint32_t LIM_SYNC_MS         = 15000;
constexpr uint8_t  MSG_HELLO           = 1;
constexpr uint8_t  MSG_WELCOME         = 2;
constexpr uint8_t  MSG_INPUT           = 3;
constexpr uint8_t  MSG_PASS            = 4;
constexpr uint8_t  MSG_FP              = 5;
constexpr uint8_t  MSG_DESYNC          = 6;
constexpr uint8_t  MSG_SNAPREQ         = 7;
constexpr uint8_t  MSG_SNAP            = 8;
constexpr uint8_t  MSG_READY           = 9;
constexpr uint8_t  MSG_SEATS           = 10;
constexpr uint8_t  MSG_ERROR           = 11;
constexpr uint8_t  ERR_FULL            = 1;
constexpr uint8_t  ERR_VERSION         = 2;
constexpr uint8_t  ERR_PROTOCOL        = 3;
constexpr uint8_t  ERR_ORPHANED        = 4;
constexpr uint8_t  MODE_FRESH          = 0;
constexpr uint8_t  MODE_SNAPSHOT       = 1;
/* ==== end protocol constants ======================================== */

/* ---- SHA-1, for the one thing a WebSocket server needs it for: the
   Sec-WebSocket-Accept digest.  Straight RFC 3174 arithmetic. ---------- */
struct Sha1 {
  uint32_t h[5]; uint64_t len; uint8_t buf[64]; size_t fill;
  Sha1(){ h[0]=0x67452301; h[1]=0xEFCDAB89; h[2]=0x98BADCFE;
          h[3]=0x10325476; h[4]=0xC3D2E1F0; len=0; fill=0; }
  static uint32_t rol(uint32_t v, int n){ return (v<<n)|(v>>(32-n)); }
  void block(const uint8_t* p){
    uint32_t w[80];
    for (int i=0;i<16;i++)
      w[i] = (uint32_t(p[i*4])<<24)|(uint32_t(p[i*4+1])<<16)
           | (uint32_t(p[i*4+2])<<8)|uint32_t(p[i*4+3]);
    for (int i=16;i<80;i++) w[i] = rol(w[i-3]^w[i-8]^w[i-14]^w[i-16],1);
    uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4];
    for (int i=0;i<80;i++){
      uint32_t f,k;
      if (i<20){ f=(b&c)|((~b)&d); k=0x5A827999; }
      else if (i<40){ f=b^c^d; k=0x6ED9EBA1; }
      else if (i<60){ f=(b&c)|(b&d)|(c&d); k=0x8F1BBCDC; }
      else { f=b^c^d; k=0xCA62C1D6; }
      uint32_t t = rol(a,5)+f+e+k+w[i];
      e=d; d=c; c=rol(b,30); b=a; a=t;
    }
    h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e;
  }
  void update(const void* data, size_t n){
    const uint8_t* p = (const uint8_t*)data; len += n;
    while (n){
      size_t take = 64-fill; if (take>n) take=n;
      memcpy(buf+fill, p, take); fill+=take; p+=take; n-=take;
      if (fill==64){ block(buf); fill=0; }
    }
  }
  void digest(uint8_t out[20]){
    uint64_t bits = len*8;
    uint8_t pad = 0x80; update(&pad,1);
    uint8_t z = 0; while (fill != 56) update(&z,1);
    uint8_t L[8]; for (int i=0;i<8;i++) L[i] = uint8_t(bits>>(56-8*i));
    update(L,8);
    for (int i=0;i<5;i++){
      out[i*4]=uint8_t(h[i]>>24); out[i*4+1]=uint8_t(h[i]>>16);
      out[i*4+2]=uint8_t(h[i]>>8); out[i*4+3]=uint8_t(h[i]);
    }
  }
};
static std::string base64(const uint8_t* p, size_t n){
  static const char* T =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string o;
  for (size_t i=0;i<n;i+=3){
    uint32_t v = uint32_t(p[i])<<16;
    if (i+1<n) v |= uint32_t(p[i+1])<<8;
    if (i+2<n) v |= uint32_t(p[i+2]);
    o += T[(v>>18)&63]; o += T[(v>>12)&63];
    o += (i+1<n) ? T[(v>>6)&63] : '=';
    o += (i+2<n) ? T[v&63] : '=';
  }
  return o;
}

/* ---- little-endian message building ---------------------------------- */
static void putU32(std::vector<uint8_t>& v, uint32_t x){
  v.push_back(uint8_t(x)); v.push_back(uint8_t(x>>8));
  v.push_back(uint8_t(x>>16)); v.push_back(uint8_t(x>>24));
}
static uint32_t getU32(const uint8_t* p){
  return uint32_t(p[0]) | (uint32_t(p[1])<<8)
       | (uint32_t(p[2])<<16) | (uint32_t(p[3])<<24);
}

/* ---- one connection --------------------------------------------------- */
struct Conn {
  SOCKET s = INVALID_SOCKET;
  bool open = true;
  bool closeAfterTx = false;      // an ERROR was queued; drain then close
  enum { HANDSHAKE, UP } state = HANDSHAKE;
  std::string hsBuf;              // the HTTP request, until \r\n\r\n
  std::vector<uint8_t> rx;        // raw bytes after the handshake
  std::vector<uint8_t> tx;        // pending frames, drained on writability
  bool fragActive = false;        // continuation-frame assembly
  std::vector<uint8_t> frag;
  int seat = -1;
  bool ready = false;             // sim booted/restored; counted by the loop
  bool hasInput = false;
  uint32_t inPass = 0; uint8_t inDir = 0;
  bool hasFp = false;
  uint32_t fpPass = 0, fpVal = 0;
  uint64_t bornMs = 0;            // for the handshake timeout
};

/* ---- the session ------------------------------------------------------ */
struct Relay {
  uint16_t port = DEFAULT_PORT;
  int seatsN = DEFAULT_SEATS;
  SOCKET lis = INVALID_SOCKET;
  std::vector<std::unique_ptr<Conn>> conns;
  int seat[MAX_SEATS];            // index into conns, or -1
  uint32_t pass = 0;
  uint32_t buildSeed = 0;
  uint64_t passStartMs = 0;       // when the current pass began waiting
  /* the one pause state: a snapshot in flight, for a joiner or a
     desynced client.  While syncing the loop holds; inputs already
     received keep their slots. */
  bool syncing = false;
  int provider = -1;              // conn index
  std::vector<int> targets;       // conn indices awaiting SNAP + their READY
  uint64_t syncStartMs = 0;
  std::deque<int> joinQueue;      // conn indices waiting for a sync slot

  Relay(){ for (int i=0;i<MAX_SEATS;i++) seat[i] = -1; }
  uint64_t now(){ return GetTickCount64(); }

  /* ---- socket plumbing ---- */
  void queueFrame(Conn& c, const uint8_t* p, size_t n, uint8_t op = 0x2){
    c.tx.push_back(uint8_t(0x80 | op));                 // FIN + opcode
    if (n < 126) c.tx.push_back(uint8_t(n));
    else if (n < 65536){
      c.tx.push_back(126);
      c.tx.push_back(uint8_t(n>>8)); c.tx.push_back(uint8_t(n));   // RFC: BE
    } else {
      c.tx.push_back(127);
      for (int i=7;i>=0;i--) c.tx.push_back(uint8_t(uint64_t(n)>>(8*i)));
    }
    c.tx.insert(c.tx.end(), p, p+n);
    flushTx(c);
  }
  void queueMsg(Conn& c, const std::vector<uint8_t>& m){
    queueFrame(c, m.data(), m.size());
  }
  void flushTx(Conn& c){
    while (c.open && !c.tx.empty()){
      int n = send(c.s, (const char*)c.tx.data(), (int)c.tx.size(), 0);
      if (n > 0){ c.tx.erase(c.tx.begin(), c.tx.begin()+n); continue; }
      if (n == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK) return;
      drop(c, "send failed"); return;
    }
    if (c.open && c.tx.empty() && c.closeAfterTx) drop(c, "error sent");
  }
  int indexOf(Conn& c){
    for (size_t i=0;i<conns.size();i++) if (conns[i].get() == &c) return (int)i;
    return -1;
  }

  /* ---- session membership ---- */
  uint8_t seatMask(){
    uint8_t m = 0;
    for (int i=0;i<seatsN;i++) if (seat[i] >= 0) m |= uint8_t(1<<i);
    return m;
  }
  void broadcastSeats(){
    std::vector<uint8_t> m; m.push_back(MSG_SEATS); m.push_back(seatMask());
    for (auto& c : conns) if (c->open && c->state == Conn::UP && c->seat >= 0)
      queueMsg(*c, m);
  }
  void sendError(Conn& c, uint8_t code){
    std::vector<uint8_t> m; m.push_back(MSG_ERROR); m.push_back(code);
    queueMsg(c, m);
    c.closeAfterTx = true;
    flushTx(c);
  }
  void drop(Conn& c, const char* why){
    if (!c.open) return;
    c.open = false;
    closesocket(c.s);
    printf("[relay] drop seat=%d (%s)\n", c.seat, why); fflush(stdout);
    int idx = indexOf(c);
    if (c.seat >= 0){ seat[c.seat] = -1; c.seat = -1; }
    if (syncing){
      for (size_t i=0;i<targets.size();i++)
        if (targets[i] == idx){ targets.erase(targets.begin()+i); break; }
      if (provider == idx){
        provider = pickProvider();
        if (provider < 0) orphanTargets();
        else { std::vector<uint8_t> m; m.push_back(MSG_SNAPREQ);
               queueMsg(*conns[provider], m); }
      }
      if (targets.empty()) syncing = false;
    }
    for (size_t i=0;i<joinQueue.size();i++)
      if (joinQueue[i] == idx){ joinQueue.erase(joinQueue.begin()+i); break; }
    /* every seat empty: the state died with the clients.  Reset to a
       fresh session; anyone still queued mid-sync is orphaned. */
    if (seatMask() == 0 && pass != 0){
      printf("[relay] session orphaned at pass %u -- reset\n", pass);
      fflush(stdout);
      pass = 0; syncing = false; provider = -1;
      buildSeed = freshSeed();
      orphanTargets();
      while (!joinQueue.empty()){
        int j = joinQueue.front(); joinQueue.pop_front();
        if (conns[j]->open) sendError(*conns[j], ERR_ORPHANED);
      }
    }
    broadcastSeats();
    tryAdvance();
  }
  void orphanTargets(){
    for (int t : targets) if (conns[t]->open) sendError(*conns[t], ERR_ORPHANED);
    targets.clear(); syncing = false;
  }
  uint32_t freshSeed(){
    uint32_t v = uint32_t(GetTickCount64());
    v ^= uint32_t(uintptr_t(this) >> 4);
    v = v*1103515245u + 12345u;
    return v ? v : 0x13579BDFu;
  }
  int pickProvider(){
    /* the lowest seat that is READY, clean and not itself a sync target */
    for (int i=0;i<seatsN;i++){
      int idx = seat[i];
      if (idx < 0 || !conns[idx]->open || !conns[idx]->ready) continue;
      bool tgt = false;
      for (int t : targets) if (t == idx) tgt = true;
      if (!tgt) return idx;
    }
    return -1;
  }

  /* ---- the sync flow: one snapshot in flight at a time ---- */
  void startSyncIfDue(){
    if (syncing || joinQueue.empty()) return;
    int joiner = joinQueue.front();
    if (!conns[joiner]->open){ joinQueue.pop_front(); return startSyncIfDue(); }
    provider = pickProvider();
    if (provider < 0){
      /* nobody can provide -- only reachable when the session emptied
         between WELCOME and here; the joiner reconnects fresh */
      joinQueue.pop_front();
      sendError(*conns[joiner], ERR_ORPHANED);
      return;
    }
    joinQueue.pop_front();
    syncing = true; targets.assign(1, joiner); syncStartMs = now();
    std::vector<uint8_t> m; m.push_back(MSG_SNAPREQ);
    queueMsg(*conns[provider], m);
    printf("[relay] sync: provider seat=%d -> joiner seat=%d at pass %u\n",
           conns[provider]->seat, conns[joiner]->seat, pass); fflush(stdout);
  }

  /* ---- the lockstep loop ---- */
  bool advancing = false, advanceAgain = false;
  void tryAdvance(){
    /* a drop() fired from inside the broadcast (a send failing) lands
       back here through its own tryAdvance; the latch turns recursion
       into one more turn of the outer loop */
    if (advancing){ advanceAgain = true; return; }
    advancing = true;
    do { advanceAgain = false; advanceOnce(); } while (advanceAgain);
    advancing = false;
  }
  void advanceOnce(){
    for (;;){
      if (syncing) return;
      /* every seated client must be READY (booting clients hold the
         loop; the handshake/input timeouts bound how long) and must
         have this pass's byte. */
      uint8_t dirs[MAX_SEATS] = {0,0,0,0};
      for (int i=0;i<seatsN;i++){
        int idx = seat[i];
        if (idx < 0) continue;                         // empty: 0x00
        Conn& c = *conns[idx];
        if (!c.ready) return;
        if (!c.hasInput || c.inPass != pass) return;
        dirs[i] = c.inDir;
      }
      if (seatMask() == 0) return;                     // nobody to advance for
      std::vector<uint8_t> m; m.push_back(MSG_PASS);
      putU32(m, pass);
      m.push_back(uint8_t(seatsN));
      for (int i=0;i<seatsN;i++) m.push_back(dirs[i]);
      for (auto& c : conns)
        if (c->open && c->state == Conn::UP && c->seat >= 0 && c->ready)
          queueMsg(*c, m);
      pass++;
      passStartMs = now();
      for (auto& c : conns) c->hasInput = false;
    }
  }

  /* ---- fingerprint arbitration ---- */
  void checkFp(){
    /* act once EVERY seated ready client has reported the same pass */
    uint32_t want = 0; bool first = true;
    for (int i=0;i<seatsN;i++){
      int idx = seat[i];
      if (idx < 0 || !conns[idx]->ready) continue;
      Conn& c = *conns[idx];
      if (!c.hasFp) return;
      if (first){ want = c.fpPass; first = false; }
      else if (c.fpPass != want) return;               // windows not aligned yet
    }
    if (first) return;                                 // nobody seated
    /* majority value; a tie goes to the lowest seat */
    uint32_t winner = 0; int best = -1;
    for (int i=0;i<seatsN;i++){
      int idx = seat[i];
      if (idx < 0 || !conns[idx]->ready) continue;
      uint32_t v = conns[idx]->fpVal; int n = 0;
      for (int j=0;j<seatsN;j++){
        int jdx = seat[j];
        if (jdx >= 0 && conns[jdx]->ready && conns[jdx]->fpVal == v) n++;
      }
      if (n > best){ best = n; winner = v; }           // lowest seat wins ties
    }
    std::vector<int> bad;
    for (int i=0;i<seatsN;i++){
      int idx = seat[i];
      if (idx < 0 || !conns[idx]->ready) continue;
      if (conns[idx]->fpVal != winner) bad.push_back(idx);
    }
    for (int i=0;i<seatsN;i++){
      int idx = seat[i];
      if (idx >= 0) conns[idx]->hasFp = false;
    }
    if (bad.empty()) return;
    printf("[relay] DESYNC at pass %u: %d client(s) off the majority\n",
           want, (int)bad.size()); fflush(stdout);
    /* the desynced clients leave the loop and re-enter through the same
       snapshot flow a joiner uses */
    for (int idx : bad){
      Conn& c = *conns[idx];
      c.ready = false; c.hasInput = false;
      std::vector<uint8_t> m; m.push_back(MSG_DESYNC); putU32(m, want);
      queueMsg(c, m);
      joinQueue.push_back(idx);
    }
    startSyncIfDue();
  }

  /* ---- protocol messages ---- */
  void onMessage(Conn& c, const uint8_t* p, size_t n){
    if (n < 1){ drop(c, "empty message"); return; }
    uint8_t t = p[0]; p++; n--;
    switch (t){
      case MSG_HELLO: {
        if (n < 1 || p[0] != PROTO_VERSION){ sendError(c, ERR_VERSION); return; }
        if (c.seat >= 0){ drop(c, "double HELLO"); return; }
        int s = -1;
        for (int i=0;i<seatsN;i++) if (seat[i] < 0){ s = i; break; }
        if (s < 0){ sendError(c, ERR_FULL); return; }
        if (seatMask() == 0 && pass == 0) buildSeed = freshSeed();
        seat[s] = indexOf(c); c.seat = s; c.ready = false;
        uint8_t mode = (pass == 0) ? MODE_FRESH : MODE_SNAPSHOT;
        std::vector<uint8_t> m; m.push_back(MSG_WELCOME);
        m.push_back(uint8_t(s)); m.push_back(uint8_t(seatsN));
        putU32(m, buildSeed); m.push_back(mode); putU32(m, pass);
        queueMsg(c, m);
        printf("[relay] seat %d taken (%s, pass %u)\n", s,
               mode == MODE_FRESH ? "fresh" : "snapshot", pass);
        fflush(stdout);
        if (mode == MODE_SNAPSHOT){
          joinQueue.push_back(indexOf(c));
          startSyncIfDue();
        }
        broadcastSeats();
        break;
      }
      case MSG_READY: {
        if (c.seat < 0){ drop(c, "READY unseated"); return; }
        c.ready = true;
        if (syncing){
          int idx = indexOf(c);
          for (size_t i=0;i<targets.size();i++)
            if (targets[i] == idx){ targets.erase(targets.begin()+i); break; }
          if (targets.empty()){ syncing = false; provider = -1; }
        }
        passStartMs = now();
        startSyncIfDue();
        tryAdvance();
        break;
      }
      case MSG_INPUT: {
        if (n < 5 || c.seat < 0){ drop(c, "bad INPUT"); return; }
        uint32_t ip = getU32(p);
        if (ip != pass) break;        // stale (a pass it already got) -- ignore
        c.hasInput = true; c.inPass = ip; c.inDir = p[4];
        tryAdvance();
        break;
      }
      case MSG_FP: {
        if (n < 8 || c.seat < 0){ drop(c, "bad FP"); return; }
        c.hasFp = true; c.fpPass = getU32(p); c.fpVal = getU32(p+4);
        checkFp();
        break;
      }
      case MSG_SNAP: {
        int idx = indexOf(c);
        if (!syncing || idx != provider){ break; }     // unrequested: ignore
        if (n < 4){ drop(c, "bad SNAP"); return; }
        uint32_t sp = getU32(p);
        if (sp != pass)
          printf("[relay] SNAP pass %u != session %u (forwarding anyway)\n",
                 sp, pass);
        std::vector<uint8_t> m; m.push_back(MSG_SNAP);
        m.insert(m.end(), p, p+n);                     // verbatim, never parsed
        for (int tI : targets) if (conns[tI]->open) queueMsg(*conns[tI], m);
        printf("[relay] snapshot forwarded (%u bytes) to %d client(s)\n",
               (unsigned)(n-4), (int)targets.size()); fflush(stdout);
        break;
      }
      default:
        drop(c, "unknown message type");
    }
  }

  /* ---- RFC 6455 ---- */
  void onHandshakeData(Conn& c){
    if (c.hsBuf.size() > LIM_HANDSHAKE_MAX){ drop(c, "handshake too long"); return; }
    size_t end = c.hsBuf.find("\r\n\r\n");
    if (end == std::string::npos) return;
    /* find Sec-WebSocket-Key, case-insensitively */
    std::string low; low.reserve(c.hsBuf.size());
    for (char ch : c.hsBuf) low += (char)tolower((unsigned char)ch);
    size_t k = low.find("sec-websocket-key:");
    if (k == std::string::npos || k > end){ drop(c, "no websocket key"); return; }
    size_t vs = k + 18;
    while (vs < c.hsBuf.size() && c.hsBuf[vs] == ' ') vs++;
    size_t ve = c.hsBuf.find("\r\n", vs);
    std::string key = c.hsBuf.substr(vs, ve - vs);
    static const char* MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    Sha1 sh; sh.update(key.data(), key.size()); sh.update(MAGIC, strlen(MAGIC));
    uint8_t dg[20]; sh.digest(dg);
    std::string resp =
      "HTTP/1.1 101 Switching Protocols\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Accept: " + base64(dg, 20) + "\r\n\r\n";
    c.tx.insert(c.tx.end(), resp.begin(), resp.end());
    flushTx(c);
    c.state = Conn::UP;
    /* anything past the request is the first frame */
    std::string rest = c.hsBuf.substr(end + 4);
    c.hsBuf.clear();
    c.rx.insert(c.rx.end(), rest.begin(), rest.end());
    onFrameData(c);
  }
  void onFrameData(Conn& c){
    for (;;){
      if (!c.open) return;
      if (c.rx.size() < 2) return;
      uint8_t b0 = c.rx[0], b1 = c.rx[1];
      bool fin = (b0 & 0x80) != 0;
      uint8_t op = b0 & 0x0F;
      bool masked = (b1 & 0x80) != 0;
      uint64_t len = b1 & 0x7F;
      size_t off = 2;
      if (len == 126){
        if (c.rx.size() < 4) return;
        len = (uint64_t(c.rx[2])<<8) | c.rx[3]; off = 4;         // RFC: BE
      } else if (len == 127){
        if (c.rx.size() < 10) return;
        len = 0; for (int i=0;i<8;i++) len = (len<<8) | c.rx[2+i];
        off = 10;
      }
      if (!masked){ drop(c, "unmasked client frame"); return; }  // RFC MUST
      if (len > LIM_FRAME_MAX){ drop(c, "frame too large"); return; }
      if (c.rx.size() < off + 4 + len) return;
      uint8_t mask[4]; memcpy(mask, c.rx.data()+off, 4); off += 4;
      std::vector<uint8_t> pay(len);
      for (uint64_t i=0;i<len;i++) pay[i] = c.rx[off+i] ^ mask[i&3];
      c.rx.erase(c.rx.begin(), c.rx.begin() + (off + len));
      switch (op){
        case 0x0:                                       // continuation
          if (!c.fragActive){ drop(c, "stray continuation"); return; }
          c.frag.insert(c.frag.end(), pay.begin(), pay.end());
          if (c.frag.size() > LIM_MESSAGE_MAX){ drop(c, "message too large"); return; }
          if (fin){
            c.fragActive = false;
            std::vector<uint8_t> whole; whole.swap(c.frag);
            onMessage(c, whole.data(), whole.size());
          }
          break;
        case 0x1: case 0x2:                             // text / binary
          if (c.fragActive){ drop(c, "interleaved fragments"); return; }
          if (fin) onMessage(c, pay.data(), pay.size());
          else { c.fragActive = true; c.frag = pay; }
          break;
        case 0x8:                                       // close
          queueFrame(c, pay.data(), pay.size() > 125 ? 0 : pay.size(), 0x8);
          drop(c, "peer closed");
          return;
        case 0x9:                                       // ping -> pong
          queueFrame(c, pay.data(), pay.size(), 0xA);
          break;
        case 0xA: break;                                // pong: ignore
        default: drop(c, "bad opcode"); return;
      }
    }
  }

  /* ---- the loop -------------------------------------------------------- */
  bool listenOn(){
    lis = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (lis == INVALID_SOCKET) return false;
    BOOL one = TRUE;
    setsockopt(lis, SOL_SOCKET, SO_REUSEADDR, (const char*)&one, sizeof one);
    sockaddr_in a{}; a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_ANY); a.sin_port = htons(port);
    if (bind(lis, (sockaddr*)&a, sizeof a) == SOCKET_ERROR) return false;
    if (listen(lis, 8) == SOCKET_ERROR) return false;
    u_long nb = 1; ioctlsocket(lis, FIONBIO, &nb);
    return true;
  }
  void tick(){
    uint64_t t = now();
    for (auto& c : conns){
      if (!c->open) continue;
      if (c->state == Conn::HANDSHAKE && t - c->bornMs > LIM_HANDSHAKE_MS)
        drop(*c, "handshake timeout");
    }
    /* a READY seated client starving the current pass past the limit is
       dropped rather than stalling everyone for ever */
    if (!syncing && seatMask() != 0 && passStartMs &&
        t - passStartMs > LIM_INPUT_MS){
      bool anyWaiting = false;
      for (int i=0;i<seatsN;i++){
        int idx = seat[i];
        if (idx >= 0 && conns[idx]->ready &&
            (!conns[idx]->hasInput || conns[idx]->inPass != pass))
          anyWaiting = true;
      }
      if (anyWaiting){
        for (int i=0;i<seatsN;i++){
          int idx = seat[i];
          if (idx >= 0 && conns[idx]->ready &&
              (!conns[idx]->hasInput || conns[idx]->inPass != pass))
            drop(*conns[idx], "input timeout");
        }
        passStartMs = t;
      }
    }
    if (syncing && t - syncStartMs > LIM_SYNC_MS){
      printf("[relay] sync timeout\n"); fflush(stdout);
      if (provider >= 0 && conns[provider]->open)
        drop(*conns[provider], "sync timeout");   // drop() re-picks/orphans
      else orphanTargets();
    }
  }
  void run(){
    printf("RELAY LISTENING %u seats=%d proto=%u\n",
           (unsigned)port, seatsN, (unsigned)PROTO_VERSION);
    fflush(stdout);
    for (;;){
      fd_set rf, wf; FD_ZERO(&rf); FD_ZERO(&wf);
      FD_SET(lis, &rf);
      for (auto& c : conns){
        if (!c->open) continue;
        FD_SET(c->s, &rf);
        if (!c->tx.empty()) FD_SET(c->s, &wf);
      }
      timeval tv{0, 250000};
      int r = select(0, &rf, &wf, nullptr, &tv);
      if (r == SOCKET_ERROR){ printf("[relay] select failed\n"); return; }
      if (FD_ISSET(lis, &rf)){
        SOCKET s = accept(lis, nullptr, nullptr);
        if (s != INVALID_SOCKET){
          u_long nb = 1; ioctlsocket(s, FIONBIO, &nb);
          BOOL nd = TRUE;
          setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char*)&nd, sizeof nd);
          auto c = std::make_unique<Conn>();
          c->s = s; c->bornMs = now();
          conns.push_back(std::move(c));
        }
      }
      for (size_t i=0;i<conns.size();i++){
        Conn& c = *conns[i];
        if (!c.open) continue;
        if (FD_ISSET(c.s, &wf)) flushTx(c);
        if (!c.open || !FD_ISSET(c.s, &rf)) continue;
        char buf[8192];
        for (;;){
          int n = recv(c.s, buf, sizeof buf, 0);
          if (n > 0){
            if (c.state == Conn::HANDSHAKE) c.hsBuf.append(buf, n);
            else c.rx.insert(c.rx.end(), buf, buf+n);
            if (n < (int)sizeof buf) break;
            continue;
          }
          if (n == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK) break;
          drop(c, n == 0 ? "peer gone" : "recv failed");
          break;
        }
        if (!c.open) continue;
        if (c.state == Conn::HANDSHAKE) onHandshakeData(c);
        else onFrameData(c);
      }
      tick();
      /* reap: erase closed connections.  Only while NOT syncing, so the
         index lists are known-empty: joinQueue drains into a sync the
         moment it is pushed (or orphans), and targets exist only while
         syncing -- so the one index store to rebuild is seat[]. */
      if (!syncing){
        bool erased = false;
        for (size_t i=0;i<conns.size();)
          if (!conns[i]->open){ conns.erase(conns.begin()+i); erased = true; }
          else i++;
        if (erased){
          for (int i=0;i<MAX_SEATS;i++) seat[i] = -1;
          for (size_t i=0;i<conns.size();i++)
            if (conns[i]->seat >= 0) seat[conns[i]->seat] = (int)i;
        }
      }
    }
  }
};

int main(int argc, char** argv){
  Relay R;
  for (int i=1;i<argc;i++){
    if (!strcmp(argv[i], "--port") && i+1 < argc) R.port = (uint16_t)atoi(argv[++i]);
    else if (!strcmp(argv[i], "--seats") && i+1 < argc){
      int s = atoi(argv[++i]);
      if (s < 1) s = 1; if (s > MAX_SEATS) s = MAX_SEATS;
      R.seatsN = s;
    }
  }
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2,2), &wsa) != 0){ printf("WSAStartup failed\n"); return 1; }
  if (!R.listenOn()){ printf("bind/listen failed on %u\n", (unsigned)R.port); return 1; }
  R.run();
  return 0;
}
