#!/usr/bin/env python3
"""Package the real WASM reactor with diagnostic host; never declare it playable."""
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def main():
    target = ROOT / 'var/runtime'
    build = json.loads((target / 'build.json').read_text())
    with (target / 'wc3.wasm').open('rb') as wasm:
        magic = wasm.read(8)
    if not build.get('wasm_built') or magic != b'\0asm\x01\0\0\0':
        raise SystemExit('Build the WASM reactor before packaging')
    for source in (ROOT / 'web/runtime').glob('*.mjs'):
        shutil.copy2(source, target / source.name)
    # Keep the source-license notices accessible with a deployed runtime.
    # These do not license the game's code/data or replace SDK-library notices.
    for source, name in [(ROOT / 'LICENSE', 'LICENSE.txt'),
                         (ROOT / 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.txt')]:
        shutil.copy2(source, target / name)
    manifest = {'abi': 'wc3-browser-v1', 'module': 'client.mjs', 'wasm': 'wc3.wasm',
                'diagnostics': True, 'graphics': 'webgl2',
                'capabilities': {'campaign': False, 'skirmish': False, 'multiplayer': False}}
    (target / 'runtime.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Packaged Warcraft runtime; gameplay capabilities remain disabled.')


if __name__ == '__main__':
    main()
