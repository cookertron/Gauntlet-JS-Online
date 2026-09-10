/* =======================================================================
   gauntlet-relay -- what the WINDOW (gui.cpp) may see of the relay
   (relay.cpp), and the three orders it may give.  The window never
   touches the Relay object or a socket: the loop publishes a status copy
   after every turn, the window reads copies, and orders queue up for the
   loop's next turn.  Everything here is plain data.
   ======================================================================= */
#pragma once
#include <cstdint>
#include <string>
#include <vector>

constexpr int RELAY_MAX_SEATS = 4;
/* THE FOUR CHARACTERS ARE THE FOUR SEATS (Anthony's whitelist,
   2026-09-10): seat i always fields character i, so one slot is one
   character, a reservation names a character, and the window lists
   characters rather than seat numbers. */
inline const char* const RELAY_CHAR_NAMES[RELAY_MAX_SEATS] =
  { "Warrior", "Valkyrie", "Wizard", "Elf" };

struct SeatStatus {                        // seats[i] IS character i
  bool taken = false, ready = false;
  bool available = false;      // within --seats: a smaller table ends at the Valkyrie
  std::string reserved;        // the whitelist: whose character this is; empty = anyone's
  std::string name;            // the wire's, trailing spaces trimmed; empty = unset
  std::string addr;            // ip:port of the connection
  std::string state;           // a few words: booting / connected / late 1.2 s / ...
  uint64_t sinceMs = 0;        // GetTickCount64 when the connection was accepted
  int rttMs = -1;              // the relay's own WebSocket ping: median of the last 8
  int rttWorstMs = -1;         // ... and the worst of them
  int waitMs = -1;             // mean ms this seat's byte waited for the rest, last second
};

struct RelayStatus {
  uint16_t port = 0;
  int proto = 0, seatsN = 0;
  uint32_t pass = 0;
  double passRate = 0;         // passes a second over the last second
  int seated = 0, conns = 0;   // seats taken; connections open (HTTP fetches included)
  uint32_t pages = 0, desyncs = 0, snapshots = 0;
  uint64_t startMs = 0;        // GetTickCount64 when the loop began
  bool syncing = false;
  std::string htmlPath, lanIp;
  SeatStatus seats[RELAY_MAX_SEATS];
};

struct NatStatus {
  bool active = false;         // a mapping is held
  bool busy = false;           // a forward or removal is under way on its thread
  bool pmp = false;            // NAT-PMP holds it (else UPnP)
  uint16_t extPort = 0;
  std::string extIp, lan;
  std::string summary;         // the last outcome in a few words
  std::string warning;         // DOUBLE NAT / carrier-grade NAT, when detected
};

RelayStatus relayStatus();
NatStatus   natStatus();
std::vector<std::string> logTake();          // the stamped lines since the last take
void relayKick(int seat);                      // the loop closes that seat on its next turn
/* the whitelist: reserve character `chr` for the player who types that
   NAME on the options screen ("" frees it).  Sanitized and persisted by
   the relay, so the window shows back exactly what was stored. */
void relaySetReserved(int chr, const std::string& name);
void relayForward(bool on, uint16_t port);    // open/close the router port, on its own thread
void relayStop();                             // the loop returns; the thread removes the mapping
bool relayDone();                             // ... and this goes true when it has

int guiMain(uint16_t port);                   // gui.cpp: the window, until it closes
