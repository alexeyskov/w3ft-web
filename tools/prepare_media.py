#!/usr/bin/env python3
"""Convert the installation's AVI cinematics to browser-decodable static media.

The original Movies/*.mpq files are AVI containers with the BLZ0 MPEG-4 tag,
not MPQ archives. This tool never runs game code or changes original assets.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def prepare(game, selected=None):
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    if not ffmpeg or not ffprobe:
        raise SystemExit('Install FFmpeg (ffmpeg and ffprobe) to prepare cinematics')
    output = game / 'WebMedia'
    output.mkdir(exist_ok=True)
    manifest_path = output / 'media.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'schemaVersion': 1, 'movies': {}}
    for source in sorted((game / 'Movies').iterdir(), key=lambda p: (p.stem.lower() != 'introx', p.name)):
        if not source.is_file() or source.is_symlink() or selected and source.stem.lower() != selected.lower():
            continue
        with source.open('rb') as stream:
            signature = stream.read(12)
        if signature[:4] != b'RIFF' or signature[8:12] != b'AVI ':
            continue
        original = source.relative_to(game).as_posix()
        with source.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        previous = manifest['movies'].get(original.lower())
        if previous and previous['sourceSha256'] == digest and (game / previous['path']).is_file():
            print(f'Cached {original}', flush=True)
            continue
        metadata = json.loads(subprocess.check_output([ffprobe, '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(source)]))
        video = next(s for s in metadata['streams'] if s['codec_type'] == 'video')
        target = output / (source.stem + '.webm')
        temporary = target.with_suffix('.partial.webm')
        print(f'Converting {original}', flush=True)
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(source),
                        '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libvpx', '-deadline', 'good',
                        '-cpu-used', '5', '-threads', '4', '-crf', '10', '-b:v', '1800k', '-pix_fmt', 'yuv420p',
                        '-c:a', 'libopus', '-b:a', '128k', str(temporary)], check=True)
        temporary.replace(target)
        manifest['movies'][original.lower()] = {'sourceSha256': digest, 'path': target.relative_to(game).as_posix(),
                                                'width': video['width'], 'height': video['height'],
                                                'duration': float(metadata['format']['duration']),
                                                'frameRate': video['avg_frame_rate']}
        manifest_path.with_suffix('.tmp').write_text(json.dumps(manifest, indent=2) + '\n')
        manifest_path.with_suffix('.tmp').replace(manifest_path)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, default=ROOT / 'var/game')
    parser.add_argument('--movie', help='Prepare only this movie stem, e.g. IntroX')
    args = parser.parse_args()
    prepare(args.game, args.movie)
