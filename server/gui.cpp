/* =======================================================================
   gauntlet-relay -- THE WINDOW.  Anthony, 2026-09-05: "Can we have a GUI
   for it?  Yes a console to see real-time logging (which needs a
   timestamp btw) but hidden behind a menu option.  The GUI should display
   seats taken, ping rate and other useful or interesting data.  Port
   forward can be done with a button, as can kicking a player."
   =======================================================================
   Plain Win32 -- user32, gdi32, comctl32, shell32: nothing to install, no
   framework, the same standalone exe.  The relay runs on its own thread
   (relay.cpp) and this file never touches it: a 4 Hz timer reads the
   status copy the loop publishes after every turn (relayStatus), the
   router state (natStatus) and the stamped log (logTake), and the three
   orders go back through relay.h -- kick a seat, open or close the
   router port, stop.

   The main window: four status lines (the local-network address, the
   internet address or why there is none, the session, the page), the
   CHARACTER TABLE -- one row per character, since 2026-09-10 the
   character IS the seat: who has it, from where, for how long, the
   relay's own ping (median and worst), how long his byte waits for the
   rest (the seat that never waits is the one holding everyone up), and
   the WHITELIST cell, an edit box over the list where the host reserves
   that character for one player's options NAME -- the buttons, and the
   newest log line.  View > Log opens the console: every line stamped
   HH:MM:SS.mmm.  Per-monitor DPI aware, so the 4x5 micro font's cousin
   here -- Segoe UI -- stays sharp on the laptop.  */
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "relay.h"

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "shell32.lib")
/* the v6 common controls (the flat ListView and buttons Windows has
   drawn since XP) come from a manifest dependency, not a file */
#pragma comment(linker, "\"/manifestdependency:type='win32' "                 \
  "name='Microsoft.Windows.Common-Controls' version='6.0.0.0' "                \
  "processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"")

