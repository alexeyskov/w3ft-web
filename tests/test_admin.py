import asyncio
import json
from pathlib import Path
import stat
import tempfile
import time
import unittest

from aiohttp import ClientSession, CookieJar, WSMsgType
from aiohttp.test_utils import AioHTTPTestCase, TestClient, TestServer, make_mocked_request

from server.admin import COOKIE, is_https
from server.admin_auth import password_hash, save_env, verify_password
from server.app import STATE, create_app
from server.geoip import connection_address
from server.presence import RECONNECT_COOKIE

# Public fixture only; production has no password until its owner sets one.
TEST_PASSWORD = 'admin test password, not a deployment secret'
TEST_HASH = password_hash(TEST_PASSWORD)


class AdminPasswordTests(unittest.TestCase):
    def test_hash_and_atomic_env_update_preserve_other_settings(self):
        self.assertTrue(verify_password(TEST_PASSWORD, TEST_HASH))
        self.assertFalse(verify_password('wrong', TEST_HASH))
        self.assertNotIn(TEST_PASSWORD, TEST_HASH)
        with self.assertRaises(ValueError):
            password_hash('short')
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / '.env'
            path.write_text('# Domain\nWC3_DOMAIN=w3ft.example\nWC3_ADMIN_PASSWORD_HASH=old\n')
            save_env(path, TEST_HASH)
            text = path.read_text()
            self.assertIn('# Domain\nWC3_DOMAIN=w3ft.example\n', text)
            self.assertEqual(text.count('WC3_ADMIN_PASSWORD_HASH='), 1)
            self.assertNotIn(TEST_PASSWORD, text)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(list(path.parent.glob('.w3ft-admin-*')), [])

    def test_cloudflare_headers_require_a_known_upstream(self):
        def request(peer, forwarded, visitor, ipv6=''):
            return make_mocked_request('GET', '/', headers={'X-Forwarded-For': forwarded,
                'CF-Connecting-IP': visitor, 'CF-Connecting-IPv6': ipv6}).clone(remote=peer)

        self.assertEqual(str(connection_address(request('172.18.0.3', '162.158.139.31', '8.8.8.8'))), '8.8.8.8')
        self.assertEqual(str(connection_address(request('172.18.0.3', '2606:4700::1', '2001:4860::8888'))), '2001:4860::8888')
        self.assertEqual(str(connection_address(request('172.18.0.3', '8.8.8.8', '1.1.1.1'))), '8.8.8.8')
        self.assertEqual(str(connection_address(request('8.8.8.8', '162.158.139.31', '1.1.1.1'))), '8.8.8.8')
        self.assertEqual(str(connection_address(request('172.18.0.3', '162.158.139.31', 'invalid'))), '162.158.139.31')
        self.assertEqual(str(connection_address(request('172.18.0.3', '162.158.139.31', '10.0.0.1'))), '162.158.139.31')
        self.assertEqual(str(connection_address(request('172.18.0.3', '162.158.139.31', '240.0.0.1', '2001:4860::8888'))), '2001:4860::8888')
        spoof = make_mocked_request('GET', '/', headers={'X-Forwarded-Proto': 'https'}).clone(remote='8.8.8.8')
        self.assertFalse(is_https(spoof))


