GAUNTLET ONLINE
===============

The 1986 ZX Spectrum Gauntlet (Gremlin Graphics for U.S. Gold), ported
faithfully to the browser, with online play for up to FOUR people.  One
person runs the server; everyone else opens a web address.  The server
is the game's own web page as well as its relay, so there is nothing
to install for players.

What is in this folder
----------------------
  gauntlet-relay.exe            the server (Windows, no installer)
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
1. Double-click relay-port-forwarding.bat.  Windows Firewall will ask
   on the first run: allow it, or nobody can connect.
2. The window prints a line like

       [relay] forward: share  http://81.2.3.4:33792/

   That is the address to give your players.  The server asked your
   router to open the port itself (NAT-PMP first, then UPnP) and keeps
   the mapping alive while it runs; closing the window or Ctrl+C stops
   the server and removes the mapping.  relay-unforward.bat removes a
   mapping that was left behind.
3. If the window says DOUBLE NAT, your router sits behind another box
   (an ISP modem).  The outer box must forward TCP port 33792 to the
   router too, or be put in bridge mode.  If it says carrier-grade NAT
   there is no way through from outside: play on the LAN, or use a
   tunnel.
4. For people on the same network, relay-lan-only.bat skips the router.
   Share http://<this PC's LAN address>:33792/ (ipconfig shows it).

Server options (add them after the exe name in a .bat)
   --port N       listen on port N (default 33792)
   --seats N      table size, 1 to 4 (default 4)
   --html PATH    serve a different page file
   --forward      open the port on the router
   --unforward    remove the router mapping and exit

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