namespace {

enum : int {
  IDM_FORWARD = 101, IDM_COPY, IDM_PLAY, IDM_EXIT, IDM_LOG, IDM_ABOUT,
  IDC_LIST = 201, IDC_FORWARD, IDC_COPY, IDC_PLAY, IDC_KICK, IDC_LAST,
  IDC_RESERVE,                            // the edit box that floats over a cell
  IDC_LINE0 = 300,                        // + i
  IDC_LOGEDIT = 401, IDC_LOGCOPY, IDC_LOGCLEAR,
};
constexpr int  LINES = 4;
constexpr int  LINE_ROWS[LINES] = { 1, 2, 1, 1 };   // the internet line may warn at length
/* the row is the CHARACTER; "Reserved for" is the whitelist, and the
   only cell the host can type in */
enum : int { COL_CHAR = 0, COL_RESERVED, COL_PLAYER, COL_ADDR, COL_CONN,
             COL_PING, COL_WORST, COL_WAIT, COL_STATE, COLS };
constexpr UINT TIMER_ID = 1, TIMER_MS = 250;
constexpr int  LOG_MAX_LINES = 5000, LOG_TRIM_LINES = 1000;
const wchar_t* MAIN_CLASS = L"GauntletRelayMain";
const wchar_t* LOG_CLASS  = L"GauntletRelayLog";
const wchar_t* TITLE      = L"Gauntlet Online Server";
const char*    CHAR_NAMES[4] = { "WARRIOR", "VALKYRIE", "WIZARD", "ELF" };
const wchar_t* COL_NAMES[COLS] = { L"Character", L"Reserved for", L"Player", L"Address",
                                   L"Connected", L"Ping", L"Worst", L"Wait", L"State" };
const int      COL_DIPS[COLS]  = { 76, 96, 96, 146, 76, 60, 60, 60, 126 };
const wchar_t* HINT =
  L"Reserved for: click a cell and type a player's options NAME -- that character is then always theirs.";

struct Ui {
  HINSTANCE inst = nullptr;
  HWND main = nullptr, list = nullptr, last = nullptr, hint = nullptr;
  HWND reserve = nullptr;                 // the floating cell editor
  int  reserveRow = -1;                   // which character it is editing; -1 = closed
  HWND line[LINES] = {};
  HWND btn[4] = {};                       // forward, copy, play, kick
  HWND log = nullptr, logEdit = nullptr, logBtn[2] = {};
  HMENU menu = nullptr, serverMenu = nullptr, viewMenu = nullptr;
  HFONT font = nullptr, bold = nullptr, mono = nullptr;
  uint16_t port = 0;
  int dpi = 96, logDpi = 96;
  int rows = 0;
  std::string cell[RELAY_MAX_SEATS][COLS];   // what the table shows -- skip no-op sets
  std::wstring lineText[LINES], lastText, btnText[4];
  std::string shareUrl, shareWhat;           // what Copy puts on the clipboard, and its name
  int logLines = 0;
} U;

int px(int dip){ return MulDiv(dip, U.dpi, 96); }

std::wstring W(const std::string& s){
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
  return w;
}

std::string A(const std::wstring& w){
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

HFONT makeFont(int pt, int weight, const wchar_t* face, int dpi){
  return CreateFontW(-MulDiv(pt, dpi, 72), 0, 0, 0, weight, FALSE, FALSE, FALSE,
                     DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                     CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, face);
}
void setFont(HWND h, HFONT f){ if (h) SendMessageW(h, WM_SETFONT, (WPARAM)f, TRUE); }
void makeFonts(){
  if (U.font) DeleteObject(U.font);
  if (U.bold) DeleteObject(U.bold);
  U.font = makeFont(9, FW_NORMAL, L"Segoe UI", U.dpi);
  U.bold = makeFont(9, FW_SEMIBOLD, L"Segoe UI", U.dpi);
  for (int i = 0; i < LINES; i++) setFont(U.line[i], i < 2 ? U.bold : U.font);
  setFont(U.list, U.font);
  for (HWND b : U.btn) setFont(b, U.font);
  setFont(U.last, U.font);
  setFont(U.hint, U.font);
  setFont(U.reserve, U.font);
}
void makeLogFonts(){
  if (U.mono) DeleteObject(U.mono);
  U.mono = makeFont(10, FW_NORMAL, L"Consolas", U.logDpi);
  setFont(U.logEdit, U.mono);
  HFONT f = makeFont(9, FW_NORMAL, L"Segoe UI", U.logDpi);   // the two buttons keep their own
  for (HWND b : U.logBtn) setFont(b, f);
}

/* ---- text helpers ---------------------------------------------------- */
std::string fmtDur(uint64_t ms){
  unsigned long long s = ms / 1000;
  char b[32];
  if (s >= 3600) snprintf(b, sizeof b, "%llu:%02llu:%02llu", s / 3600, (s / 60) % 60, s % 60);
  else snprintf(b, sizeof b, "%llu:%02llu", s / 60, s % 60);
  return b;
}
std::string fmtMs(int v){ return v < 0 ? std::string("-") : std::to_string(v) + " ms"; }
std::string plural(unsigned n, const char* word){
  return std::to_string(n) + " " + word + (n == 1 ? "" : "s");
}
void setLine(int i, const std::string& s){
  std::wstring w = W(s);
  if (w == U.lineText[i]) return;
  U.lineText[i] = w;
  SetWindowTextW(U.line[i], w.c_str());
}
void setLast(const std::string& s){
  std::wstring w = W(s);
  if (w == U.lastText) return;
  U.lastText = w;
  SetWindowTextW(U.last, w.c_str());
}
void setButton(int i, const std::string& s){
  std::wstring w = W(s);
  if (w == U.btnText[i]) return;
  U.btnText[i] = w;
  SetWindowTextW(U.btn[i], w.c_str());
}
void setCell(int row, int col, const std::string& s){
  if (U.cell[row][col] == s) return;
  U.cell[row][col] = s;
  std::wstring w = W(s);
  ListView_SetItemText(U.list, row, col, (LPWSTR)w.c_str());
}

/* ---- THE WHITELIST CELL EDITOR ----------------------------------------
   One EDIT control for the life of the window, moved over the clicked
   "Reserved for" cell and hidden again -- never destroyed inside its own
   kill-focus, which is the classic way to crash this.  Enter and losing
   the focus commit, Escape abandons; the relay sanitizes what it stores,
   so the cell shows back what the server actually kept. ---------------- */
void endEdit(bool commit){
  if (U.reserveRow < 0) return;
  const int row = U.reserveRow;
  U.reserveRow = -1;                      // before the hide: its kill-focus must no-op
  if (commit){
    wchar_t buf[64] = {};
    GetWindowTextW(U.reserve, buf, 63);
    relaySetReserved(row, A(buf));
  }
  ShowWindow(U.reserve, SW_HIDE);
  if (GetFocus() == U.reserve) SetFocus(U.list);
}
void beginEdit(int row){
  RelayStatus s = relayStatus();
  if (row < 0 || row >= RELAY_MAX_SEATS || !s.seats[row].available) return;
  if (U.reserveRow == row) return;
  endEdit(true);
  RECT rc{};
  if (!ListView_GetSubItemRect(U.list, row, COL_RESERVED, LVIR_BOUNDS, &rc)) return;
  MapWindowPoints(U.list, U.main, (POINT*)&rc, 2);
  U.reserveRow = row;
  SetWindowTextW(U.reserve, W(s.seats[row].reserved).c_str());
  MoveWindow(U.reserve, rc.left, rc.top - px(2), rc.right - rc.left, rc.bottom - rc.top + px(4), TRUE);
  ShowWindow(U.reserve, SW_SHOW);
  SetFocus(U.reserve);
  SendMessageW(U.reserve, EM_SETSEL, 0, -1);
}
LRESULT CALLBACK editProc(HWND h, UINT m, WPARAM w, LPARAM l, UINT_PTR, DWORD_PTR){
  switch (m){
    case WM_GETDLGCODE: return DLGC_WANTALLKEYS;      // Enter and Escape are ours
    case WM_KEYDOWN:
      if (w == VK_RETURN){ endEdit(true); return 0; }
      if (w == VK_ESCAPE){ endEdit(false); return 0; }
      break;
    case WM_CHAR:
      if (w == VK_RETURN || w == VK_ESCAPE) return 0;  // no MessageBeep
      break;
    case WM_KILLFOCUS: endEdit(true); break;
  }
  return DefSubclassProc(h, m, w, l);
}

/* ---- the log window -------------------------------------------------- */
void logLayout(){
  RECT r; GetClientRect(U.log, &r);
  int dpi = U.logDpi;
  int m = MulDiv(8, dpi, 96), bh = MulDiv(26, dpi, 96), bw = MulDiv(90, dpi, 96);
  MoveWindow(U.logEdit, m, m, r.right - 2 * m, r.bottom - 3 * m - bh, TRUE);
  MoveWindow(U.logBtn[0], m, r.bottom - m - bh, bw, bh, TRUE);
  MoveWindow(U.logBtn[1], m * 2 + bw, r.bottom - m - bh, bw, bh, TRUE);
}
void appendLog(const std::string& line){
  if (!U.logEdit) return;
  if (++U.logLines > LOG_MAX_LINES){
    int pos = (int)SendMessageW(U.logEdit, EM_LINEINDEX, LOG_TRIM_LINES, 0);
    if (pos > 0){
      SendMessageW(U.logEdit, EM_SETSEL, 0, pos);
      SendMessageW(U.logEdit, EM_REPLACESEL, FALSE, (LPARAM)L"");
      U.logLines -= LOG_TRIM_LINES;
    }
  }
  std::wstring w = W(line) + L"\r\n";
  int len = GetWindowTextLengthW(U.logEdit);
  SendMessageW(U.logEdit, EM_SETSEL, len, len);
  SendMessageW(U.logEdit, EM_REPLACESEL, FALSE, (LPARAM)w.c_str());
}
LRESULT CALLBACK logProc(HWND h, UINT m, WPARAM w, LPARAM l){
  switch (m){
    case WM_CREATE: {
      U.log = h;
      U.logDpi = (int)GetDpiForWindow(h);
      U.logEdit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
        WS_CHILD | WS_VISIBLE | WS_VSCROLL | WS_HSCROLL | ES_MULTILINE |
        ES_READONLY | ES_AUTOVSCROLL | ES_AUTOHSCROLL | ES_NOHIDESEL,
        0, 0, 0, 0, h, (HMENU)(INT_PTR)IDC_LOGEDIT, U.inst, nullptr);
      SendMessageW(U.logEdit, EM_SETLIMITTEXT, 0x7FFFFFFE, 0);
      U.logBtn[0] = CreateWindowExW(0, L"BUTTON", L"Copy all",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON, 0, 0, 0, 0, h,
        (HMENU)(INT_PTR)IDC_LOGCOPY, U.inst, nullptr);
      U.logBtn[1] = CreateWindowExW(0, L"BUTTON", L"Clear",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON, 0, 0, 0, 0, h,
        (HMENU)(INT_PTR)IDC_LOGCLEAR, U.inst, nullptr);
      makeLogFonts();
      logLayout();
      return 0;
    }
    case WM_SIZE: logLayout(); return 0;
    case WM_GETMINMAXINFO: {
      MINMAXINFO* mm = (MINMAXINFO*)l;
      mm->ptMinTrackSize.x = MulDiv(420, U.logDpi, 96);
      mm->ptMinTrackSize.y = MulDiv(240, U.logDpi, 96);
      return 0;
    }
    case WM_DPICHANGED: {
      U.logDpi = HIWORD(w);
      makeLogFonts();
      const RECT* rc = (const RECT*)l;
      SetWindowPos(h, nullptr, rc->left, rc->top, rc->right - rc->left,
                   rc->bottom - rc->top, SWP_NOZORDER | SWP_NOACTIVATE);
      logLayout();
      return 0;
    }
    case WM_COMMAND:
      if (LOWORD(w) == IDC_LOGCOPY){
        SendMessageW(U.logEdit, EM_SETSEL, 0, -1);
        SendMessageW(U.logEdit, WM_COPY, 0, 0);
        int len = GetWindowTextLengthW(U.logEdit);
        SendMessageW(U.logEdit, EM_SETSEL, len, len);
      } else if (LOWORD(w) == IDC_LOGCLEAR){
        SetWindowTextW(U.logEdit, L"");
        U.logLines = 0;
      }
      return 0;
    case WM_CLOSE:                          // hide; View > Log brings it back
      ShowWindow(h, SW_HIDE);
      CheckMenuItem(U.menu, IDM_LOG, MF_BYCOMMAND | MF_UNCHECKED);
      return 0;
  }
  return DefWindowProcW(h, m, w, l);
}
void showLog(bool on){
  if (!U.log) return;
  ShowWindow(U.log, on ? SW_SHOW : SW_HIDE);
  if (on) SetForegroundWindow(U.log);
  CheckMenuItem(U.menu, IDM_LOG, MF_BYCOMMAND | (on ? MF_CHECKED : MF_UNCHECKED));
}

/* ---- the main window ------------------------------------------------- */
void layout(){
  RECT r; GetClientRect(U.main, &r);
  int cw = r.right, ch = r.bottom;
  int m = px(12), lh = px(18), bh = px(28), bw = px(160), gap = px(8);
  int y = m;
  for (int i = 0; i < LINES; i++){
    MoveWindow(U.line[i], m, y, cw - 2 * m, lh * LINE_ROWS[i], TRUE);
    y += lh * LINE_ROWS[i] + px(2);
  }
  y += px(6);
  int listH = ch - y - px(4) - lh - gap - bh - gap - lh - m;
  if (listH < px(80)) listH = px(80);
  MoveWindow(U.list, m, y, cw - 2 * m, listH, TRUE);
  y += listH + px(4);
  MoveWindow(U.hint, m, y, cw - 2 * m, lh, TRUE);
  y += lh + gap;
  int x = m;
  for (int i = 0; i < 3; i++){ MoveWindow(U.btn[i], x, y, bw, bh, TRUE); x += bw + gap; }
  MoveWindow(U.btn[3], cw - m - px(110), y, px(110), bh, TRUE);     // Kick, at the right
  y += bh + gap;
  MoveWindow(U.last, m, y, cw - 2 * m, lh, TRUE);
  /* columns: fixed widths but the last, which takes the rest */
  int used = 0;
  for (int c = 0; c < COLS - 1; c++){ ListView_SetColumnWidth(U.list, c, px(COL_DIPS[c])); used += px(COL_DIPS[c]); }
  int rest = (cw - 2 * m) - used - GetSystemMetricsForDpi(SM_CXVSCROLL, U.dpi) - px(4);
  ListView_SetColumnWidth(U.list, COLS - 1, rest < px(COL_DIPS[COLS - 1]) ? px(COL_DIPS[COLS - 1]) : rest);
}
/* the four characters are the four rows, always -- a --seats 2 table
   still SHOWS the Wizard and the Elf, saying they are out of play */
void ensureRows(){
  if (U.rows == RELAY_MAX_SEATS) return;
  ListView_DeleteAllItems(U.list);
  for (int i = 0; i < RELAY_MAX_SEATS; i++){
    std::wstring nm = W(RELAY_CHAR_NAMES[i]);
    LVITEMW it{}; it.mask = LVIF_TEXT; it.iItem = i; it.pszText = (LPWSTR)nm.c_str();
    ListView_InsertItem(U.list, &it);
    for (int c = 0; c < COLS; c++) U.cell[i][c].clear();
    U.cell[i][COL_CHAR] = RELAY_CHAR_NAMES[i];
  }
  U.rows = RELAY_MAX_SEATS;
}
int selectedSeat(){
  int sel = ListView_GetNextItem(U.list, -1, LVNI_SELECTED);
  return sel;
}
void copyText(const std::string& s){
  if (!OpenClipboard(U.main)) return;
  EmptyClipboard();
  std::wstring w = W(s);
  HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, (w.size() + 1) * sizeof(wchar_t));
  if (h){
    void* p = GlobalLock(h);
    if (p){ memcpy(p, w.c_str(), (w.size() + 1) * sizeof(wchar_t)); GlobalUnlock(h); }
    SetClipboardData(CF_UNICODETEXT, h);
  }
  CloseClipboard();
}

