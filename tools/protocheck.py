#!/usr/bin/env python3
"""protocheck.py -- shared/protocol.json and server/relay.cpp must agree.

The JSON is the single source of truth; the C++ mirrors it in one marked
block ("==== protocol constants").  This checker maps every JSON value to
its expected C++ name, parses the block, and fails on any mismatch --
including a constant present on one side only, so the two cannot drift
by addition either.

    python tools/protocheck.py
"""
import json, re, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_PATH = os.path.join(ROOT, 'shared', 'protocol.json')
CPP_PATH = os.path.join(ROOT, 'server', 'relay.cpp')

with open(JSON_PATH, encoding='utf-8') as f:
    P = json.load(f)

# the mapping IS the naming convention, written out
expected = {
    'PROTO_VERSION': P['version'],
    'DEFAULT_PORT': P['port'],
    'MAX_SEATS': P['maxSeats'],
    'DEFAULT_SEATS': P['defaultSeats'],
    'FP_EVERY': P['fpEvery'],
    'NAME_LEN': P['nameLen'],
    'LIM_FRAME_MAX': P['limits']['frameMax'],
    'LIM_MESSAGE_MAX': P['limits']['messageMax'],
    'LIM_HANDSHAKE_MAX': P['limits']['handshakeMax'],
    'LIM_INPUT_MS': P['limits']['inputTimeoutMs'],
    'LIM_HANDSHAKE_MS': P['limits']['handshakeTimeoutMs'],
    'LIM_SYNC_MS': P['limits']['syncTimeoutMs'],
}
for name, v in P['msgs'].items():
    expected['MSG_' + name] = v
for name, v in P['errors'].items():
    expected['ERR_' + name] = v
for name, v in P['welcomeModes'].items():
    expected['MODE_' + name] = v

with open(CPP_PATH, encoding='utf-8') as f:
    src = f.read()
m = re.search(r'/\* ==== protocol constants.*?==== end protocol constants',
              src, re.S)
if not m:
    print('FAIL  relay.cpp has no marked protocol-constants block')
    sys.exit(1)
block = m.group(0)
found = {name: int(val) for name, val in
         re.findall(r'constexpr\s+\w+\s+(\w+)\s*=\s*(\d+)\s*;', block)}

fails = 0
for name, want in sorted(expected.items()):
    if name not in found:
        print(f'FAIL  {name} = {want} in protocol.json, missing from relay.cpp')
        fails += 1
    elif found[name] != want:
        print(f'FAIL  {name}: protocol.json says {want}, relay.cpp says {found[name]}')
        fails += 1
for name in sorted(found):
    if name not in expected:
        print(f'FAIL  {name} in relay.cpp has no protocol.json source')
        fails += 1

n = len(expected)
if fails:
    print(f'{n - fails}/{n} protocol constants agree')
    sys.exit(1)
print(f'{n}/{n} protocol constants agree')
