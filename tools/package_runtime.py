#!/usr/bin/env python3
"""Package the real WASM reactor with diagnostic host; never declare it playable."""
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
# What both builds must share: the compat build differs only in how tail jumps
# are made (tools/build_runtime.py --variant compat).
SHARED = ('modules', 'runtime_headers', 'strict_memory', 'link_flags')


def compat_build(target, build):
    """wc3-compat.wasm for engines without tail calls, if built from the same code."""
    wasm, metadata = target / 'wc3-compat.wasm', target / 'build-compat.json'
    if not wasm.is_file() and not metadata.is_file():
        print('No wc3-compat.wasm: browsers without WebAssembly tail calls are asked to update '
              '(tools/build_runtime.py --variant compat builds it).')
        return None
    rebuild = 'Run tools/build_runtime.py --variant compat (make runtime builds both).'
    if not wasm.is_file() or not metadata.is_file():
        raise SystemExit(f'wc3-compat.wasm or build-compat.json is missing. {rebuild}')
    compat = json.loads(metadata.read_text())
    sources = lambda value: sorted((item['source'], item['sha256']) for item in value['sources'])
    if (compat.get('variant') != 'compat' or '+tail-call' in compat.get('features', ['+tail-call'])
            or any(compat.get(key) != build.get(key) for key in SHARED) or sources(compat) != sources(build)
            or compat['configuration']['version'] != build['configuration']['version']):
        raise SystemExit(f'wc3-compat.wasm was not built from the same code as wc3.wasm. {rebuild}')
    hasher = hashlib.sha256()
    with wasm.open('rb') as stream:
        while chunk := stream.read(1 << 20):
            hasher.update(chunk)
    if hasher.hexdigest() != compat['sha256']:
        raise SystemExit(f'wc3-compat.wasm does not match build-compat.json. {rebuild}')
    return wasm.name


def main():
    target = ROOT / 'var/runtime'
    build = json.loads((target / 'build.json').read_text())
    with (target / 'wc3.wasm').open('rb') as wasm:
        magic = wasm.read(8)
    if not build.get('wasm_built') or magic != b'\0asm\x01\0\0\0':
        raise SystemExit('Build the WASM reactor before packaging')
    compat = compat_build(target, build)
    for source in (ROOT / 'web/runtime').glob('*.mjs'):
        shutil.copy2(source, target / source.name)
    # Keep the source-license notices accessible with a deployed runtime.
    # These do not license the game's code/data or replace SDK-library notices.
    for source, name in [(ROOT / 'LICENSE', 'LICENSE.txt'),
                         (ROOT / 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.txt')]:
        shutil.copy2(source, target / name)
    manifest = {'abi': 'wc3-browser-v1', 'module': 'client.mjs', 'wasm': 'wc3.wasm',
                **({'wasmCompat': compat} if compat else {}),
                'diagnostics': True, 'graphics': 'webgl2',
                'capabilities': {'campaign': False, 'skirmish': False, 'multiplayer': False}}
    (target / 'runtime.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Packaged Warcraft runtime' + (' with the build for browsers without tail calls' if compat else '')
          + '; gameplay capabilities remain disabled.')


if __name__ == '__main__':
    main()
