import asyncio
import json
from pathlib import Path
import struct
import tempfile
import unittest

from aiohttp import WSMsgType, WSServerHandshakeError, web
from aiohttp.test_utils import AioHTTPTestCase

from server.geoip import Ranges, load_ranges
from server.app import STATE, asset_entries, create_app, byte_range, runtime_status


class CountryRangeTests(unittest.TestCase):
    def test_ranges_merge_and_match_bounds(self):
        ranges = Ranges([(30, 40), (10, 20), (21, 25), (15, 18), (50, 50)])
        self.assertEqual(len(ranges), 3)
        self.assertEqual([value for value in range(60) if value in ranges],
                         [*range(10, 26), *range(30, 41), 50])

    def test_malformed_database_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'countries.csv'
            for text in ('5.0.0.0,5.0.0.255\n', '5.0.0.9,5.0.0.1,RU\n', '5.0.0.0,2a02::,RU\n'):
                path.write_text(text)
                with self.assertRaises(ValueError):
                    load_ranges(path)


class CompressionTests(unittest.TestCase):
    def test_accept_encoding(self):
        from server.compression import accepts_gzip, compressible
        for header, expected in (('gzip, deflate, br', True), ('br;q=1.0, gzip;q=0.8', True), ('GZIP', True), ('x-gzip', True),
                                 ('identity', False), ('', False), (None, False), ('gzip;q=0', False), ('gzip;q=0, *', False),
                                 ('*', True), ('br, *;q=0', False), ('gzip;q=bad', False)):
            self.assertEqual(accepts_gzip(header), expected, header)
        self.assertTrue(compressible('wc3.wasm', 2048))
        self.assertTrue(compressible('Game.DLL', 2048))
        self.assertFalse(compressible('war3.mpq', 2048))
        self.assertFalse(compressible('IntroX.webm', 2048))
        self.assertFalse(compressible('tiny.mjs', 100))


