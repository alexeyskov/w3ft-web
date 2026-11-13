#!/usr/bin/env python3
"""Bounded range-request timings; run against localhost on the VPS or a URL.

No game is launched. The default test transfers at most 2.5 MiB. Compare the
same command at http://127.0.0.1:8080 on the VPS and against HTTPS from the
player's machine to distinguish origin/file-read delay from the network path.
"""
import argparse
import concurrent.futures
import json
import time
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen


def measure(url, size, timeout):
    started = time.perf_counter()
    request = Request(url, headers={'Range':f'bytes=0-{size-1}', 'Accept-Encoding':'identity'})
    with urlopen(request, timeout=timeout) as response:
        headers = time.perf_counter()
        if response.status != 206:
            raise RuntimeError(f'Expected byte ranges (HTTP 206), got {response.status}')
        first = response.read(1)
        first_byte = time.perf_counter()
        received = len(first)
        while received < size:
            block = response.read(min(256*1024, size-received))
            if not block:
                break
            received += len(block)
        finished = time.perf_counter()
        if received != size:
            raise RuntimeError(f'Incomplete range: {received}/{size} bytes')
        body = max(0.000001, finished-first_byte)
        return {'bytes':received, 'headersMs':round((headers-started)*1000,1),
                'firstByteMs':round((first_byte-started)*1000,1),
                'bodyMs':round((finished-first_byte)*1000,1),
                'totalMs':round((finished-started)*1000,1),
                'bodyMiBPerSecond':round(received/1048576/body,2),
                'server':response.headers.get('Server'),
                'cache':response.headers.get('CF-Cache-Status') or response.headers.get('X-Cache')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base_url', help='Explicit origin, e.g. http://127.0.0.1:8080')
    parser.add_argument('--asset', default='war3.mpq')
    parser.add_argument('--language', default='ru')
    parser.add_argument('--sizes-kib', nargs='+', type=int, default=[256,1024])
    parser.add_argument('--repeat', type=int, default=2)
    parser.add_argument('--concurrency', type=int, default=1)
    parser.add_argument('--timeout', type=float, default=30)
    args = parser.parse_args()
    base = urlsplit(args.base_url)
    if base.scheme not in ('http','https') or not base.netloc or base.username or base.password or base.query or base.fragment:
        parser.error('base_url must be an HTTP(S) origin without credentials, query or fragment')
    if not 1 <= args.repeat <= 10 or not 1 <= args.concurrency <= 6 or args.timeout <= 0:
        parser.error('repeat must be 1–10, concurrency 1–6 and timeout positive')
    sizes = args.sizes_kib*args.repeat
    if any(not 1 <= size <= 8192 for size in sizes) or sum(sizes) > 10240:
        parser.error('each range must be 1–8192 KiB; total transfer must not exceed 10 MiB')
    origin = f'{base.scheme}://{base.netloc}'
    with urlopen(origin+'/api/assets?'+urlencode({'language':args.language}), timeout=args.timeout) as response:
        data = response.read(1024*1024+1)
        if len(data) > 1024*1024:
            raise SystemExit('Asset manifest is too large')
        files = json.loads(data)['files']
    asset = next((file for file in files if file['path'].casefold() == args.asset.casefold()), None)
    if not asset:
        raise SystemExit('Requested asset is not listed by the server')
    url = urljoin(origin, asset['downloadUrl'])
    if urlsplit(url).netloc != base.netloc or urlsplit(url).scheme != base.scheme:
        raise SystemExit('The asset URL must belong to the same origin')
    if any(size*1024 > asset['size'] for size in sizes):
        raise SystemExit('Requested range exceeds the asset size')
    print(json.dumps({'origin':origin, 'asset':asset['path'], 'concurrency':args.concurrency,
                      'plannedBytes':sum(sizes)*1024}), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        for result in executor.map(lambda size: measure(url,size*1024,args.timeout), sizes):
            print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
