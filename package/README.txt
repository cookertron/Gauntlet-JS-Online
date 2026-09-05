GAUNTLET ONLINE
===============

The 1986 ZX Spectrum Gauntlet (Gremlin Graphics for U.S. Gold), ported
faithfully to the browser, with online play for up to FOUR people.  One
person runs the server; everyone else opens a web address.  The server
is the game's own web page as well as its relay, so there is nothing
to install for players.

What is in this folder
----------------------
  gauntlet-relay.exe            the server (Windows, no installer);
                                double-click it for the server window
  client\gauntlet.html          the game page the server hands out
  client\gauntlet.html.gz       the same page compressed, for joiners
  relay-port-forwarding.bat     run the server and open the port
  relay-lan-only.bat            run the server for the local network
  relay-unforward.bat           remove the router mapping by hand
  VERSION.txt                   which build this is

Keep the exe and the client folder together: the server looks for
client\gauntlet.html next to itself.

Hosting a game
--------------
1. Double-click gauntlet-relay.exe.  A window opens.  Windows Firewall
   asks on the first run: allow it, or nobody can connect.
2. Press "Open port on router".  The server asks your router to open
   the port itself (NAT-PMP first, then UPnP) and the Internet line
   shows the address to give your players; "Copy internet address"
   puts it on the clipboard.  The mapping is kept alive while the
   server runs and removed when the window closes.
3. If the Internet line says DOUBLE NAT, your router sits behind
   another box (an ISP modem).  The outer box must forward TCP port
   33792 to the router too, or be put in bridge mode.  If it says
   carrier-grade NAT there is no way through from outside: play on the
   LAN, or use a tunnel.
4. People on your own network use the Local network address (the
   first line of the window).  "Play in browser" opens the game on
   this PC.

The window shows every seat: the player's name and character, their
address, how long they have been connected, the ping the server
measures to them (the median of the last eight seconds and the worst),
how long their moves wait for the rest of the party -- the seat that
never waits is the one holding everyone up -- and their state.  Select
a seat and press Kick to drop that player; the seat frees and they can
join again.  View > Log opens the console: every event with a
timestamp, chat lines included; "Copy all" puts it on the clipboard
for a bug report.

The batch files run the same exe without the window; its log prints in
the console instead and Ctrl+C stops it:
  relay-port-forwarding.bat   the server with the router port opened
  relay-lan-only.bat          the server for your own network only
  relay-unforward.bat         remove a mapping that was left behind

Server options (add them after the exe name in a .bat)
   --port N       listen on port N (default 33792)
   --seats N      table size, 1 to 4 (default 4)
   --html PATH    serve a different page file
   --forward      open the port on the router at once
   --unforward    remove the router mapping and exit
   --gui          open the window even with other options
   --console      never open the window

Playing
-------
Open the address in a browser.  The options screen: UP and DOWN move
between options, LEFT and RIGHT toggle, ENTER modifies.  Pick a
character and a NAME (up to 8 letters; it floats over your head when
players meet), make sure SERVER says ONLINE, and choose START GAME.
You drop straight into whatever game is running.  Whoever presses FIRE
is in; a dead player comes back with FIRE too.  When the whole party is
dead you see everyone's scores, then land back on the options screen:
START joins again.

Keyboard (the defaults -- change them under REBIND KEYS)
   1  up      Q  down      S  left      D  right
   Z  fire    CAPS SHIFT  potion

Gamepad (choose it under INPUT)
   stick or d-pad   move
   A, X or Y        fire
   B or a shoulder  potion
   A also acts as ENTER on the options screen

In the game
   ENTER            open a line of chat; ENTER again sends it (up to 32
                    characters, drawn as a speech bubble over your
                    character; an empty ENTER just closes the line)
   Alt+Enter        full screen (or double-click the game, or the small
                    corner button); Alt+Enter or Escape comes back

Notes
   * Everyone sees their own view of the dungeon; the game itself is
     the same on every screen.
   * Leaving the browser tab is fine: the game keeps time while you are
     away and you are playable the moment you come back.
   * The original's hurry-up (doors opening, then every wall becoming
     an exit, after minutes without a shot or a pickup) is off in this
     build.
   * If a session stutters, press F12 in the browser, type
       __GAUNTLET__.net.info()
     in the console and send the line that comes back.  It names the
     link's round trip and who is waiting for whom.

After updating
--------------
Replace the files in this folder and restart the server; players just
refresh the page.  A player who sees VERSION MISMATCH has an old page:
a refresh fixes it.

Source: https://github.com/cookertron/Gauntlet-JS-Online