class RangeTests(unittest.TestCase):
    def test_suffix_and_clamped_ranges(self):
        self.assertEqual(byte_range('bytes=-3', 10), (7, 9, 206))
        self.assertEqual(byte_range('bytes=8-200', 10), (8, 9, 206))
        self.assertEqual(byte_range('bytes=0-', 10), (0, 9, 206))
        self.assertEqual(byte_range(None, 0), (0, -1, 200))

    def test_invalid_ranges(self):
        for value in ('bytes=-0', 'bytes=10-', 'bytes=8-2', 'bytes=0-1,5-6', 'bytes=-', 'other=0-1'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                byte_range(value, 10)

    def test_runtime_rejects_bad_or_escaping_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertFalse(runtime_status(root)['installed'])
            (root / 'runtime.json').write_text(json.dumps({'abi': 'wc3-browser-v1', 'module': '../x.mjs', 'wasm': 'x.wasm'}))
            self.assertFalse(runtime_status(root)['installed'])
            (root / 'runtime.json').write_text('null')
            self.assertFalse(runtime_status(root)['installed'])
            # A valid runtime reports its module's uncompressed size (launcher progress).
            (root / 'client.mjs').write_text('export {};\n')
            (root / 'wc3.wasm').write_bytes(b'\0asm\x01\0\0\0' + bytes(100))
            (root / 'runtime.json').write_text(json.dumps({'abi': 'wc3-browser-v1', 'module': 'client.mjs', 'wasm': 'wc3.wasm'}))
            status = runtime_status(root)
            self.assertTrue(status['installed'])
            self.assertEqual((status['wasmUrl'], status['wasmSize']), ('/runtime/wc3.wasm', 108))
            self.assertNotIn('compatWasmUrl', status)

    def test_runtime_compat_build_is_optional(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'client.mjs').write_text('export {};\n')
            (root / 'wc3.wasm').write_bytes(b'\0asm\x01\0\0\0' + bytes(100))
            manifest = {'abi': 'wc3-browser-v1', 'module': 'client.mjs', 'wasm': 'wc3.wasm', 'wasmCompat': 'wc3-compat.wasm'}
            (root / 'runtime.json').write_text(json.dumps(manifest))
            # Not uploaded, or not a module: the main build still serves current browsers.
            for content in (None, b'not a module'):
                if content:
                    (root / 'wc3-compat.wasm').write_bytes(content)
                status = runtime_status(root)
                self.assertTrue(status['installed'])
                self.assertNotIn('compatWasmUrl', status)
            (root / 'wc3-compat.wasm').write_bytes(b'\0asm\x01\0\0\0' + bytes(200))
            status = runtime_status(root)
            self.assertEqual((status['wasmUrl'], status['compatWasmUrl'], status['compatWasmSize']),
                             ('/runtime/wc3.wasm', '/runtime/wc3-compat.wasm', 208))
            (root / 'runtime.json').write_text(json.dumps({**manifest, 'wasmCompat': '../wc3-compat.wasm'}))
            status = runtime_status(root)
            self.assertTrue(status['installed'])
            self.assertNotIn('compatWasmUrl', status)


class ClientDisconnectTests(unittest.IsolatedAsyncioTestCase):
    async def test_dropped_download_is_not_a_server_error(self):
        # Browsers drop downloads mid-stream: a video element switching byte
        # ranges, a Worker stopped with the game, a closed page. web.run_app
        # does not cancel handlers, so the server's next write fails; that must
        # end the response quietly instead of logging an unhandled exception.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'game').mkdir()
            (root / 'maps').mkdir()
            (root / 'game' / 'movie.webm').write_bytes(bytes(32 * 1024 * 1024))
            runner = web.AppRunner(create_app(game_dir=root / 'game', maps_dir=root / 'maps', runtime_dir=root / 'runtime',
                                              report_path=root / 'report.json'), handler_cancellation=False)
            await runner.setup()
            site = web.TCPSite(runner, '127.0.0.1', 0)
            await site.start()
            try:
                host, port = runner.addresses[0][:2]
                url = asset_entries(root / 'game')[0]['downloadUrl']
                idle = len(asyncio.all_tasks())  # this test and the server's own background tasks
                with self.assertNoLogs('aiohttp.server', level='ERROR'):
                    reader, writer = await asyncio.open_connection(host, port)
                    writer.write(f'GET {url} HTTP/1.1\r\nHost: test\r\nRange: bytes=0-\r\n\r\n'.encode())
                    await writer.drain()
                    self.assertIn(b' 206 ', await reader.readline())
                    await reader.read(65536)
                    writer.transport.abort()
                    for _ in range(300):
                        await asyncio.sleep(0.01)
                        if len(asyncio.all_tasks()) == idle:
                            break
                    self.assertEqual(len(asyncio.all_tasks()), idle, 'the dropped download is still being served')
            finally:
                await runner.cleanup()


class ServerTests(AioHTTPTestCase):
    async def get_application(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'maps').mkdir()
        self.map_data = (b'HM3W' + b'\0' * 4 + b'Test Map\0' + struct.pack('<II', 0, 4)).ljust(512, b'\0') + b'MPQ\x1a' + bytes(range(256))
        (self.root / 'maps' / 'Test.w3m').write_bytes(self.map_data)
        (self.root / 'game').mkdir()
        (self.root / 'game' / 'war3.mpq').write_bytes(b'0123456789')
        (self.root / 'game' / 'secret.mpq').symlink_to(self.root / 'private.txt')
        (self.root / 'private.txt').write_text('must not be served')
        (self.root / 'countries.csv').write_text('0.0.0.0,0.255.255.255,ZZ\n5.0.0.0,5.0.0.255,RU\n5.0.1.0,5.0.1.255,KZ\n'
                                                 '8.8.8.0,8.8.8.255,US\n2a02:6b8::,2a02:6b8:ffff:ffff:ffff:ffff:ffff:ffff,RU\n')
        return create_app(game_dir=self.root / 'game', maps_dir=self.root / 'maps', locales_dir=self.root / 'locales',
                          runtime_dir=self.root / 'runtime', report_path=self.root / 'report.json',
                          geoip_path=self.root / 'countries.csv')

    async def tearDownAsync(self):
        await super().tearDownAsync()
        self.temp.cleanup()

    async def test_status_never_claims_missing_runtime_is_playable(self):
        response = await self.client.get('/api/status')
        status = await response.json()
        self.assertFalse(status['runtime']['installed'])
        self.assertFalse(status['runtime']['playableVerified'])
        self.assertFalse(status['runtime']['capabilities']['campaign'])
        self.assertFalse(status['transport']['gameNetworkingImplemented'])
        self.assertEqual(response.headers['Cross-Origin-Embedder-Policy'], 'require-corp')

    async def test_map_catalog_download_range_and_head(self):
        catalog = await (await self.client.get('/api/maps')).json()
        self.assertEqual(catalog['count'], 1)
        entry = catalog['maps'][0]
        self.assertEqual(entry['maxPlayers'], 4)
        response = await self.client.get(entry['downloadUrl'])
        self.assertEqual(await response.read(), self.map_data)
        self.assertIn('Test.w3m', response.headers['Content-Disposition'])
        response = await self.client.get(entry['downloadUrl'], headers={'Range': 'bytes=512-515'})
        self.assertEqual(response.status, 206)
        self.assertEqual(await response.read(), b'MPQ\x1a')
        self.assertEqual(response.headers['Content-Range'], f'bytes 512-515/{len(self.map_data)}')
        response = await self.client.head(entry['downloadUrl'])
        self.assertEqual(int(response.headers['Content-Length']), len(self.map_data))
        self.assertEqual(await response.read(), b'')
        response = await self.client.get(entry['downloadUrl'], headers={'Range': 'bytes=999999-'})
        self.assertEqual(response.status, 416)
        response = await self.client.get(entry['downloadUrl'], headers={'Range': 'bytes=512-', 'If-Range': '"old-map"'})
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.read(), self.map_data)

    async def test_assets_stream_and_do_not_follow_symlinks(self):
        assets = await (await self.client.get('/api/assets')).json()
        self.assertEqual(len(assets['files']), 1)
        response = await self.client.get(assets['files'][0]['downloadUrl'], headers={'Range': 'bytes=-3'})
        self.assertEqual(await response.read(), b'789')
        path = self.root / 'game' / 'war3.mpq'
        path.unlink()
        path.symlink_to(self.root / 'private.txt')
        response = await self.client.get(assets['files'][0]['downloadUrl'])
        self.assertEqual(response.status, 404)

    async def test_game_language_replaces_localized_archives_only(self):
        status = await (await self.client.get('/api/status')).json()
        self.assertEqual(status['game']['languages'], ['ru'])
        english = self.root / 'locales' / 'en'
        english.mkdir(parents=True)
        for name in ('war3.mpq', 'War3x.mpq', 'War3xLocal.mpq'):
            (english / name).write_bytes(b'english ' + name.encode())
        # Incomplete localizations are not offered.
        (english / 'locale.json').write_text('{"language": "en"}')
        self.assertEqual((await (await self.client.get('/api/status')).json())['game']['languages'], ['ru'])
        (english / 'War3Patch.mpq').write_bytes(b'english patch')
        self.assertEqual((await (await self.client.get('/api/status')).json())['game']['languages'], ['ru', 'en'])
        base = {f['path']: f for f in (await (await self.client.get('/api/assets')).json())['files']}
        localized = {f['path']: f for f in (await (await self.client.get('/api/assets?language=en')).json())['files']}
        self.assertEqual(set(localized), set(base) | {'War3x.mpq', 'War3xLocal.mpq', 'War3Patch.mpq'})
        self.assertNotEqual(localized['war3.mpq']['id'], base['war3.mpq']['id'])
        self.assertEqual(await (await self.client.get(localized['war3.mpq']['downloadUrl'])).read(), b'english war3.mpq')
        self.assertEqual(await (await self.client.get(base['war3.mpq']['downloadUrl'])).read(), b'0123456789')
        self.assertEqual(await (await self.client.get(localized['war3.mpq']['downloadUrl'], headers={'Range': 'bytes=-4'})).read(), b'.mpq')
        self.assertEqual((await self.client.get('/api/assets?language=de')).status, 400)

    async def test_whole_files_are_gzip_encoded_and_ranges_are_not(self):
        runtime = self.root / 'runtime'
        runtime.mkdir()
        wasm = b'\0asm\x01\0\0\0' + bytes(range(256)) * 512
        (runtime / 'test.wasm').write_bytes(wasm)
        (runtime / 'small.mjs').write_text('export {};\n')
        gzip = {'Accept-Encoding': 'gzip, deflate, br, zstd'}
        response = await self.client.get('/runtime/test.wasm', headers=gzip)
        self.assertEqual((response.status, response.headers.get('Content-Encoding'), response.headers['Vary']), (200, 'gzip', 'Accept-Encoding'))
        self.assertLess(int(response.headers['Content-Length']), len(wasm) // 10)
        self.assertEqual(await response.read(), wasm)
        etag = response.headers['ETag']
        self.assertTrue(etag.endswith('-gzip"'))
        cached = await self.client.get('/runtime/test.wasm', headers={**gzip, 'If-None-Match': etag})
        self.assertEqual(cached.status, 304)
        head = await self.client.head('/runtime/test.wasm', headers=gzip)
        self.assertEqual((head.headers.get('Content-Encoding'), head.headers['Content-Length']), ('gzip', response.headers['Content-Length']))
        # Browsers that refuse gzip, and every range request, get the original bytes.
        for headers in ({'Accept-Encoding': 'identity'}, {'Accept-Encoding': 'gzip;q=0, *'}):
            plain = await self.client.get('/runtime/test.wasm', headers=headers)
            self.assertNotIn('Content-Encoding', plain.headers)
            self.assertEqual((await plain.read(), plain.headers['Vary']), (wasm, 'Accept-Encoding'))
            self.assertFalse(plain.headers['ETag'].endswith('-gzip"'))
        part = await self.client.get('/runtime/test.wasm', headers={**gzip, 'Range': 'bytes=0-99'})
        self.assertEqual((part.status, part.headers.get('Content-Encoding'), await part.read()), (206, None, wasm[:100]))
        small = await self.client.get('/runtime/small.mjs', headers=gzip)
        self.assertNotIn('Content-Encoding', small.headers)
        # A replaced file is compressed again, never served from the old version.
        replacement = b'\0asm\x01\0\0\0' + bytes(range(255, -1, -1)) * 600
        (runtime / 'test.wasm').write_bytes(replacement)
        self.assertEqual(await (await self.client.get('/runtime/test.wasm', headers=gzip)).read(), replacement)
        # Game executables are compressed; archives are not.
        (self.root / 'game' / 'game.dll').write_bytes(b'MZ' + bytes(64 * 1024))
        files = {f['path']: f for f in (await (await self.client.get('/api/assets')).json())['files']}
        module = await self.client.get(files['game.dll']['downloadUrl'], headers=gzip)
        self.assertEqual((module.headers.get('Content-Encoding'), await module.read()), ('gzip', b'MZ' + bytes(64 * 1024)))
        archive = await self.client.get(files['war3.mpq']['downloadUrl'], headers=gzip)
        self.assertNotIn('Content-Encoding', archive.headers)
        self.assertNotIn('Vary', archive.headers)
        self.assertEqual(await archive.read(), b'0123456789')

    async def test_static_and_unknown_paths(self):
        response = await self.client.get('/')
        self.assertEqual(response.status, 200)
        self.assertIn('Warcraft III', await response.text())
        # Unchanged static files (the runtime WASM is ~180 MB) are revalidated, not downloaded again.
        etag = response.headers['ETag']
        response = await self.client.get('/', headers={'If-None-Match': etag})
        self.assertEqual(response.status, 304)
        self.assertEqual(await response.read(), b'')
        for path in ('/.git/config', '/resources/Warcraft_III.zip', '/api/maps/bad/download', '/runtime/../private.txt'):
            response = await self.client.get(path)
            self.assertEqual(response.status, 404)

    async def connect(self, room='room-code-123'):
        socket = await self.client.ws_connect('/api/relay/' + room)
        welcome = await socket.receive_json()
        self.assertEqual(welcome['type'], 'welcome')
        self.assertEqual((await socket.receive_json())['type'], 'peers')
        return socket, welcome['peerId']

    async def test_relay_preserves_binary_and_isolates_rooms(self):
        first, first_id = await self.connect()
        second, second_id = await self.connect()
        outsider, _ = await self.connect('separate-room')
        await first.receive_json()  # second joined
        await first.send_bytes(bytes([second_id]) + b'\xf7\x00\xffgame')
        message = await second.receive(timeout=1)
        self.assertEqual(message.type, WSMsgType.BINARY)
        self.assertEqual(message.data, bytes([first_id]) + b'\xf7\x00\xffgame')
        with self.assertRaises(asyncio.TimeoutError):
            await outsider.receive(timeout=.05)
        await second.send_bytes(b'\x00broadcast')
        self.assertEqual((await first.receive(timeout=1)).data, bytes([second_id]) + b'broadcast')
        await asyncio.gather(first.close(), second.close(), outsider.close())

    async def test_relay_rejects_foreign_origin_and_malformed_frames(self):
        with self.assertRaises(WSServerHandshakeError) as error:
            await self.client.ws_connect('/api/relay/room-code-123', headers={'Origin': 'https://other.example'})
        self.assertEqual(error.exception.status, 403)
        socket, _ = await self.connect()
        await socket.send_bytes(b'\x00')
        self.assertEqual((await socket.receive()).type, WSMsgType.CLOSE)
        self.assertEqual(socket.close_code, 1008)
        await socket.close()

    async def presence(self, socket, expected, predicate=None):
        # Broadcasts coalesce; read until the settled counts arrive.
        for _ in range(50):
            message = await socket.receive(timeout=3)
            self.assertEqual(message.type, WSMsgType.TEXT)
            data = json.loads(message.data)
            self.assertEqual(data.pop('type'), 'presence')
            if {key: data[key] for key in expected} == expected and (predicate is None or predicate(data)):
                return data
        self.fail(f'presence never reached {expected}')

    async def test_presence_counts_pages_running_games_and_lan_games(self):
        self.app[STATE]['presence'].broadcast_interval = 0.01
        first = await self.client.ws_connect('/api/presence')
        await self.presence(first, {'online': 1, 'playing': 0, 'lan': 0})
        second = await self.client.ws_connect('/api/presence')
        seat = await self.client.ws_connect('/api/relay/auto')
        welcome = await seat.receive_json()
        await second.send_json({'playing': True, 'lan': True, 'presenceToken': welcome['presenceToken']})
        await first.send_json({'playing': True})
        await self.presence(first, {'online': 2, 'playing': 2, 'lan': 1})
        status = await (await self.client.get('/api/status')).json()
        self.assertEqual(status['presence'], {'online': 2, 'playing': 2, 'lan': 1})
        # A LAN flag without a running game is not a LAN game.
        await second.send_json({'playing': False, 'lan': True})
        await self.presence(first, {'online': 2, 'playing': 1, 'lan': 0})
        await second.close()
        await self.presence(first, {'online': 1, 'playing': 1, 'lan': 0})
        await first.send_str('{"playing": "yes"}')
        self.assertEqual((await first.receive(timeout=3)).type, WSMsgType.CLOSE)
        self.assertEqual(first.close_code, 1008)
        for _ in range(100):
            if self.app[STATE]['presence'].counts() == {'online': 0, 'playing': 0, 'lan': 0}:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(self.app[STATE]['presence'].counts(), {'online': 0, 'playing': 0, 'lan': 0})
        await seat.close()
        with self.assertRaises(WSServerHandshakeError) as error:
            await self.client.ws_connect('/api/presence', headers={'Origin': 'https://other.example'})
        self.assertEqual(error.exception.status, 403)

    async def test_presence_lan_requires_a_live_relay_connection(self):
        presence = self.app[STATE]['presence']
        presence.broadcast_interval = 0.01
        page = await self.client.ws_connect('/api/presence')
        await self.presence(page, {'online': 1, 'playing': 0, 'lan': 0})
        # A stale client flag must not create a LAN player in empty lobbies.
        await page.send_json({'playing': True, 'lan': True})
        await self.presence(page, {'online': 1, 'playing': 1, 'lan': 0})

        seat = await self.client.ws_connect('/api/relay/auto?language=en')
        welcome = await seat.receive_json()
        token = welcome['presenceToken']
        await page.send_json({'playing': True, 'lan': True, 'presenceToken': token})
        message = await self.presence(page, {'online': 1, 'playing': 1, 'lan': 1})
        self.assertEqual(next(l['players'] for l in message['lobbies'] if l['id'] == welcome['room']), 1)

        # The page stays alive and never clears its flag: only the relay closes.
        await seat.close()
        message = await self.presence(page, {'online': 1, 'playing': 1, 'lan': 0})
        self.assertTrue(all(l['players'] == 0 for l in message['lobbies']))
        replacement = await self.client.ws_connect('/api/relay/auto?language=en')
        new_welcome = await replacement.receive_json()
        self.assertEqual(new_welcome['peerId'], welcome['peerId'])
        self.assertNotEqual(new_welcome['presenceToken'], token)
        self.assertEqual((await (await self.client.get('/api/status')).json())['presence']['lan'], 0,
                         'Reusing a peer slot must not revive the old page LAN flag')
        await page.send_json({'playing': True, 'lan': True, 'presenceToken': new_welcome['presenceToken']})
        await self.presence(page, {'online': 1, 'playing': 1, 'lan': 1})
        await asyncio.gather(replacement.close(), page.close())

    async def test_live_lobby_snapshots_include_private_totals_without_codes(self):
        self.app[STATE]['presence'].broadcast_interval = 0.01
        page = await self.client.ws_connect('/api/presence')
        idle = {'online': 1, 'playing': 0, 'lan': 0}
        await self.presence(page, idle)
        lobby = await (await self.client.post('/api/lobbies', json={'name': 'Live lobby'})).json()
        await self.presence(page, idle, lambda m: any(l['id'] == lobby['id'] for l in m['lobbies']))
        seat = await self.client.ws_connect(f"/api/relay/{lobby['id']}?lobby=1")
        await seat.receive_json()
        await self.presence(page, idle, lambda m: any(l['id'] == lobby['id'] and l['players'] == 1 for l in m['lobbies']))
        await seat.close()
        await self.presence(page, idle, lambda m: all(l['id'] != lobby['id'] for l in m['lobbies']))

        private = await self.client.ws_connect('/api/relay/secret-room-code')
        welcome = await private.receive_json()
        message = await self.presence(page, idle, lambda m: m['privatePlayers'] == 1)
        self.assertNotIn('secret-room-code', json.dumps(message))
        self.assertNotIn(welcome['presenceToken'], json.dumps(message))
        listing = await (await self.client.get('/api/lobbies')).json()
        self.assertEqual(listing['privatePlayers'], 1)
        self.assertTrue(all(l['players'] == 0 for l in listing['lobbies']))
        state = {'playing': True, 'lan': True, 'presenceToken': welcome['presenceToken']}
        await page.send_json(state)
        await self.presence(page, {'online': 1, 'playing': 1, 'lan': 1})
        duplicate = await self.client.ws_connect('/api/presence')
        await duplicate.send_json(state)
        await self.presence(page, {'online': 2, 'playing': 2, 'lan': 1})
        await private.close()
        await self.presence(page, {'online': 2, 'playing': 2, 'lan': 0}, lambda m: m['privatePlayers'] == 0)
        await asyncio.gather(duplicate.close(), page.close())

    async def test_vanished_pages_free_lobby_seats_and_counts(self):
        # A page that disappears without closing its connections (crash, sleep,
        # lost network) stops answering pings and is removed by the server.
        relay, presence = self.app[STATE]['relay'], self.app[STATE]['presence']
        relay.heartbeat = presence.heartbeat = 0.2
        presence.broadcast_interval = 0.01
        seat = await self.client.ws_connect('/api/relay/auto?language=en', autoping=False)
        welcome = await seat.receive_json()
        page = await self.client.ws_connect('/api/presence', autoping=False)
        await page.send_json({'playing': True, 'lan': True, 'presenceToken': welcome['presenceToken']})
        for _ in range(100):
            if relay.rooms['shared-en-1'].peers and presence.counts() == {'online': 1, 'playing': 1, 'lan': 1}:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(len(relay.rooms['shared-en-1'].peers), 1)
        self.assertEqual(presence.counts(), {'online': 1, 'playing': 1, 'lan': 1})
        # Neither connection reads or answers pings from here on.
        for _ in range(300):
            if not relay.rooms['shared-en-1'].peers and presence.counts()['online'] == 0:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(len(relay.rooms['shared-en-1'].peers), 0, 'the lobby seat was not freed')
        self.assertEqual(presence.counts(), {'online': 0, 'playing': 0, 'lan': 0})
        await asyncio.gather(seat.close(), page.close())

    async def test_concurrent_connections_receive_distinct_ids(self):
        connections = await asyncio.gather(*(self.client.ws_connect('/api/relay/concurrent-room') for _ in range(8)))
        welcomes = await asyncio.gather(*(socket.receive_json() for socket in connections))
        self.assertEqual(len({m['peerId'] for m in welcomes}), 8)
        await asyncio.gather(*(socket.close() for socket in connections))

    async def test_public_lobby_membership_uses_the_same_binary_lan(self):
        response = await self.client.post('/api/lobbies', json={'name': '  Вечерняя игра  '})
        self.assertEqual(response.status, 201)
        lobby = await response.json()
        self.assertEqual(lobby['name'], 'Вечерняя игра')
        self.assertEqual((lobby['players'], lobby['maxPlayers']), (0, 200))
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        route = '/api/relay/' + lobby['id'] + '?lobby=1'
        first = await self.client.ws_connect(route)
        welcome = await first.receive_json(timeout=2)
        self.assertEqual(welcome['lobby']['id'], lobby['id'])
        self.assertEqual(welcome['peers'], [welcome['peerId']])
        await first.receive_json(timeout=2)
        second = await self.client.ws_connect(route)
        other = await second.receive_json(timeout=2)
        self.assertEqual((await second.receive_json(timeout=2))['peers'], [welcome['peerId'], other['peerId']])
        await first.receive_json(timeout=2)
        outsider, _ = await self.connect('private-room-123')
        listing = await (await self.client.get('/api/lobbies')).json()
        self.assertEqual(self.created(listing), [{**lobby, 'players': 2}])
        await first.send_bytes(bytes([other['peerId']]) + b'\xf7Warcraft LAN\x00\xff')
        message = await second.receive(timeout=1)
        self.assertEqual(message.data, bytes([welcome['peerId']]) + b'\xf7Warcraft LAN\x00\xff')
        with self.assertRaises(asyncio.TimeoutError):
            await outsider.receive(timeout=.05)
        await first.close()
        self.assertEqual((await second.receive_json(timeout=2))['peers'], [other['peerId']])
        listing = await (await self.client.get('/api/lobbies')).json()
        self.assertEqual(self.created(listing)[0]['players'], 1)
        await second.close()
        self.assertEqual(self.created(await (await self.client.get('/api/lobbies')).json()), [])
        with self.assertRaises(WSServerHandshakeError) as error:
            await self.client.ws_connect(route)
        self.assertEqual(error.exception.status, 404)
        await outsider.close()

    @staticmethod
    def created(listing):
        return [lobby for lobby in listing['lobbies'] if 'shared' not in lobby]

    async def auto(self, language=None):
        socket = await self.client.ws_connect('/api/relay/auto' + (f'?language={language}' if language else ''))
        welcome = await socket.receive_json(timeout=2)
        self.assertEqual(welcome['type'], 'welcome')
        self.assertEqual(welcome['lobby']['id'], welcome['room'])
        return socket, welcome['room']

    async def test_play_fills_shared_lobbies_in_order_then_opens_the_next(self):
        relay = self.app[STATE]['relay']
        relay.capacity = 2
        for room in relay.rooms.values():
            room.capacity = 2
        listing = await (await self.client.get('/api/lobbies')).json()
        # Two shared lobbies per language; English is listed first.
        self.assertEqual([(l['id'], l['language'], l['shared'], l['players'], l['maxPlayers']) for l in listing['lobbies']],
                         [(f'shared-{language}-{n}', language, n, 0, 2) for language in ('en', 'ru') for n in (1, 2)])
        # Without a language Play joins the base installation's (Russian) lobbies.
        seats = [await self.auto() for _ in range(5)]
        self.assertEqual([room for _, room in seats], ['shared-ru-1'] * 2 + ['shared-ru-2'] * 2 + ['shared-ru-3'])
        listing = await (await self.client.get('/api/lobbies')).json()
        self.assertEqual([(l['language'], l['shared'], l['players']) for l in listing['lobbies']],
                         [('en', 1, 0), ('en', 2, 0), ('ru', 1, 2), ('ru', 2, 2), ('ru', 3, 1)])
        # Each language fills its own shared lobbies.
        english, room = await self.auto('en')
        self.assertEqual(room, 'shared-en-1')
        await english.close()
        with self.assertRaises(WSServerHandshakeError) as error:
            await self.client.ws_connect('/api/relay/auto?language=xx')
        self.assertEqual(error.exception.status, 400)
        # A freed seat in the first lobby is taken before any later lobby.
        await seats[0][0].close()
        socket, room = await self.auto()
        self.assertEqual(room, 'shared-ru-1')
        # Overflow lobbies close when empty; lobbies 1–2 stay.
        await seats[4][0].close()
        for _ in range(100):
            if 'shared-ru-3' not in relay.rooms:
                break
            await asyncio.sleep(0.01)
        self.assertNotIn('shared-ru-3', relay.rooms)
        await asyncio.gather(socket.close(), *(s.close() for s, _ in seats[1:4]))
        for _ in range(100):
            if all(not relay.rooms[f'shared-ru-{n}'].peers for n in (1, 2)):
                break
            await asyncio.sleep(0.01)
        listing = await (await self.client.get('/api/lobbies')).json()
        self.assertEqual([(l['language'], l['shared'], l['players']) for l in listing['lobbies']],
                         [(language, n, 0) for language in ('en', 'ru') for n in (1, 2)])

    async def wait_until(self, condition):
        for _ in range(200):
            if condition():
                return
            await asyncio.sleep(0.01)
        self.fail('Condition not reached')

    async def test_overflow_lobbies_are_reused_before_another_opens(self):
        relay = self.app[STATE]['relay']
        relay.capacity = 2
        for room in relay.rooms.values():
            room.capacity = 2
        # Initial lobbies 1–2 full: players fill overflow lobby 3 before lobby 4 opens.
        seats = [await self.auto('en') for _ in range(7)]
        self.assertEqual([room for _, room in seats],
                         ['shared-en-1'] * 2 + ['shared-en-2'] * 2 + ['shared-en-3'] * 2 + ['shared-en-4'])
        # The last player leaving closes an overflow lobby; the others stay.
        await asyncio.gather(seats[4][0].close(), seats[5][0].close(), seats[0][0].close())
        await self.wait_until(lambda: 'shared-en-3' not in relay.rooms and len(relay.rooms['shared-en-1'].peers) == 1)
        self.assertIn('shared-en-4', relay.rooms)
        # A free seat in an initial lobby, then in an open overflow lobby, and
        # only then a new lobby.
        later = [await self.auto('en') for _ in range(4)]
        self.assertEqual([room for _, room in later], ['shared-en-1', 'shared-en-4', 'shared-en-3', 'shared-en-3'])
        # Lobbies created by players are never filled by Play.
        response = await self.client.post('/api/lobbies', json={'name': 'Friends'})
        self.assertEqual(response.status, 201)
        socket, room = await self.auto('en')
        self.assertEqual(room, 'shared-en-5')
        await asyncio.gather(socket.close(), *(s.close() for s, _ in seats[1:4] + seats[6:] + later))
        await self.wait_until(lambda: sorted(k for k in relay.rooms if k.startswith('shared-en')) == ['shared-en-1', 'shared-en-2'])

    async def test_default_page_language_follows_the_country(self):
        geo = self.app[STATE]['geo']
        await self.wait_until(lambda: geo.ranges is not None)

        async def language(**headers):
            response = await self.client.get('/api/locale', headers=headers)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            return (await response.json())['language']

        # Unknown: a local address, a private one or garbage behind the proxy.
        self.assertIsNone(await language())
        self.assertIsNone(await language(**{'X-Forwarded-For': '10.1.2.3'}))
        self.assertIsNone(await language(**{'X-Forwarded-For': 'not an address'}))
        # The proxy appends the visitor's address; earlier entries are the visitor's own.
        self.assertEqual(await language(**{'X-Forwarded-For': '8.8.8.8, 5.0.0.7'}), 'ru')
        self.assertEqual(await language(**{'X-Forwarded-For': '5.0.0.7, 8.8.8.8'}), 'en')
        self.assertEqual(await language(**{'X-Forwarded-For': '5.0.1.200'}), 'ru')
        self.assertEqual(await language(**{'X-Forwarded-For': '2a02:6b8::1'}), 'ru')
        self.assertEqual(await language(**{'X-Forwarded-For': '::ffff:5.0.0.1'}), 'ru')
        self.assertEqual(await language(**{'X-Forwarded-For': '2001:4860::8888'}), 'en')
        # A CDN's country header comes first; XX is unknown.
        self.assertEqual(await language(**{'CF-IPCountry': 'BY', 'X-Forwarded-For': '8.8.8.8'}), 'ru')
        self.assertEqual(await language(**{'CF-IPCountry': 'de', 'X-Forwarded-For': '5.0.0.7'}), 'en')
        self.assertEqual(await language(**{'CF-IPCountry': 'XX', 'X-Forwarded-For': '8.8.8.8'}), 'en')
        # A newer database replaces the loaded one.
        (self.root / 'countries.csv').write_text('8.8.8.0,8.8.8.255,AM\n')
        await asyncio.to_thread(geo.reload)
        self.assertEqual(await language(**{'X-Forwarded-For': '8.8.8.8'}), 'ru')
        self.assertEqual(await language(**{'X-Forwarded-For': '5.0.0.7'}), 'en')

    async def test_lobby_creation_validates_json_names_and_origin(self):
        for value in (None, [], {}, {'name': ''}, {'name': ' '}, {'name': 123},
                      {'name': 'a' * 49}, {'name': 'bad\nname'}, {'name': 'bad\u202ename'}):
            with self.subTest(value=value):
                response = await self.client.post('/api/lobbies', data=json.dumps(value),
                                                  headers={'Content-Type': 'application/json'})
                self.assertEqual(response.status, 400)
        response = await self.client.post('/api/lobbies', data='{broken', headers={'Content-Type': 'application/json'})
        self.assertEqual(response.status, 400)
        response = await self.client.post('/api/lobbies', data='{"name":"Room"}')
        self.assertEqual(response.status, 415)
        response = await self.client.post('/api/lobbies', json={'name': 'a' * 2048})
        self.assertEqual(response.status, 413)
        response = await self.client.post('/api/lobbies', json={'name': 'Room'}, headers={'Origin': 'https://other.example'})
        self.assertEqual(response.status, 403)
        response = await self.client.post('/api/lobbies', json={'name': 'Room'}, headers={'Origin': str(self.server.make_url('')).rstrip('/')})
        self.assertEqual(response.status, 201)

    async def test_lobby_expiration_preserves_occupied_rooms_and_frees_capacity(self):
        relay = self.app[STATE]['relay']
        relay.max_rooms = len(relay.rooms) + 2  # the shared lobbies always exist
        first = await (await self.client.post('/api/lobbies', json={'name': 'Active'})).json()
        socket, _ = await self.connect(first['id'])
        second = await (await self.client.post('/api/lobbies', json={'name': 'Abandoned'})).json()
        response = await self.client.post('/api/lobbies', json={'name': 'Over limit'})
        self.assertEqual(response.status, 503)
        for room in relay.rooms.values():
            room.created_at -= relay.empty_lobby_ttl + 1
        listing = await (await self.client.get('/api/lobbies')).json()
        self.assertEqual([item['id'] for item in self.created(listing)], [first['id']])
        self.assertEqual([(item['language'], item['shared']) for item in listing['lobbies'][:4]],
                         [('en', 1), ('en', 2), ('ru', 1), ('ru', 2)], 'shared lobbies never expire')
        with self.assertRaises(WSServerHandshakeError) as error:
            await self.client.ws_connect('/api/relay/' + second['id'] + '?lobby=1')
        self.assertEqual(error.exception.status, 404)
        response = await self.client.post('/api/lobbies', json={'name': 'New room'})
        self.assertEqual(response.status, 201)
        await socket.close()

    async def test_full_lobby_rejects_extra_peer_and_reuses_vacated_slot(self):
        self.app[STATE]['relay'].capacity = 2
        lobby = await (await self.client.post('/api/lobbies', json={'name': 'Two players'})).json()
        first, first_id = await self.connect(lobby['id'])
        second, second_id = await self.connect(lobby['id'])
        await first.receive_json(timeout=2)
        with self.assertRaises(WSServerHandshakeError) as error:
            await self.client.ws_connect('/api/relay/' + lobby['id'] + '?lobby=1')
        self.assertEqual(error.exception.status, 409)
        await first.close()
        self.assertEqual((await second.receive_json(timeout=2))['peers'], [second_id])
        replacement, replacement_id = await self.connect(lobby['id'])
        self.assertEqual(first_id, replacement_id)
        self.assertEqual((await second.receive_json(timeout=2))['peers'], [first_id, second_id])
        await asyncio.gather(second.close(), replacement.close())


if __name__ == '__main__':
    unittest.main()
