#!/usr/bin/env python3
"""Plan OPFS blocks from your own MPQ tables/listfiles; never extract payloads.

Menus -> multiplayer UI -> common match assets -> campaign/unclassified data.
Lists from all installed editions are shared as filename candidates, including
for patch archives without a listfile. Unknown members remain in the final
phase, so an incomplete/unsupported listfile cannot omit game data.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.app import asset_entries, game_languages, localized_assets
from tools.mpq_reader import MPQReader

BLOCK = 256 * 1024
PHASES = ('menu', 'multiplayer', 'match', 'campaign')


def member_phase(member):
    name = member.decode('utf-8', errors='replace').replace('\\', '/').lower()
    if re.search(r'campaign|sound/dialogue|/cinematic|\.w3n$', name):
        return 3
    if re.search(r'multiplayer|battlenet|/lan\b|/chat\b', name):
        return 1
    if re.search(r'^(ui|font|fonts)/|\.(fdf|toc)$', name):
        return 0
    return 2


def ranges(blocks):
    result = []
    for block in blocks:
        if result and result[-1][1] + 1 == block:
            result[-1][1] = block
        else:
            result.append([block, block])
    return result


def archive_phases(archive, size, candidates):
    ranks = bytearray([3]) * ((size + BLOCK - 1) // BLOCK)

    def mark(start, length, rank):
        if start < 0 or length <= 0 or start + length > size:
            return
        for index in range(start // BLOCK, (start + length - 1) // BLOCK + 1):
            ranks[index] = min(ranks[index], rank)

    header = archive.header
    offset = header['offset']
    mark(offset, header['header_size'], 0)
    for table in ('hash', 'block'):
        mark(offset + header[f'{table}_table_offset'], header[f'{table}_table_entries'] * 16, 0)
    table = {(entry.hash_a, entry.hash_b): entry for entry in archive.hash_table}
    for member in candidates:
        entry = table.get((archive._archive._hash(member, 'HASH_A'), archive._archive._hash(member, 'HASH_B')))
        if entry is None or not 0 <= entry.block_table_index < len(archive.block_table):
            continue
        block = archive.block_table[entry.block_table_index]
        if block.flags & 0x80000000 and not block.flags & 0x02000000:
            mark(offset + block.offset, block.archived_size, member_phase(member))
    return {phase: ranges(i for i, rank in enumerate(ranks) if rank == n) for n, phase in enumerate(PHASES)}


def generate(game, locales, output, base_language='ru', languages=None):
    languages = languages or game_languages(base_language, locales)
    sources = {}
    for directory in (game, *(sorted(locales.iterdir()) if locales.is_dir() else ())):
        if not directory.is_dir():
            continue
        for entry in asset_entries(directory):
            if entry['path'].lower().endswith('.mpq') and '/' not in entry['path']:
                sources[directory / entry['path']] = None
    with ExitStack() as stack:
        candidates = {b'(listfile)', b'(attributes)'}
        for path in sources:
            try:
                archive = MPQReader(path)
                stack.callback(archive.file.close)
                sources[path] = archive
                try:
                    candidates.update((archive.read_file(b'(listfile)') or b'').splitlines())
                except (ValueError, NotImplementedError) as error:
                    print(f'{path.name}: listfile unavailable ({error}); using names from other archives.', flush=True)
            except (OSError, ValueError) as error:
                print(f'{path.name}: no classified plan ({error}).', flush=True)
        candidates.discard(b'')
        by_root = {}
        for path, archive in sources.items():
            by_root.setdefault(path.parent, {})[path.name.lower()] = (path, archive)
        output.mkdir(parents=True, exist_ok=True)
        for language in languages:
            files = []
            for item in localized_assets(game, locales, base_language, language):
                root = locales / language if item.get('language') else game
                source = by_root.get(root, {}).get(item['path'].lower())
                if not source or not source[1]:
                    continue
                phases = archive_phases(source[1], item['size'], candidates)
                files.append({k: item[k] for k in ('path', 'size', 'version')} | {'phases': phases})
            result = {'schemaVersion': 1, 'blockSize': BLOCK, 'language': language, 'files': files}
            target = output / f'download-plan-{language}.json'
            temporary = target.with_suffix('.partial')
            temporary.write_text(json.dumps(result, separators=(',', ':')) + '\n')
            os.replace(temporary, target)
            counts = {phase: sum(sum(last-first+1 for first,last in f['phases'][phase]) for f in files) for phase in PHASES}
            print(f'{target}: {len(files)} archives, classified blocks {counts}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-dir', type=Path, default=ROOT / 'var/game')
    parser.add_argument('--locales-dir', type=Path, default=ROOT / 'var/locales')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'var/runtime')
    parser.add_argument('--base-language', default='ru')
    args = parser.parse_args()
    generate(args.game_dir, args.locales_dir, args.output_dir, args.base_language)
