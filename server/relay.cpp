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
     gauntlet-relay [--port 33792] [--seats 4]
   Test:
     node tools/relaytest.js server/build/gauntlet-relay.exe          */

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <mstcpip.h>
#include <windows.h>
#include <iphlpapi.h>

#include <sys/stat.h>

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <memory>
#include <string>
#include <vector>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "iphlpapi.lib")

/* ==== protocol constants -- MUST match shared/protocol.json ============
   tools/protocheck.py parses this block by the `= value;` on each line;
   change shared/protocol.json first, then here, and the checker holds
   the two together. */
constexpr uint8_t  PROTO_VERSION       = 3;
constexpr uint16_t DEFAULT_PORT        = 33792;
constexpr int      MAX_SEATS           = 4;
constexpr int      DEFAULT_SEATS       = 4;
constexpr uint32_t FP_EVERY            = 32;
constexpr int      NAME_LEN            = 8;
constexpr int      CHAT_LEN            = 32;
constexpr uint32_t LIM_FRAME_MAX       = 262144;
constexpr uint32_t LIM_MESSAGE_MAX     = 1048576;
constexpr uint32_t LIM_HANDSHAKE_MAX   = 8192;
constexpr uint32_t LIM_INPUT_MS        = 10000;
constexpr uint32_t LIM_HANDSHAKE_MS    = 5000;
constexpr uint32_t LIM_SYNC_MS         = 15000;
constexpr uint32_t LIM_CHAT_MS         = 500;
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
constexpr uint8_t  MSG_CHARS           = 12;
constexpr uint8_t  MSG_NAMES           = 13;
constexpr uint8_t  MSG_PING            = 14;
constexpr uint8_t  MSG_PONG            = 15;
constexpr uint8_t  MSG_CHAT            = 16;
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

/* =======================================================================
   NAT TRAVERSAL -- the server sets up its own port forwarding (opt-in,
   --forward).  Two protocols, tried in order:
     * NAT-PMP (RFC 6886): one tiny UDP exchange with the gateway on
       port 5351.  Cheap, clean, and it also reports the public address.
     * UPnP IGD: SSDP multicast discovery, fetch the device description,
       find the WAN*Connection control URL, SOAP AddPortMapping.  The
       consumer-router lingua franca.
   Both are plain sockets and strings -- no libraries, same as the rest
   of this file.  What NO protocol can fix: an ISP running CGNAT (the
   router's own "external" address is itself private) -- detected and
   reported honestly, because a mapping that succeeds into a carrier NAT
   still goes nowhere.  --unforward removes the mapping and exits.     */