class AdminTests(AioHTTPTestCase):
    async def get_application(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.options = dict(game_dir=self.root / 'game', maps_dir=self.root / 'maps',
                            runtime_dir=self.root / 'runtime', geoip_path=self.root / 'geoip',
                            report_path=self.root / 'report.json')
        return create_app(**self.options, admin_password_hash=TEST_HASH)

    async def tearDownAsync(self):
        await super().tearDownAsync()
        self.temp.cleanup()

    async def login(self):
        response = await self.client.post('/api/admin/login', json={'password': TEST_PASSWORD},
                                          headers={'X-W3FT-Admin': '1'})
        self.assertEqual(response.status, 200, await response.text())
        self.csrf = (await response.json())['csrf']
        self.cookie = response.cookies[COOKIE].value
        return response

    async def wait_until(self, predicate):
        async with asyncio.timeout(5):
            while not predicate():
                await asyncio.sleep(0.01)

    async def test_default_disabled_and_no_public_session_data(self):
        disabled = TestClient(TestServer(create_app(**self.options, admin_password_hash='')))
        await disabled.start_server()
        try:
            for path in ('/admin', '/admin/', '/admin.html', '/api/admin/session', '/api/admin/sessions'):
                response = await disabled.get(path)
                self.assertEqual(response.status, 404, path)
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
        finally:
            await disabled.close()
        for path in ('/api/admin/session', '/api/admin/sessions'):
            response = await self.client.get(path)
            self.assertEqual(response.status, 401)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual((await self.client.get('/admin')).status, 200)
        wrong = await self.client.post('/api/admin/login', json={'password': 'wrong'}, headers={'X-W3FT-Admin': '1'})
        self.assertEqual(wrong.status, 401)
        self.assertNotIn(COOKIE, wrong.cookies)
        public = await (await self.client.get('/api/status')).text()
        self.assertNotIn(TEST_HASH, public)
        self.assertNotIn(TEST_PASSWORD, public)

    async def test_cookie_csrf_and_login_origin_are_protected(self):
        for headers, status in (({}, 403), ({'X-W3FT-Admin': '1', 'Origin': 'https://evil.example'}, 403),
                                ({'X-W3FT-Admin': '1', 'Sec-Fetch-Site': 'cross-site'}, 403)):
            response = await self.client.post('/api/admin/login', json={'password': TEST_PASSWORD}, headers=headers)
            self.assertEqual(response.status, status)
        response = await self.login()
        cookie = response.cookies[COOKIE]
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'], 'Strict')
        self.assertEqual(cookie['path'], '/api/admin')
        self.assertFalse(cookie['domain'])
        self.assertEqual((await self.client.get('/api/admin/session')).status, 200)
        listing = await (await self.client.get('/api/admin/sessions')).json()
        for headers in ({}, {'X-CSRF-Token': 'wrong'}, {'X-CSRF-Token': self.csrf, 'Origin': 'https://evil.example'}):
            response = await self.client.post('/api/admin/kick', json={'id': 1, 'generation': listing['generation']}, headers=headers)
            self.assertEqual(response.status, 403)
        self.assertIn((await self.client.get('/api/admin/kick')).status, (404, 405))

    async def test_https_is_required_and_secure_cookie_is_set_behind_caddy(self):
        response = await self.client.get('/admin', headers={'Host': 'w3ft.example'})
        self.assertEqual(response.status, 403)
        response = await self.client.post('/api/admin/login', json={'password': TEST_PASSWORD}, headers={
            'Host': 'w3ft.example', 'X-Forwarded-Proto': 'https', 'Origin': 'https://w3ft.example', 'X-W3FT-Admin': '1'})
        self.assertEqual(response.status, 200)
        self.assertTrue(response.cookies[COOKIE]['secure'])

    async def test_logout_and_expiration_revoke_the_server_session(self):
        await self.login()
        response = await self.client.post('/api/admin/logout', json={}, headers={'X-CSRF-Token': self.csrf})
        self.assertEqual(response.status, 200)
        response = await self.client.get('/api/admin/sessions', headers={'Cookie': f'{COOKIE}={self.cookie}'})
        self.assertEqual(response.status, 401)
        await self.login()
        for session in self.app[STATE]['admin'].sessions.values():
            session['expires'] = time.monotonic() - 1
        self.assertEqual((await self.client.get('/api/admin/sessions')).status, 401)

    async def test_restart_keeps_configured_password_but_requires_a_new_login(self):
        await self.login()
        restarted = TestClient(TestServer(create_app(**self.options, admin_password_hash=TEST_HASH)))
        await restarted.start_server()
        try:
            response = await restarted.get('/api/admin/sessions', headers={'Cookie': f'{COOKIE}={self.cookie}'})
            self.assertEqual(response.status, 401, 'An old admin session must not survive a restart')
            response = await restarted.post('/api/admin/login', json={'password': TEST_PASSWORD}, headers={'X-W3FT-Admin': '1'})
            self.assertEqual(response.status, 200, 'The same configured password must work after a restart')
        finally:
            await restarted.close()

    async def test_login_rate_limit_and_body_validation(self):
        for password in (None, 'x' * 1025, '\ud800'):
            response = await self.client.post('/api/admin/login', json={'password': password}, headers={'X-W3FT-Admin': '1'})
            self.assertEqual(response.status, 400)
        response = await self.client.post('/api/admin/login', json={'password': 'x' * 5000}, headers={'X-W3FT-Admin': '1'})
        self.assertEqual(response.status, 413)
        response = await self.client.post('/api/admin/login', data={'password': TEST_PASSWORD}, headers={'X-W3FT-Admin': '1'})
        self.assertEqual(response.status, 415)
        for _ in range(5):
            response = await self.client.post('/api/admin/login', json={'password': 'wrong'}, headers={'X-W3FT-Admin': '1'})
            self.assertEqual(response.status, 401)
        response = await self.client.post('/api/admin/login', json={'password': TEST_PASSWORD}, headers={'X-W3FT-Admin': '1'})
        self.assertEqual(response.status, 429)
        self.assertEqual(response.headers['Retry-After'], '60')

    async def test_kick_is_targeted_and_rejects_stale_lists(self):
        await self.login()
        presence, relay = self.app[STATE]['presence'], self.app[STATE]['relay']
        presence.broadcast_interval = 0.01
        first = await self.client.ws_connect('/api/presence')
        second = await self.client.ws_connect('/api/presence')
        old = await self.client.ws_connect('/api/presence')
        seat = await self.client.ws_connect('/api/relay/auto')
        token = (await seat.receive_json())['presenceToken']
        await first.send_json({'playing': True, 'lan': True, 'presenceToken': token, 'control': 1})
        await second.send_json({'playing': True, 'control': 1})
        await old.send_json({'playing': True})
        await self.wait_until(lambda: presence.counts()['playing'] == 3)
        listing = await (await self.client.get('/api/admin/sessions')).json()
        first_id, second_id, old_id = [s['id'] for s in listing['sessions']]
        self.assertNotIn(token, json.dumps(listing))
        headers = {'X-CSRF-Token': self.csrf}
        response = await self.client.post('/api/admin/kick', headers=headers, json={'id': first_id, 'generation': 'old-server'})
        self.assertEqual(response.status, 409)
        self.assertEqual(presence.counts()['playing'], 3)
        async def drain(socket):
            return [json.loads(message.data) async for message in socket if message.type == WSMsgType.TEXT]

        page_read, seat_read = asyncio.create_task(drain(first)), asyncio.create_task(drain(seat))
        try:
            response = await self.client.post('/api/admin/kick', headers=headers, json={'id': first_id, 'generation': listing['generation']})
            self.assertEqual(response.status, 200, await response.text())
            self.assertTrue((await response.json())['stopRequested'])
            messages = await asyncio.wait_for(page_read, 5)
            await asyncio.wait_for(seat_read, 5)
            self.assertIn({'type': 'kick'}, messages)
            self.assertEqual(seat.close_code, 4003)
            self.assertFalse(relay.has_presence_token(token))
            self.assertEqual(presence.counts(), {'online': 2, 'playing': 2, 'lan': 0})
            self.assertEqual({s['id'] for s in presence.inspect_clients()['sessions']}, {second_id, old_id})
            response = await self.client.post('/api/admin/kick', headers=headers, json={'id': first_id, 'generation': listing['generation']})
            self.assertEqual(response.status, 404, 'A stale button must not affect another page')
        finally:
            for task in (page_read, seat_read):
                task.cancel()
            await asyncio.gather(page_read, seat_read, return_exceptions=True)
            await asyncio.gather(first.close(), second.close(), old.close(), seat.close())

    async def test_legacy_kick_closes_lan_and_blocks_retries_without_banning_shared_ip(self):
        await self.login()
        presence, relay = self.app[STATE]['presence'], self.app[STATE]['relay']
        presence.broadcast_interval = 0.01
        old = await self.client.ws_connect('/api/presence')
        cookie = old._response.cookies[RECONNECT_COOKIE]
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'], 'Strict')
        self.assertEqual(cookie['path'], '/api/presence')
        self.assertFalse(cookie['max-age'], 'Only a browser-session cookie is needed')
        seat = await self.client.ws_connect('/api/relay/auto')
        token = (await seat.receive_json())['presenceToken']
        await old.send_json({'playing': True, 'lan': True, 'presenceToken': token})
        await self.wait_until(lambda: presence.counts()['playing'] == 1)
        listing = await (await self.client.get('/api/admin/sessions')).json()
        self.assertNotIn(cookie.value, json.dumps(listing))

        async def drain(socket):
            async for _ in socket:
                pass

        readers = [asyncio.create_task(drain(socket)) for socket in (old, seat)]
        try:
            response = await self.client.post('/api/admin/kick', headers={'X-CSRF-Token': self.csrf},
                json={'id': listing['sessions'][0]['id'], 'generation': listing['generation']})
            self.assertEqual(response.status, 200, await response.text())
            self.assertEqual(await response.json(), {'disconnected': True, 'stopRequested': False})
            await asyncio.wait_for(asyncio.gather(*readers), 5)
            self.assertEqual(old.close_code, 4003)
            self.assertEqual(seat.close_code, 4003)
            self.assertFalse(relay.has_presence_token(token))
            for _ in range(3):
                retry = await self.client.ws_connect('/api/presence')
                await retry.send_json({'playing': True})
                # No snapshot or transient count appears for a blocked retry.
                self.assertEqual((await retry.receive(timeout=5)).type, WSMsgType.CLOSE)
                self.assertEqual(retry.close_code, 4003)
                await retry.close()
                self.assertEqual(presence.counts(), {'online': 0, 'playing': 0, 'lan': 0})

            # Same browser cookie, but a reloaded/current page can join normally.
            current = await self.client.ws_connect('/api/presence')
            await current.send_json({'playing': True, 'control': 1})
            self.assertEqual((await current.receive_json())['type'], 'presence')
            await self.wait_until(lambda: presence.counts()['playing'] == 1)
            self.assertTrue(presence.inspect_clients()['sessions'][0]['kickSupported'])
            # A different browser on the very same IP remains allowed even if old.
            async with ClientSession(cookie_jar=CookieJar(unsafe=True)) as other_browser:
                other = await other_browser.ws_connect(self.server.make_url('/api/presence'))
                await other.send_json({'playing': True})
                await self.wait_until(lambda: presence.counts()['playing'] == 2)
                self.assertEqual({s['ip'] for s in presence.inspect_clients()['sessions']}, {'127.0.0.1'})
                retry = await self.client.ws_connect('/api/presence')
                await retry.send_json({'playing': True})
                self.assertEqual((await retry.receive(timeout=5)).type, WSMsgType.CLOSE)
                await retry.close()
                self.assertEqual(presence.counts()['playing'], 2)
                await other.close()
            await current.close()
            await self.wait_until(lambda: not presence.states and not presence.pending)
            self.assertEqual(presence.reconnect_keys, {})
        finally:
            for task in readers:
                task.cancel()
            await asyncio.gather(*readers, return_exceptions=True)
            await asyncio.gather(old.close(), seat.close())

    async def test_legacy_reconnect_records_expire_and_stay_bounded(self):
        presence = self.app[STATE]['presence']
        presence.max_connections = 2
        presence.remember_legacy_kick('expired')
        presence.legacy_kicks['expired'] = time.monotonic() - 1
        presence.remember_legacy_kick('first')
        self.assertNotIn('expired', presence.legacy_kicks)
        presence.remember_legacy_kick('second')
        presence.remember_legacy_kick('first')  # active retry refreshes its entry
        presence.remember_legacy_kick('third')
        self.assertEqual(set(presence.legacy_kicks), {'first', 'third'})
