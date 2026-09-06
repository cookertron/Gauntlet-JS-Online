#!/usr/bin/env python3
"""package.py -- the deployable zip: the relay exe, the built page and its
.gz sibling, the batch files and the README from package/, plus a
VERSION.txt naming the build.

    python tools/package.py [tag]        -> dist/Gauntlet-JS-Online-<tag>.zip

`tag` defaults to today's date (v2026.09.04).  The zip unpacks to one
folder, Gauntlet-JS-Online-<tag>/, laid out the way gauntlet-relay.exe
looks for its page: client\\gauntlet.html beside the exe.  Build the
relay (ninja -C server/build) and the client (python tools/build.py)
first; this script refuses to package a missing file rather than ship
a broken folder.
"""
import datetime, os, subprocess, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tag = sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().strftime('v%Y.%m.%d')
name = 'Gauntlet-JS-Online-' + tag

def git(*args):
    try:
        return subprocess.check_output(['git'] + list(args), cwd=ROOT).decode().strip()
    except Exception:
        return '?'

files = [
    ('server/build/gauntlet-relay.exe', 'gauntlet-relay.exe'),
    ('client/gauntlet.html', 'client/gauntlet.html'),
    ('client/gauntlet.html.gz', 'client/gauntlet.html.gz'),
]
pkg = os.path.join(ROOT, 'package')
for fn in sorted(os.listdir(pkg)):
    files.append(('package/' + fn, fn))

missing = [src for src, _ in files if not os.path.isfile(os.path.join(ROOT, src))]
if missing:
    print('missing: ' + ', '.join(missing))
    print('build the relay (ninja -C server/build) and the client (python tools/build.py) first')
    sys.exit(1)

# a DEBUG exe imports the debug CRT DLLs (ucrtbased, VCRUNTIME140D, ...),
# which exist only where Visual Studio is installed -- it runs on the
# build machine and nowhere else (found on a second machine 2026-09-05).
# The import names sit in the exe as plain text: refuse to ship one.
with open(os.path.join(ROOT, files[0][0]), 'rb') as f:
    exe = f.read()
debug_dlls = [n for n in (b'ucrtbased.dll', b'VCRUNTIME140D.dll', b'MSVCP140D.dll', b'VCRUNTIME140_1D.dll')
              if n in exe]
if debug_dlls:
    print('the relay exe is a DEBUG build (it imports ' + ', '.join(n.decode() for n in debug_dlls) + ')')
    print('reconfigure Release: cmake -S server -B server/build -G Ninja -DCMAKE_BUILD_TYPE=Release && ninja -C server/build')
    sys.exit(1)
if b'VCRUNTIME140.dll' in exe or b'MSVCP140.dll' in exe:
    print('the relay exe links the CRT as DLLs -- it needs the VC++ redistributable on every host machine')
    print('CMakeLists.txt sets the static runtime (/MT); reconfigure from a clean build directory')
    sys.exit(1)

version = ('Gauntlet Online %s\ncommit %s\nbuilt %s\n'
           % (tag, git('rev-parse', '--short', 'HEAD'),
              datetime.datetime.now().strftime('%Y-%m-%d %H:%M')))

dist = os.path.join(ROOT, 'dist')
os.makedirs(dist, exist_ok=True)
out = os.path.join(dist, name + '.zip')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for src, dst in files:
        z.write(os.path.join(ROOT, src), name + '/' + dst)
    z.writestr(name + '/VERSION.txt', version)
    for info in z.infolist():
        print('  %9d  %s' % (info.file_size, info.filename))
print('wrote %s (%d bytes)' % (out, os.path.getsize(out)))