/* the 4 Hz refresh: everything the window shows comes from here */
void refresh(){
  RelayStatus s = relayStatus();
  NatStatus n = natStatus();
  if (s.port) U.port = s.port;
  const std::string port = std::to_string(U.port);
  const uint64_t tNow = GetTickCount64();

  /* line 0: the local network */
  std::string lanUrl = "http://" + (s.lanIp.empty() ? std::string("<this PC's address>") : s.lanIp) + ":" + port + "/";
  setLine(0, "Local network:   " + lanUrl + "     (players on your own network)");

  /* line 1: the internet -- the address, or exactly why there is none */
  std::string inet, inetUrl;
  if (n.busy) inet = n.summary + "...";
  else if (n.active){
    const char* proto = n.pmp ? "NAT-PMP" : "UPnP";
    if (!n.warning.empty()) inet = n.warning;
    else if (!n.extIp.empty()){
      inetUrl = "http://" + n.extIp + ":" + std::to_string(n.extPort) + "/";
      inet = inetUrl + "     (port opened by " + proto + "; closes when this window does)";
    } else inet = std::string("port opened by ") + proto + ", but the router did not say its public address -- it is on the router's status page";
  }
  else if (!n.summary.empty()) inet = "not open -- " + n.summary;
  else inet = "not open -- Open port on router asks the router to let players in from outside";
  setLine(1, "Internet:            " + inet);
  if (!inetUrl.empty()){ U.shareUrl = inetUrl; U.shareWhat = "internet address"; }
  else { U.shareUrl = lanUrl; U.shareWhat = "local address"; }

  /* line 2: the session */
  {
    char b[256];
    if (s.seated == 0 && s.pass == 0)
      snprintf(b, sizeof b, "Session:   no players yet   |   up %s", fmtDur(tNow - s.startMs).c_str());
    else
      snprintf(b, sizeof b, "Session:   %d of %d characters in play   |   pass %u at %.1f a second%s   |   %s, %s   |   up %s",
               s.seated, s.seatsN, s.pass, s.passRate,
               s.syncing ? " (snapshot in flight)" : "",
               plural(s.desyncs, "desync").c_str(), plural(s.snapshots, "snapshot").c_str(),
               fmtDur(tNow - s.startMs).c_str());
    setLine(2, b);
  }
  /* line 3: the page */
  setLine(3, s.htmlPath.empty()
    ? "Page:        NO CLIENT PAGE FOUND -- put client\\gauntlet.html beside the exe (or --html); GET / answers 404"
    : "Page:        " + s.htmlPath + "   |   served " + plural(s.pages, "time") + "   |   " + plural((unsigned)s.conns, "connection") + " open");

  /* THE CHARACTER TABLE: one row per character, its reservation, and
     whoever is playing it */
  ensureRows();
  for (int i = 0; i < RELAY_MAX_SEATS; i++){
    const SeatStatus& q = s.seats[i];
    setCell(i, COL_RESERVED, q.reserved);
    if (!q.taken){
      for (int c = COL_PLAYER; c < COL_STATE; c++) setCell(i, c, "");
      setCell(i, COL_STATE, !q.available ? "off (--seats " + std::to_string(s.seatsN) + ")"
                          : q.reserved.empty() ? "free" : "waiting for " + q.reserved);
      continue;
    }
    setCell(i, COL_PLAYER, !q.name.empty() ? q.name : std::string("(no name)"));
    setCell(i, COL_ADDR, q.addr);
    setCell(i, COL_CONN, fmtDur(tNow - q.sinceMs));
    setCell(i, COL_PING, fmtMs(q.rttMs));
    setCell(i, COL_WORST, fmtMs(q.rttWorstMs));
    setCell(i, COL_WAIT, fmtMs(q.waitMs));
    setCell(i, COL_STATE, q.state);
  }

  /* the buttons and the Server menu */
  setButton(0, n.active ? "Close port on router" : "Open port on router");
  EnableWindow(U.btn[0], !n.busy);
  EnableMenuItem(U.menu, IDM_FORWARD, MF_BYCOMMAND | (n.busy ? MF_GRAYED : MF_ENABLED));
  ModifyMenuW(U.serverMenu, IDM_FORWARD, MF_BYCOMMAND | MF_STRING, IDM_FORWARD,
              n.active ? L"&Close port on router" : L"&Open port on router");
  setButton(1, "Copy " + U.shareWhat);
  ModifyMenuW(U.serverMenu, IDM_COPY, MF_BYCOMMAND | MF_STRING, IDM_COPY,
              (L"Copy " + W(U.shareWhat)).c_str());
  int sel = selectedSeat();
  bool canKick = sel >= 0 && sel < s.seatsN && s.seats[sel].taken;
  EnableWindow(U.btn[3], canKick);

  /* the log: drained here whether or not its window is showing */
  std::vector<std::string> lines = logTake();
  for (const std::string& ln : lines) appendLog(ln);
  if (!lines.empty()) setLast(lines.back());
}

