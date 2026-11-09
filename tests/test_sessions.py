import asyncio
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest

from aiohttp.test_utils import AioHTTPTestCase, make_mocked_request

from server.app import STATE, create_app
from server.geoip import client_address, connection_address
from server.sessions import format_report, read_report


class AddressTests(unittest.TestCase):
    def test_proxy_appends_address_and_direct_clients_cannot_forge_it(self):
        def request(peer, forwarded):
            return make_mocked_request('GET', '/', headers={'X-Forwarded-For': forwarded}).clone(remote=peer)

        self.assertEqual(str(connection_address(request('172.18.0.3', '1.1.1.1, 8.8.8.8'))), '8.8.8.8')
        self.assertEqual(str(connection_address(request('8.8.8.8', '1.1.1.1'))), '8.8.8.8')
        self.assertEqual(str(connection_address(request('127.0.0.1', '::ffff:8.8.8.8'))), '8.8.8.8')
        self.assertEqual(str(connection_address(request('127.0.0.1', '2001:4860::8888'))), '2001:4860::8888')
        local = request('127.0.0.1', '192.168.1.2')
        self.assertEqual(str(connection_address(local)), '192.168.1.2')
        self.assertIsNone(client_address(local), 'Private diagnostic addresses must not reach the country lookup')
        self.assertIsNone(connection_address(request('127.0.0.1', 'invalid')))

    def test_stale_reports_are_not_shown_as_current_connections(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'sessions.json'
            with self.assertRaisesRegex(ValueError, 'No session report'):
                read_report(path)
            path.write_text(json.dumps({'pid': os.getpid(), 'updatedAt': time.time() - 60}))
            with self.assertRaisesRegex(ValueError, 'stale'):
                read_report(path)


class SessionTests(AioHTTPTestCase):
    async def get_application(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.report = self.root / 'sessions.json'
        return create_app(game_dir=self.root / 'game', maps_dir=self.root / 'maps',
                          runtime_dir=self.root / 'runtime', locales_dir=self.root / 'locales',
                          report_path=self.root / 'game.json', geoip_path=self.root / 'geoip',
                          presence_report=self.report)

    async def tearDownAsync(self):
        try:
            await super().tearDownAsync()
            self.assertFalse(self.report.exists(), 'Private report must be removed on shutdown')
            self.assertEqual(list(self.root.glob('.w3ft-presence-*')), [])
        finally:
            self.temp.cleanup()

    async def report_when(self, predicate):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if self.report.exists():
                report = read_report(self.report)
                if predicate(report):
                    return report
            await asyncio.sleep(0.02)
        self.fail('Private session report did not reach the expected state')

    async def test_owner_report_identifies_pages_without_exposing_them_to_visitors(self):
        presence = self.app[STATE]['presence']
        presence.broadcast_interval = 0.01
        phone = await self.client.ws_connect('/api/presence', headers={
            'X-Forwarded-For': '1.1.1.1, 8.8.8.8', 'User-Agent': 'Test iPhone CriOS/157'})
        desktop = await self.client.ws_connect('/api/presence', headers={
            'X-Forwarded-For': '8.8.8.8', 'User-Agent': 'Test Macintosh Chrome/157'})
        seat = await self.client.ws_connect('/api/relay/private-test-room')
        token = (await seat.receive_json())['presenceToken']
        await phone.send_json({'playing': True, 'lan': True, 'presenceToken': token})

        report = await self.report_when(lambda r: r['counts'] == {'online': 2, 'playing': 1, 'lan': 1})
        self.assertEqual(stat.S_IMODE(self.report.stat().st_mode), 0o600)
        self.assertEqual(len(report['sessions']), 2)
        game = next(s for s in report['sessions'] if s['playing'])
        self.assertEqual(game['ip'], '8.8.8.8')
        self.assertEqual(game['peerIp'], '127.0.0.1')
        self.assertEqual(game['userAgent'], 'Test iPhone CriOS/157')
        self.assertGreaterEqual(game['playingSince'], game['connectedAt'])
        self.assertEqual(game['lastReportAt'], game['playingSince'])
        self.assertEqual(len({s['id'] for s in report['sessions']}), 2, 'Tabs sharing an IP still need distinct IDs')
        self.assertNotIn(token, json.dumps(report))
        self.assertNotIn('private-test-room', json.dumps(report))

        # Public HTTP and WebSocket payloads remain anonymous aggregates.
        public = json.dumps(await (await self.client.get('/api/status')).json())
        public += json.dumps(await phone.receive_json())
        public += json.dumps(presence.snapshot())
        for private in ('8.8.8.8', '127.0.0.1', 'CriOS/157', 'Macintosh', 'userAgent', 'connectedAt', token):
            self.assertNotIn(private, public)
        for route in ('/api/sessions', '/sessions.json', '/w3ft-presence-8080.json'):
            self.assertEqual((await self.client.get(route)).status, 404)

        # Exercise the actual SSH/docker-exec command against a live report.
        process = await asyncio.create_subprocess_exec(sys.executable, '-m', 'server.sessions',
                                                      '--path', str(self.report), '--playing',
                                                      stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await process.communicate()
        self.assertEqual(process.returncode, 0, stderr.decode())
        self.assertIn('8.8.8.8', stdout.decode())
        self.assertIn('iPhone', stdout.decode())
        self.assertNotIn('Macintosh', stdout.decode())

        # Losing the relay produces the reported 1 in game / 0 LAN case.
        await seat.close()
        report = await self.report_when(lambda r: r['counts'] == {'online': 2, 'playing': 1, 'lan': 0})
        self.assertFalse(next(s for s in report['sessions'] if s['playing'])['lan'])
        await phone.send_json({'playing': False})
        report = await self.report_when(lambda r: r['counts']['playing'] == 0)
        self.assertTrue(all(s['playingSince'] is None for s in report['sessions']))
        await phone.close()
        report = await self.report_when(lambda r: r['counts']['online'] == 1)
        self.assertEqual(report['sessions'][0]['userAgent'], 'Test Macintosh Chrome/157')
        await desktop.close()
        report = await self.report_when(lambda r: not r['sessions'])
        self.assertEqual(report['counts'], {'online': 0, 'playing': 0, 'lan': 0})
        self.assertEqual(presence.clients, {})

    async def test_vanished_page_disappears_from_the_private_report(self):
        presence = self.app[STATE]['presence']
        presence.heartbeat = 0.2
        page = await self.client.ws_connect('/api/presence', autoping=False)
        await page.send_json({'playing': True})
        for _ in range(100):
            if presence.counts()['playing'] == 1:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(presence.counts()['playing'], 1)
        self.assertEqual(len(presence.clients), 1)
        report = await self.report_when(lambda r: not r['sessions'])
        self.assertEqual(report['counts']['playing'], 0)
        self.assertEqual(presence.clients, {})
        await page.close()

    async def test_browser_string_is_bounded_and_safe_to_print(self):
        page = await self.client.ws_connect('/api/presence', headers={'User-Agent': 'A' * 1000})
        report = await self.report_when(lambda r: len(r['sessions']) == 1)
        self.assertEqual(len(report['sessions'][0]['userAgent']), 512)
        report['sessions'][0]['userAgent'] = 'Browser\x1b[2J\nforged line'
        output = format_report(report)
        self.assertNotIn('\x1b', output)
        self.assertNotIn('\nforged line', output)
        self.assertIn('\\u001b[2J\\nforged line', output)
        await page.close()