static uint32_t natGateway(){
  MIB_IPFORWARDTABLE* t = nullptr; ULONG sz = 0;
  GetIpForwardTable(nullptr, &sz, FALSE);
  if (!sz) return 0;
  std::vector<uint8_t> buf(sz);
  t = (MIB_IPFORWARDTABLE*)buf.data();
  if (GetIpForwardTable(t, &sz, FALSE) != NO_ERROR) return 0;
  for (DWORD i = 0; i < t->dwNumEntries; i++)
    if (t->table[i].dwForwardDest == 0)          // the default route
      return t->table[i].dwForwardNextHop;       // network byte order
  return 0;
}
static std::string ip4str(uint32_t nbo){
  const uint8_t* b = (const uint8_t*)&nbo;
  char s[20]; snprintf(s, sizeof s, "%u.%u.%u.%u", b[0], b[1], b[2], b[3]);
  return s;
}
static std::string natLocalIpToward(uint32_t gwNbo){
  SOCKET s = socket(AF_INET, SOCK_DGRAM, 0);
  if (s == INVALID_SOCKET) return "";
  sockaddr_in a{}; a.sin_family = AF_INET;
  a.sin_addr.s_addr = gwNbo; a.sin_port = htons(9);
  std::string out;
  if (connect(s, (sockaddr*)&a, sizeof a) == 0){
    sockaddr_in me{}; int ml = sizeof me;
    if (getsockname(s, (sockaddr*)&me, &ml) == 0)
      out = ip4str(me.sin_addr.s_addr);
  }
  closesocket(s); return out;
}
static bool privateIp(const std::string& ip){
  unsigned a = 0, b = 0;
  if (sscanf(ip.c_str(), "%u.%u", &a, &b) < 2) return false;
  return a == 10 || (a == 192 && b == 168) ||
         (a == 172 && b >= 16 && b <= 31) ||
         (a == 100 && b >= 64 && b <= 127) ||    // CGNAT space (RFC 6598)
         a == 169;                                // link-local: no route out
}
/* ---- NAT-PMP ---------------------------------------------------------- */
static bool natPmpTalk(uint32_t gwNbo, const uint8_t* req, int reqLen,
                       uint8_t* resp, int respLen){
  SOCKET s = socket(AF_INET, SOCK_DGRAM, 0);
  if (s == INVALID_SOCKET) return false;
  DWORD tmo = 1200;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tmo, sizeof tmo);
  sockaddr_in a{}; a.sin_family = AF_INET;
  a.sin_addr.s_addr = gwNbo; a.sin_port = htons(5351);
  bool ok = false;
  for (int tries = 0; tries < 2 && !ok; tries++){
    sendto(s, (const char*)req, reqLen, 0, (sockaddr*)&a, sizeof a);
    int n = recv(s, (char*)resp, respLen, 0);
    ok = (n >= respLen) && resp[0] == 0 && resp[1] == (req[1] | 0x80) &&
         resp[2] == 0 && resp[3] == 0;           // result code 0 = success
  }
  closesocket(s); return ok;
}
static bool natPmpExternalIp(uint32_t gw, std::string& out){
  uint8_t req[2] = {0, 0}, resp[12];
  if (!natPmpTalk(gw, req, 2, resp, 12)) return false;
  uint32_t ip; memcpy(&ip, resp + 8, 4);
  out = ip4str(ip); return true;
}
static bool natPmpMap(uint32_t gw, uint16_t port, uint32_t lifetime,
                      uint16_t& extPort){
  uint8_t req[12] = {0, 2};                      // op 2 = map TCP
  req[4] = uint8_t(port >> 8); req[5] = uint8_t(port);
  req[6] = uint8_t(port >> 8); req[7] = uint8_t(port);
  req[8] = uint8_t(lifetime >> 24); req[9] = uint8_t(lifetime >> 16);
  req[10] = uint8_t(lifetime >> 8); req[11] = uint8_t(lifetime);
  uint8_t resp[16];
  if (!natPmpTalk(gw, req, 12, resp, 16)) return false;
  extPort = uint16_t((resp[10] << 8) | resp[11]);
  return true;
}
/* ---- UPnP IGD --------------------------------------------------------- */
static bool ssdpDiscover(std::string& location){
  SOCKET s = socket(AF_INET, SOCK_DGRAM, 0);
  if (s == INVALID_SOCKET) return false;
  DWORD tmo = 2500;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tmo, sizeof tmo);
  sockaddr_in a{}; a.sin_family = AF_INET;
  a.sin_port = htons(1900);
  inet_pton(AF_INET, "239.255.255.250", &a.sin_addr);
  bool ok = false;
  for (const char* st : { "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
                          "urn:schemas-upnp-org:device:InternetGatewayDevice:2" }){
    std::string m = std::string("M-SEARCH * HTTP/1.1\r\n"
      "HOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: ")
      + st + "\r\n\r\n";
    sendto(s, m.data(), (int)m.size(), 0, (sockaddr*)&a, sizeof a);
    char buf[2048];
    int n = recv(s, buf, sizeof buf - 1, 0);
    if (n <= 0) continue;
    buf[n] = 0;
    std::string r(buf), low;
    for (char ch : r) low += (char)tolower((unsigned char)ch);
    size_t k = low.find("location:");
    if (k == std::string::npos) continue;
    size_t vs = k + 9;
    while (vs < r.size() && r[vs] == ' ') vs++;
    size_t ve = r.find("\r\n", vs);
    location = r.substr(vs, ve - vs);
    ok = true; break;
  }
  closesocket(s); return ok;
}
static bool urlSplit(const std::string& url, std::string& host,
                     uint16_t& port, std::string& path){
  size_t p = url.find("://");
  if (p == std::string::npos) return false;
  size_t hs = p + 3, pe = url.find('/', hs);
  std::string hp = url.substr(hs, pe == std::string::npos ? std::string::npos
                                                          : pe - hs);
  path = pe == std::string::npos ? "/" : url.substr(pe);
  size_t c = hp.find(':');
  host = c == std::string::npos ? hp : hp.substr(0, c);
  port = c == std::string::npos ? 80 : (uint16_t)atoi(hp.c_str() + c + 1);
  return !host.empty();
}
static bool httpTalk(const std::string& host, uint16_t port,
                     const std::string& req, std::string& resp){
  SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
  if (s == INVALID_SOCKET) return false;
  DWORD tmo = 4000;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tmo, sizeof tmo);
  setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tmo, sizeof tmo);
  sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(port);
  if (inet_pton(AF_INET, host.c_str(), &a.sin_addr) != 1){
    closesocket(s); return false;                // IGDs advertise by IP
  }
  bool ok = false;
  if (connect(s, (sockaddr*)&a, sizeof a) == 0){
    send(s, req.data(), (int)req.size(), 0);
    char buf[4096]; int n;
    while ((n = recv(s, buf, sizeof buf, 0)) > 0){
      resp.append(buf, n);
      if (resp.size() > 262144) break;
    }
    ok = !resp.empty();
  }
  closesocket(s); return ok;
}
static std::string xmlTag(const std::string& xml, const std::string& tag,
                          size_t from = 0){
  size_t a = xml.find("<" + tag + ">", from);
  if (a == std::string::npos) return "";
  a += tag.size() + 2;
  size_t b = xml.find("</" + tag + ">", a);
  if (b == std::string::npos) return "";
  return xml.substr(a, b - a);
}
struct Upnp { std::string host, path, service; uint16_t port = 0; bool ok = false; };
static Upnp upnpFind(){
  Upnp u;
  std::string loc;
  if (!ssdpDiscover(loc)) return u;
  std::string host, path, xml;
  uint16_t port;
  if (!urlSplit(loc, host, port, path)) return u;
  std::string req = "GET " + path + " HTTP/1.1\r\nHOST: " + host + ":" +
                    std::to_string(port) + "\r\nCONNECTION: close\r\n\r\n";
  if (!httpTalk(host, port, req, xml)) return u;
  for (const char* svc : { "urn:schemas-upnp-org:service:WANIPConnection:2",
                           "urn:schemas-upnp-org:service:WANIPConnection:1",
                           "urn:schemas-upnp-org:service:WANPPPConnection:1" }){
    size_t at = xml.find(svc);
    if (at == std::string::npos) continue;
    size_t end = xml.find("</service>", at);
    std::string ctl = xmlTag(xml.substr(0, end == std::string::npos
                                             ? xml.size() : end),
                             "controlURL", at);
    if (ctl.empty()) continue;
    u.service = svc;
    if (ctl.rfind("http://", 0) == 0){
      if (!urlSplit(ctl, u.host, u.port, u.path)) continue;
    } else {
      u.host = host; u.port = port;
      u.path = ctl[0] == '/' ? ctl : "/" + ctl;
    }
    u.ok = true; return u;
  }
  return u;
}
static bool soapCall(const Upnp& u, const std::string& action,
                     const std::string& args, std::string& resp){
  std::string body =
    "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org"
    "/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/"
    "encoding/\"><s:Body><u:" + action + " xmlns:u=\"" + u.service + "\">" +
    args + "</u:" + action + "></s:Body></s:Envelope>";
  std::string req =
    "POST " + u.path + " HTTP/1.1\r\nHOST: " + u.host + ":" +
    std::to_string(u.port) + "\r\nCONTENT-TYPE: text/xml; charset=\"utf-8\""
    "\r\nSOAPACTION: \"" + u.service + "#" + action + "\"\r\n"
    "CONTENT-LENGTH: " + std::to_string(body.size()) +
    "\r\nCONNECTION: close\r\n\r\n" + body;
  if (!httpTalk(u.host, u.port, req, resp)) return false;
  return resp.find(" 200 ") != std::string::npos;
}
/* ---- the orchestration ------------------------------------------------ */
struct NatState {
  bool active = false;
  bool pmp = false;               // which protocol holds the mapping
  uint32_t gw = 0;
  Upnp upnp;
  uint16_t port = 0, extPort = 0;
  std::string extIp, lan;
  uint64_t renewAt = 0;           // GetTickCount64 ms; 0 = no renewal needed
};
static NatState NAT;
static bool upnpMap(const Upnp& u, uint16_t port, const std::string& lan,
                    uint32_t lease){
  std::string resp;
  return soapCall(u, "AddPortMapping",
    "<NewRemoteHost></NewRemoteHost><NewExternalPort>" +
    std::to_string(port) + "</NewExternalPort><NewProtocol>TCP</NewProtocol>"
    "<NewInternalPort>" + std::to_string(port) + "</NewInternalPort>"
    "<NewInternalClient>" + lan + "</NewInternalClient><NewEnabled>1"
    "</NewEnabled><NewPortMappingDescription>gauntlet-relay"
    "</NewPortMappingDescription><NewLeaseDuration>" +
    std::to_string(lease) + "</NewLeaseDuration>", resp);
}
static void natForward(uint16_t port, bool removeOnly){
  NAT.port = port;
  NAT.gw = natGateway();
  if (!NAT.gw){ printf("[relay] forward: no default gateway found\n"); return; }
  NAT.lan = natLocalIpToward(NAT.gw);
  printf("[relay] forward: gateway %s, this machine %s\n",
         ip4str(NAT.gw).c_str(), NAT.lan.c_str());
  /* NAT-PMP first: one small exchange */
  uint16_t ep = 0;
  if (natPmpMap(NAT.gw, port, removeOnly ? 0 : 7200, ep)){
    if (removeOnly){ printf("[relay] forward: NAT-PMP mapping removed\n"); return; }
    NAT.active = true; NAT.pmp = true; NAT.extPort = ep;
    NAT.renewAt = GetTickCount64() + 3600u * 1000u;      // half the lease
    natPmpExternalIp(NAT.gw, NAT.extIp);
  } else {
    /* UPnP: discovery, description, SOAP */
    NAT.upnp = upnpFind();
    if (!NAT.upnp.ok){
      printf("[relay] forward: router answered neither NAT-PMP nor UPnP --\n"
             "        forward TCP %u to %s manually in the router, or check\n"
             "        that UPnP is enabled there\n", port, NAT.lan.c_str());
      return;
    }
    if (removeOnly){
      std::string resp;
      soapCall(NAT.upnp, "DeletePortMapping",
        "<NewRemoteHost></NewRemoteHost><NewExternalPort>" +
        std::to_string(port) +
        "</NewExternalPort><NewProtocol>TCP</NewProtocol>", resp);
      printf("[relay] forward: UPnP mapping removed\n");
      return;
    }
    /* permanent lease first; some routers only accept timed ones */
    bool ok = upnpMap(NAT.upnp, port, NAT.lan, 0);
    if (!ok && upnpMap(NAT.upnp, port, NAT.lan, 86400)){
      ok = true; NAT.renewAt = GetTickCount64() + 43200u * 1000u;
    }
    if (!ok){
      printf("[relay] forward: UPnP found (%s) but AddPortMapping refused\n",
             NAT.upnp.service.c_str());
      return;
    }
    NAT.active = true; NAT.extPort = port;
    std::string resp;
    if (soapCall(NAT.upnp, "GetExternalIPAddress", "", resp))
      NAT.extIp = xmlTag(resp, "NewExternalIPAddress");
  }
  printf("[relay] forward: %s mapped tcp %u -> %s:%u\n",
         NAT.pmp ? "NAT-PMP" : "UPnP", NAT.extPort, NAT.lan.c_str(), port);
  if (!NAT.extIp.empty()){
    if (privateIp(NAT.extIp)){
      unsigned pa = 0, pb = 0;
      sscanf(NAT.extIp.c_str(), "%u.%u", &pa, &pb);
      if (pa == 100 && pb >= 64 && pb <= 127)
        printf("[relay] forward: WARNING -- the router's external address %s\n"
               "        is CARRIER-GRADE NAT (the ISP's own).  No port forward\n"
               "        can reach this from outside; ask the ISP for a public\n"
               "        address, or use a tunnel.\n", NAT.extIp.c_str());
      else
        printf("[relay] forward: WARNING -- DOUBLE NAT.  This router's own\n"
               "        external address %s is still private: it sits\n"
               "        behind ANOTHER router (likely the ISP modem).  This\n"
               "        mapping is good, but the OUTER box must also forward\n"
               "        TCP %u to %s -- or be put in bridge mode so\n"
               "        this router gets the public address.  The real public\n"
               "        IP is on the outer box's status page.\n",
               NAT.extIp.c_str(), NAT.extPort, NAT.extIp.c_str());
    }
    else
      printf("[relay] forward: share  http://%s:%u/\n",
             NAT.extIp.c_str(), NAT.extPort);
  }
  printf("[relay] forward: if nobody can connect, also allow this exe through\n"
         "        the Windows Firewall (it prompts on first run)\n");
}
static void natRenew(){
  if (!NAT.active || !NAT.renewAt || GetTickCount64() < NAT.renewAt) return;
  if (NAT.pmp){
    uint16_t ep = 0;
    natPmpMap(NAT.gw, NAT.port, 7200, ep);
    NAT.renewAt = GetTickCount64() + 3600u * 1000u;
  } else {
    upnpMap(NAT.upnp, NAT.port, NAT.lan, 86400);
    NAT.renewAt = GetTickCount64() + 43200u * 1000u;
  }
}
static void natCleanup(){
  if (!NAT.active) return;
  NAT.active = false;
  if (NAT.pmp){ uint16_t ep; natPmpMap(NAT.gw, NAT.port, 0, ep); }
  else {
    std::string resp;
    soapCall(NAT.upnp, "DeletePortMapping",
      "<NewRemoteHost></NewRemoteHost><NewExternalPort>" +
      std::to_string(NAT.port) +
      "</NewExternalPort><NewProtocol>TCP</NewProtocol>", resp);
  }
}
static BOOL WINAPI natCtrlHandler(DWORD){
  natCleanup();                    // best effort inside the ~5 s Windows grants
  return FALSE;                    // let the default handler terminate us
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
  uint64_t inAtMs = 0;            // when this pass's byte landed (NETPLAN 2.2)
  bool hasFp = false;
  uint32_t fpPass = 0, fpVal = 0;
  uint64_t bornMs = 0;            // for the handshake timeout
  uint64_t chatAtMs = 0;          // the last CHAT accepted (the spam guard)
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
  /* CHARACTERS ARE SIM STATE (shot/fight/magic/armour tables), so the
     session owns one table of them: a fresh HELLO's pick lands here --
     bumped past any earlier seat's, the engine never fields two of one
     character -- and CHARS broadcasts it.  Frozen once the first PASS
     goes out; a late joiner's arrive inside the snapshot instead. */
  uint8_t charBySeat[MAX_SEATS];
  /* NAMES are display metadata, never sim state: HELLO's optional
     trailing field lands here (sanitized) and NAMES broadcasts the
     table.  A leaver's name stays with his standing block mid-game --
     seat reuse overwrites it -- and clears with his pick pre-start. */
  uint8_t nameBySeat[MAX_SEATS][NAME_LEN];
  std::string htmlPath;           // what GET / serves; empty = 404
  /* the one pause state: a snapshot in flight, for a joiner or a
     desynced client.  While syncing the loop holds; inputs already
     received keep their slots. */
  bool syncing = false;
  int provider = -1;              // conn index
  std::vector<int> targets;       // conn indices awaiting SNAP + their READY
  uint64_t syncStartMs = 0;
  std::deque<int> joinQueue;      // conn indices waiting for a sync slot

  Relay(){ for (int i=0;i<MAX_SEATS;i++){ seat[i] = -1; charBySeat[i] = 0xFF;
                                          memset(nameBySeat[i], ' ', NAME_LEN); } }
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
  void broadcastChars(){
    std::vector<uint8_t> m; m.push_back(MSG_CHARS);
    for (int i=0;i<MAX_SEATS;i++) m.push_back(charBySeat[i]);
    for (auto& c : conns) if (c->open && c->state == Conn::UP && c->seat >= 0)
      queueMsg(*c, m);
  }
  void broadcastNames(){
    std::vector<uint8_t> m; m.push_back(MSG_NAMES);
    for (int i=0;i<MAX_SEATS;i++)
      for (int j=0;j<NAME_LEN;j++) m.push_back(nameBySeat[i][j]);
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
    if (c.seat >= 0){
      /* pre-start, a leaver's character pick -- and name -- leave with
         him; mid-game both stay with the standing block until the seat
         is reused */
      if (pass == 0){ charBySeat[c.seat] = 0xFF; broadcastChars();
                      memset(nameBySeat[c.seat], ' ', NAME_LEN);
                      broadcastNames(); }
      seat[c.seat] = -1; c.seat = -1;
    }
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
      for (int i=0;i<MAX_SEATS;i++){ charBySeat[i] = 0xFF;
                                     memset(nameBySeat[i], ' ', NAME_LEN); }
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
      /* NETPLAN 2.2 -- one trailing byte per seat: how long this pass's
         byte WAITED here for the rest, in 4 ms units (0 for an empty
         seat, 255 = a second or more).  It is what separates "the wire
         is slow" from "one seat is slow" from "the phases are
         misaligned".  Trailing bytes are safe for a client that reads
         `count` directions and ignores the rest. */
      const uint64_t emitMs = now();
      for (int i=0;i<seatsN;i++){
        int idx = seat[i];
        uint64_t w = 0;
        if (idx >= 0 && conns[idx]->hasInput) w = (emitMs - conns[idx]->inAtMs) / 4;
        m.push_back(uint8_t(w > 255 ? 255 : w));
      }
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
        if (n < 2 || p[0] != PROTO_VERSION){ sendError(c, ERR_VERSION); return; }
        if (c.seat >= 0){ drop(c, "double HELLO"); return; }
        int s = -1;
        for (int i=0;i<seatsN;i++) if (seat[i] < 0){ s = i; break; }
        if (s < 0){ sendError(c, ERR_FULL); return; }
        if (seatMask() == 0 && pass == 0) buildSeed = freshSeed();
        seat[s] = indexOf(c); c.seat = s; c.ready = false;
        /* the NAME -- HELLO's optional trailing field, display-only.
           Sanitized to the tag font's charset (uppercase A-Z, 0-9,
           space); a short HELLO means a blank name.  Unlike the pick
           this applies to SNAPSHOT joiners too: snapshots carry no
           names, the table is the wire's own. */
        for (int j=0;j<NAME_LEN;j++){
          uint8_t ch = (n >= size_t(2 + NAME_LEN)) ? p[2 + j] : uint8_t(' ');
          if (ch >= 'a' && ch <= 'z') ch = uint8_t(ch - 32);
          if (!(ch == ' ' || (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z')))
            ch = ' ';
          nameBySeat[s][j] = ch;
        }
        uint8_t mode = (pass == 0) ? MODE_FRESH : MODE_SNAPSHOT;
        std::vector<uint8_t> m; m.push_back(MSG_WELCOME);
        m.push_back(uint8_t(s)); m.push_back(uint8_t(seatsN));
        putU32(m, buildSeed); m.push_back(mode); putU32(m, pass);
        queueMsg(c, m);
        printf("[relay] seat %d taken (%s, pass %u)\n", s,
               mode == MODE_FRESH ? "fresh" : "snapshot", pass);
        fflush(stdout);
        if (mode == MODE_SNAPSHOT){
          /* his pick does not apply -- the block's character arrives
             inside the snapshot */
          joinQueue.push_back(indexOf(c));
          startSyncIfDue();
        } else {
          uint8_t ch = p[1] & 3;
          for (int guard=0; guard<4; guard++){
            bool clash = false;
            for (int i=0;i<MAX_SEATS;i++)
              if (i != s && charBySeat[i] == ch) clash = true;
            if (!clash) break;
            ch = (ch + 1) & 3;                    // the engine never fields
          }                                       // two of one character
          charBySeat[s] = ch;
          broadcastChars();
        }
        broadcastNames();
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
        c.hasInput = true; c.inPass = ip; c.inDir = p[4]; c.inAtMs = now();
        tryAdvance();
        break;
      }
      case MSG_PING: {
        /* NETPLAN 2.1 -- a clean RTT probe.  Answered HERE, before any
           other work and without a seat: a PONG must never wait behind
           the advance gate or the sync flow, or it measures the game
           instead of the link.  passStartMs is untouched. */
        if (n < 4){ drop(c, "bad PING"); return; }
        std::vector<uint8_t> m; m.push_back(MSG_PONG);
        m.insert(m.end(), p, p + 4);              // the tag, verbatim
        queueMsg(c, m);
        flushTx(c);
        break;
      }
      case MSG_CHAT: {
        /* SPEECH BUBBLES -- display metadata, the NAMES pattern exactly:
           never the sim's.  The line is sanitized to the micro font's
           charset (uppercase A-Z, 0-9, space and . , ? ! ' -), cut to
           CHAT_LEN, stamped with the SEAT and echoed to everyone seated,
           the speaker included -- his bubble rises on the echo like
           everyone's.  A seat may speak once per LIM_CHAT_MS; anything
           inside that window is dropped without a word (the spam guard).
           The relay never looks at the game; it does not here either. */
        if (c.seat < 0){ drop(c, "CHAT unseated"); return; }
        if (n < 1){ drop(c, "bad CHAT"); return; }
        size_t len = p[0]; if (len > size_t(CHAT_LEN)) len = CHAT_LEN;
        if (n < 1 + len){ drop(c, "bad CHAT"); return; }
        if (len == 0) break;
        uint64_t tNow = now();
        if (c.chatAtMs && tNow - c.chatAtMs < LIM_CHAT_MS) break;
        c.chatAtMs = tNow;
        std::vector<uint8_t> m; m.push_back(MSG_CHAT);
        m.push_back(uint8_t(c.seat)); m.push_back(uint8_t(len));
        for (size_t j=0;j<len;j++){
          uint8_t ch = p[1 + j];
          if (ch >= 'a' && ch <= 'z') ch = uint8_t(ch - 32);
          if (!(ch == ' ' || (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') ||
                ch == '.' || ch == ',' || ch == '?' || ch == '!' || ch == '\'' || ch == '-'))
            ch = ' ';
          m.push_back(ch);
        }
        for (auto& o : conns)
          if (o->open && o->state == Conn::UP && o->seat >= 0) queueMsg(*o, m);
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

  /* ---- plain HTTP: THE PAGE IS THE SERVER ------------------------------
     A GET without the Upgrade header is a browser asking for the game:
     the owner runs this exe and shares http://host:port/, and the page
     that comes back connects to its own origin -- the address needs no
     UI, which the HUD font (no '.' or ':' glyphs) could not have drawn
     anyway.  Read per request, so a rebuilt client ships without
     restarting the relay. */
  void serveHttp(Conn& c, const std::string& req){
    std::string path = "/";
    size_t sp1 = req.find(' ');
    if (sp1 != std::string::npos){
      size_t sp2 = req.find(' ', sp1 + 1);
      if (sp2 != std::string::npos) path = req.substr(sp1 + 1, sp2 - sp1 - 1);
    }
    size_t qm = path.find('?');
    if (qm != std::string::npos) path = path.substr(0, qm);
    std::string body, head;
    bool gzipped = false;
    if ((path == "/" || path == "/index.html") && !htmlPath.empty()){
      /* the GZIP ARM: tools/build.py writes an atomically-replaced .gz
         sibling (~1/3 the bytes), and the page is the largest payload of
         every join -- felt on the --forward internet case, where the
         owner's home uplink carries it to each joiner.  The relay gains
         no dependency: compression happened at build time.  The mtime
         guard (gz at least as fresh as the html) keeps a REBUILT html
         honest while its sibling has not landed yet -- identity is
         served until build.py's os.replace drops the fresh .gz, so the
         per-request no-restart property survives. */
      size_t ae = req.size();
      { std::string low; low.reserve(req.size());
        for (char ch : req) low += (char)tolower((unsigned char)ch);
        ae = low.find("accept-encoding:");
        if (ae != std::string::npos){
          size_t eol = low.find("\r\n", ae), gz = low.find("gzip", ae);
          if (gz == std::string::npos || (eol != std::string::npos && gz > eol))
            ae = std::string::npos;
        }
      }
      if (ae != std::string::npos){
        struct _stat64 sh{}, sg{};
        std::string gzPath = htmlPath + ".gz";
        if (_stat64(htmlPath.c_str(), &sh) == 0 &&
            _stat64(gzPath.c_str(), &sg) == 0 && sg.st_mtime >= sh.st_mtime){
          FILE* f = fopen(gzPath.c_str(), "rb");
          if (f){
            fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
            if (sz > 0){ body.resize((size_t)sz);
                         if (fread(&body[0], 1, (size_t)sz, f) != (size_t)sz) body.clear(); }
            fclose(f);
            gzipped = !body.empty();
          }
        }
      }
      if (!gzipped){
        FILE* f = fopen(htmlPath.c_str(), "rb");
        if (f){
          fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
          if (sz > 0){ body.resize((size_t)sz);
                       if (fread(&body[0], 1, (size_t)sz, f) != (size_t)sz) body.clear(); }
          fclose(f);
        }
      }
    }
    if (!body.empty()){
      head = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
             "Cache-Control: no-store\r\nConnection: close\r\n" +
             std::string(gzipped ? "Content-Encoding: gzip\r\nVary: Accept-Encoding\r\n" : "") +
             "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n";
    } else {
      body = "NOT FOUND\n";
      head = "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n"
             "Connection: close\r\nContent-Length: " +
             std::to_string(body.size()) + "\r\n\r\n";
    }
    c.tx.insert(c.tx.end(), head.begin(), head.end());
    c.tx.insert(c.tx.end(), body.begin(), body.end());
    c.closeAfterTx = true;
    flushTx(c);
  }

  /* ---- RFC 6455 ---- */
  void onHandshakeData(Conn& c){
    if (c.hsBuf.size() > LIM_HANDSHAKE_MAX){ drop(c, "handshake too long"); return; }
    size_t end = c.hsBuf.find("\r\n\r\n");
    if (end == std::string::npos) return;
    /* find Sec-WebSocket-Key, case-insensitively */
    std::string low; low.reserve(c.hsBuf.size());
    for (char ch : c.hsBuf) low += (char)tolower((unsigned char)ch);
    if (low.find("upgrade: websocket") == std::string::npos &&
        low.find("upgrade:websocket") == std::string::npos){
      serveHttp(c, c.hsBuf.substr(0, end));
      return;
    }
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
    natRenew();                    // keep a --forward mapping alive
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
          /* KEEPALIVE: a VANISHED host (lid closed, wifi dead, power cut)
             freezes the whole session at the advance gate for the full
             10 s input timeout before its seat drops.  A stalled session
             is quiescent in BOTH directions (the relay initiates no
             pings and broadcasts no PASS while the gate waits), so the
             idle timer genuinely runs: probes at 3 s idle, 1 s apart,
             3 misses = the conn resets in ~6 s and takes the existing
             recv-error drop path (0x00 substitution resumes the rest).
             Tuned SOFT on purpose: real wifi has 3-4 s blackouts that
             TCP retransmission self-heals today and must keep healing
             (a false drop costs a snapshot rejoin).  A frozen APP is
             still kernel-ACKed -- the 10 s input timeout remains the
             app-death detector.  The Win10 1709+ POSIX trio first; the
             Vista SIO_KEEPALIVE_VALS fallback (fixed 10 probes) is
             tuned to ~7 s, still under the 10 s it exists to beat. */
          BOOL ka = TRUE;
          setsockopt(s, SOL_SOCKET, SO_KEEPALIVE, (const char*)&ka, sizeof ka);
          DWORD kIdle = 3, kIntvl = 1, kCnt = 3;
          if (setsockopt(s, IPPROTO_TCP, TCP_KEEPIDLE,
                         (const char*)&kIdle, sizeof kIdle) ||
              setsockopt(s, IPPROTO_TCP, TCP_KEEPINTVL,
                         (const char*)&kIntvl, sizeof kIntvl) ||
              setsockopt(s, IPPROTO_TCP, TCP_KEEPCNT,
                         (const char*)&kCnt, sizeof kCnt)){
            struct tcp_keepalive kav{1, 2000, 500};
            DWORD kOut = 0;
            WSAIoctl(s, SIO_KEEPALIVE_VALS, &kav, sizeof kav,
                     nullptr, 0, &kOut, nullptr, nullptr);
          }
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
  bool doForward = false, doUnforward = false;
  for (int i=1;i<argc;i++){
    if (!strcmp(argv[i], "--port") && i+1 < argc) R.port = (uint16_t)atoi(argv[++i]);
    else if (!strcmp(argv[i], "--seats") && i+1 < argc){
      int s = atoi(argv[++i]);
      if (s < 1) s = 1; if (s > MAX_SEATS) s = MAX_SEATS;
      R.seatsN = s;
    }
    else if (!strcmp(argv[i], "--html") && i+1 < argc) R.htmlPath = argv[++i];
    else if (!strcmp(argv[i], "--forward")) doForward = true;
    else if (!strcmp(argv[i], "--unforward")) doUnforward = true;
  }
  /* the page (GET /): --html wins; otherwise look beside the cwd and the
     exe for client/gauntlet.html, the built single file */
  if (R.htmlPath.empty()){
    std::vector<std::string> cand = {
      "client\\gauntlet.html", "..\\client\\gauntlet.html",
      "..\\..\\client\\gauntlet.html" };
    char exe[MAX_PATH];
    if (GetModuleFileNameA(nullptr, exe, MAX_PATH)){
      std::string d(exe);
      size_t cut = d.find_last_of('\\');
      if (cut != std::string::npos){
        d = d.substr(0, cut);
        cand.push_back(d + "\\..\\..\\client\\gauntlet.html");
        cand.push_back(d + "\\gauntlet.html");
      }
    }
    for (const auto& p : cand){
      FILE* f = fopen(p.c_str(), "rb");
      if (f){ fclose(f); R.htmlPath = p; break; }
    }
  }
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2,2), &wsa) != 0){ printf("WSAStartup failed\n"); return 1; }
  if (doUnforward){ natForward(R.port, true); return 0; }
  if (!R.listenOn()){ printf("bind/listen failed on %u\n", (unsigned)R.port); return 1; }
  if (doForward){
    natForward(R.port, false);
    SetConsoleCtrlHandler(natCtrlHandler, TRUE);   // unmap on Ctrl+C / close
  } else {
    printf("[relay] LAN only (--forward asks the router to open this port "
           "for internet play)\n");
  }
  printf(R.htmlPath.empty()
           ? "[relay] no client page found -- GET / will 404 (use --html)\n"
           : "[relay] serving %s\n",
         R.htmlPath.c_str());
  R.run();
  return 0;
}