void kickSelected(){
  RelayStatus s = relayStatus();
  int sel = selectedSeat();
  if (sel < 0 || sel >= RELAY_MAX_SEATS || !s.seats[sel].taken) return;
  const SeatStatus& q = s.seats[sel];
  std::string who = !q.name.empty() ? q.name : std::string("the unnamed player");
  std::wstring msg = W("Kick " + who + " (" + q.addr + "), playing the " +
                       RELAY_CHAR_NAMES[sel] + "?\n\nThe connection is closed and the "
                       "character frees for the next joiner" +
                       (q.reserved.empty() ? "." : " -- it is reserved for " + q.reserved + "."));
  if (MessageBoxW(U.main, msg.c_str(), TITLE, MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) == IDYES)
    relayKick(sel);
}
void about(){
  RelayStatus s = relayStatus();
  std::wstring msg = W(
    "Gauntlet Online Server\n\n"
    "The lockstep relay for the browser Gauntlet: it seats up to four players, "
    "relays one direction byte a pass, arbitrates fingerprints and moves a state "
    "snapshot to every joiner.  It never runs the game.\n\n"
    "Every launch opens this window; --console runs the terminal relay instead, "
    "the same server without it.\n\n"
    "The four characters are the four seats: reserve one for a player's options "
    "NAME and it is theirs whenever they join, overriding their own pick.\n\n"
    "Protocol v" + std::to_string(s.proto) + "   |   built " __DATE__ "\n"
    "https://github.com/cookertron/Gauntlet-JS-Online");
  MessageBoxW(U.main, msg.c_str(), L"About", MB_OK | MB_ICONINFORMATION);
}
void closeWindow(){
  RelayStatus s = relayStatus();
  if (s.seated > 0){
    std::wstring msg = W(plural((unsigned)s.seated, "player") +
      (s.seated == 1 ? " is" : " are") + " connected.  Stop the server?");
    if (MessageBoxW(U.main, msg.c_str(), TITLE, MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) != IDYES)
      return;
  }
  SetWindowTextW(U.main, L"Gauntlet Online Server -- closing");
  KillTimer(U.main, TIMER_ID);
  relayStop();
  /* the loop returns inside a quarter second; removing a router mapping
     can take a few more -- pump messages meanwhile so the window repaints */
  for (int i = 0; i < 300 && !relayDone(); i++){
    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)){ TranslateMessage(&msg); DispatchMessageW(&msg); }
    Sleep(50);
  }
  DestroyWindow(U.main);
}

LRESULT CALLBACK mainProc(HWND h, UINT m, WPARAM w, LPARAM l){
  switch (m){
    case WM_CREATE: {
      U.main = h;
      U.dpi = (int)GetDpiForWindow(h);
      for (int i = 0; i < LINES; i++)
        U.line[i] = CreateWindowExW(0, L"STATIC", L"", WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX,
                                    0, 0, 0, 0, h, (HMENU)(INT_PTR)(IDC_LINE0 + i), U.inst, nullptr);
      U.list = CreateWindowExW(0, WC_LISTVIEWW, L"",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | LVS_REPORT | LVS_SINGLESEL | LVS_SHOWSELALWAYS | LVS_NOSORTHEADER,
        0, 0, 0, 0, h, (HMENU)(INT_PTR)IDC_LIST, U.inst, nullptr);
      ListView_SetExtendedListViewStyle(U.list, LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER);
      for (int c = 0; c < COLS; c++){
        LVCOLUMNW col{}; col.mask = LVCF_TEXT | LVCF_WIDTH | LVCF_FMT;
        col.fmt = (c >= 5 && c <= 7) ? LVCFMT_RIGHT : LVCFMT_LEFT;
        col.cx = px(COL_DIPS[c]); col.pszText = (LPWSTR)COL_NAMES[c];
        ListView_InsertColumn(U.list, c, &col);
      }
      U.hint = CreateWindowExW(0, L"STATIC", HINT, WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX | SS_ENDELLIPSIS,
                               0, 0, 0, 0, h, (HMENU)(INT_PTR)(IDC_LINE0 + LINES), U.inst, nullptr);
      U.reserve = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
        WS_CHILD | ES_LEFT | ES_AUTOHSCROLL, 0, 0, 0, 0, h,
        (HMENU)(INT_PTR)IDC_RESERVE, U.inst, nullptr);
      SendMessageW(U.reserve, EM_SETLIMITTEXT, 8, 0);        // the options NAME row's own cap
      SetWindowSubclass(U.reserve, editProc, 1, 0);
      const wchar_t* labels[4] = { L"Open port on router", L"Copy address", L"Play in browser", L"Kick" };
      const int ids[4] = { IDC_FORWARD, IDC_COPY, IDC_PLAY, IDC_KICK };
      for (int i = 0; i < 4; i++)
        U.btn[i] = CreateWindowExW(0, L"BUTTON", labels[i], WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                                   0, 0, 0, 0, h, (HMENU)(INT_PTR)ids[i], U.inst, nullptr);
      EnableWindow(U.btn[3], FALSE);
      U.last = CreateWindowExW(0, L"STATIC", L"", WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX | SS_ENDELLIPSIS,
                               0, 0, 0, 0, h, (HMENU)(INT_PTR)IDC_LAST, U.inst, nullptr);
      makeFonts();
      ensureRows();
      layout();
      refresh();
      SetTimer(h, TIMER_ID, TIMER_MS, nullptr);
      return 0;
    }
    case WM_SIZE: endEdit(true); layout(); return 0;
    case WM_GETMINMAXINFO: {
      MINMAXINFO* mm = (MINMAXINFO*)l;
      mm->ptMinTrackSize.x = px(700);
      mm->ptMinTrackSize.y = px(420);
      return 0;
    }
    case WM_DPICHANGED: {
      U.dpi = HIWORD(w);
      endEdit(true);
      makeFonts();
      const RECT* rc = (const RECT*)l;
      SetWindowPos(h, nullptr, rc->left, rc->top, rc->right - rc->left, rc->bottom - rc->top,
                   SWP_NOZORDER | SWP_NOACTIVATE);
      layout();
      return 0;
    }
    case WM_TIMER: if (w == TIMER_ID) refresh(); return 0;
    case WM_NOTIFY: {
      const NMHDR* nm = (const NMHDR*)l;
      if (nm->idFrom != IDC_LIST) return 0;
      switch (nm->code){
        case LVN_ITEMCHANGED: {
          RelayStatus s = relayStatus();
          int sel = selectedSeat();
          EnableWindow(U.btn[3], sel >= 0 && sel < RELAY_MAX_SEATS && s.seats[sel].taken);
          break;
        }
        case NM_CLICK: case NM_DBLCLK: {
          const NMITEMACTIVATE* ia = (const NMITEMACTIVATE*)l;
          if (ia->iItem >= 0 && ia->iSubItem == COL_RESERVED) beginEdit(ia->iItem);
          else endEdit(true);
          break;
        }
        case LVN_KEYDOWN: {                     // F2 edits, as a grid should
          const NMLVKEYDOWN* kd = (const NMLVKEYDOWN*)l;
          if (kd->wVKey == VK_F2) beginEdit(selectedSeat());
          break;
        }
        case LVN_BEGINSCROLL: endEdit(true); break;   // the box does not follow the cell
      }
      return 0;
    }
    case WM_COMMAND:
      switch (LOWORD(w)){
        case IDM_FORWARD: case IDC_FORWARD: {
          NatStatus n = natStatus();
          if (!n.busy) relayForward(!n.active, U.port);
          refresh();
          return 0;
        }
        case IDM_COPY: case IDC_COPY:
          copyText(U.shareUrl);
          setLast("Copied " + U.shareUrl + " to the clipboard");
          return 0;
        case IDM_PLAY: case IDC_PLAY: {
          std::wstring url = W("http://localhost:" + std::to_string(U.port) + "/");
          ShellExecuteW(h, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
          return 0;
        }
        case IDC_KICK: kickSelected(); return 0;
        case IDM_LOG: showLog(!IsWindowVisible(U.log)); return 0;
        case IDM_ABOUT: about(); return 0;
        case IDM_EXIT: closeWindow(); return 0;
      }
      return 0;
    case WM_CLOSE: closeWindow(); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

} // namespace

int guiMain(uint16_t port){
  U.port = port;
  U.inst = GetModuleHandleW(nullptr);
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  INITCOMMONCONTROLSEX icc{ sizeof icc, ICC_LISTVIEW_CLASSES | ICC_STANDARD_CLASSES };
  InitCommonControlsEx(&icc);

  WNDCLASSEXW wc{}; wc.cbSize = sizeof wc;
  wc.lpfnWndProc = mainProc; wc.hInstance = U.inst;
  wc.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
  wc.lpszClassName = MAIN_CLASS;
  RegisterClassExW(&wc);
  WNDCLASSEXW lc = wc; lc.lpfnWndProc = logProc; lc.lpszClassName = LOG_CLASS;
  RegisterClassExW(&lc);

  /* the menu: Server (the port, the address, the page, exit), View (the
     log console, hidden until asked for), Help */
  U.menu = CreateMenu();
  U.serverMenu = CreatePopupMenu();
  AppendMenuW(U.serverMenu, MF_STRING, IDM_FORWARD, L"&Open port on router");
  AppendMenuW(U.serverMenu, MF_STRING, IDM_COPY, L"&Copy address");
  AppendMenuW(U.serverMenu, MF_STRING, IDM_PLAY, L"&Play in browser");
  AppendMenuW(U.serverMenu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(U.serverMenu, MF_STRING, IDM_EXIT, L"E&xit");
  AppendMenuW(U.menu, MF_POPUP, (UINT_PTR)U.serverMenu, L"&Server");
  U.viewMenu = CreatePopupMenu();
  AppendMenuW(U.viewMenu, MF_STRING, IDM_LOG, L"&Log");
  AppendMenuW(U.menu, MF_POPUP, (UINT_PTR)U.viewMenu, L"&View");
  HMENU help = CreatePopupMenu();
  AppendMenuW(help, MF_STRING, IDM_ABOUT, L"&About");
  AppendMenuW(U.menu, MF_POPUP, (UINT_PTR)help, L"&Help");

  int dpi = (int)GetDpiForSystem();
  HWND main = CreateWindowExW(0, MAIN_CLASS, TITLE, WS_OVERLAPPEDWINDOW,
    CW_USEDEFAULT, CW_USEDEFAULT, MulDiv(820, dpi, 96), MulDiv(460, dpi, 96),
    nullptr, U.menu, U.inst, nullptr);
  if (!main) return 1;
  /* the log console: owned by the main window, created hidden so its
     text accumulates from the first line; View > Log shows it */
  RECT mr; GetWindowRect(main, &mr);
  CreateWindowExW(0, LOG_CLASS, L"Gauntlet Online Server -- log", WS_OVERLAPPEDWINDOW,
    mr.left + MulDiv(40, dpi, 96), mr.top + MulDiv(40, dpi, 96),
    MulDiv(760, dpi, 96), MulDiv(420, dpi, 96), main, nullptr, U.inst, nullptr);
  ShowWindow(main, SW_SHOW);
  UpdateWindow(main);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0){
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return (int)msg.wParam;
}
