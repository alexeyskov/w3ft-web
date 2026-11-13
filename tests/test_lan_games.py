"""Actual relay sockets and live broadcasts; no game files needed."""
import asyncio
import json
from pathlib import Path
import struct
import tempfile

from aiohttp import WSMsgType
from aiohttp.test_utils import AioHTTPTestCase

from server.app import STATE, create_app


def frame(kind, payload=b'', src=50000, dst=6112, connection=42):
    return struct.pack('<IBBHHHI', 0x31535743, kind, 0, src, dst, len(payload), connection)+payload


def packet(identifier, body=b''):
    return bytes([0xF7, identifier])+struct.pack('<H', 4+len(body))+body


class LANGameCounterTests(AioHTTPTestCase):
    async def get_application(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.sockets = []
        app = create_app(game_dir=root/'game', maps_dir=root/'maps', runtime_dir=root/'runtime',
                         issues_dir='', activity_dir=str(root/'activity'), admin_password_hash='')
        app[STATE]['presence'].broadcast_interval = .01
        return app

    async def asyncTearDown(self):
        await asyncio.gather(*(s.close() for s in self.sockets))
        await super().asyncTearDown()
        self.temp.cleanup()

    async def observer(self):
        socket = await self.client.ws_connect('/api/presence')
        self.sockets.append(socket)
        return socket

    async def player(self, room='auto'):
        socket = await self.client.ws_connect('/api/relay/'+room)
        self.sockets.append(socket)
        welcome = await socket.receive_json()
        page = await self.observer()
        await page.send_json({'playing': True, 'lan': True, 'presenceToken': welcome['presenceToken']})
        return socket, welcome['peerId']

    async def send(self, sender, receiver, data):
        await sender[0].send_bytes(bytes([receiver[1]])+data)
        async with asyncio.timeout(3):
            while True:
                message = await receiver[0].receive()
                if message.type == WSMsgType.BINARY:
                    self.assertEqual(message.data, bytes([sender[1]])+data, 'Observation must preserve every byte')
                    return

    async def load(self, host, guest):
        await self.send(guest, host, frame(2))
        await self.send(host, guest, frame(3, src=6112, dst=50000))
        await self.send(guest, host, frame(4))
        await self.send(host, guest, frame(5, packet(0x04, bytes(4))+packet(0x0B), src=6112, dst=50000))
        await self.send(guest, host, frame(5, packet(0x23)))

    async def play(self, host, guest):
        await self.load(host, guest)
        await self.send(host, guest, frame(5, packet(0x0C, b'\x64\x00'), src=6112, dst=50000))

    async def count(self, observer, expected):
        async with asyncio.timeout(3):
            while True:
                message = await observer.receive_json()
                if message.get('lanGames') == expected:
                    return message

    async def test_waiting_and_loading_clients_are_not_counted_as_matches(self):
        observer = await self.observer()
        host, guest, idle = [await self.player() for _ in range(3)]
        await self.load(host, guest)
        await self.count(observer, 0)
        status = await (await self.client.get('/api/status')).json()
        self.assertEqual(status['presence']['lanGames'], 0)
        self.assertEqual(status['presence']['lan'], 3)
        await self.send(host, guest, frame(5, packet(0x0C, bytes(2)), src=6112, dst=50000))
        await self.count(observer, 1)
        self.assertEqual((await (await self.client.get('/api/status')).json())['presence']['lanGames'], 1)
        # Closing a page/relay must update the count without another game packet.
        await guest[0].close()
        await self.count(observer, 0)

    async def test_two_separate_matches_in_one_lobby_count_twice(self):
        observer = await self.observer()
        host1, guest1, host2, guest2 = [await self.player() for _ in range(4)]
        await self.play(host1, guest1)
        await self.play(host2, guest2)
        await self.count(observer, 2)
        await self.send(host1, guest1, frame(5, packet(0x0C, bytes(2))*5, src=6112, dst=50000))
        self.assertEqual(self.app[STATE]['relay'].game_count(), 2)
        await self.send(guest1, host1, frame(5, packet(0x21, bytes(4))))
        await self.count(observer, 1)
        # LAN connection stays open, but the actual match has ended.
        self.assertFalse(guest1[0].closed)
        await host2[0].close()
        await self.count(observer, 0)

    async def test_rooms_with_identical_peer_ids_and_ports_are_independent(self):
        observer = await self.observer()
        host1, guest1 = [await self.player('first-private-code') for _ in range(2)]
        host2, guest2 = [await self.player('second-private-code') for _ in range(2)]
        self.assertEqual((host1[1], guest1[1]), (host2[1], guest2[1]))
        await self.play(host1, guest1)
        await self.play(host2, guest2)
        message = await self.count(observer, 2)
        self.assertEqual(message['privatePlayers'], 4)
        self.assertNotIn('first-private-code', json.dumps(message))
        self.assertNotIn('second-private-code', json.dumps(message))

    async def close_code(self, socket):
        async with asyncio.timeout(3):
            while (message := await socket.receive()).type != WSMsgType.CLOSE:
                self.assertNotIn(message.type, (WSMsgType.CLOSED, WSMsgType.ERROR))
            return message.data

    async def peers(self, socket, timeout=3):
        async with asyncio.timeout(timeout):
            while True:
                message = await socket.receive()
                if message.type == WSMsgType.TEXT and json.loads(message.data).get('type') == 'peers':
                    return json.loads(message.data)['peers']

    async def test_silent_page_in_a_game_is_closed_so_the_others_stop_waiting(self):
        # A crashed or frozen page whose browser still answers pings: without
        # this the host waits for it, and a guest of a dead host waits forever.
        self.app[STATE]['relay'].silence_timeout = .3
        host, guest = [await self.player() for _ in range(2)]
        for player in (host, guest):
            await player[0].send_bytes(bytes([255, 0]))
        await self.load(host, guest)
        started = asyncio.get_running_loop().time()
        async with asyncio.timeout(3):
            while True:
                await host[0].send_bytes(bytes([255, 0]))
                try:
                    peers = await self.peers(host[0], .1)
                except TimeoutError:
                    continue
                if guest[1] not in peers:
                    break
        self.assertGreaterEqual(asyncio.get_running_loop().time() - started, .3)
        self.assertFalse(host[0].closed, 'A page that sends heartbeats stays')
        self.assertEqual(await self.close_code(guest[0]), 4000)

    async def test_heartbeats_reach_no_peer_and_old_pages_are_not_closed_for_silence(self):
        self.app[STATE]['relay'].silence_timeout = .2
        host, guest, idle = [await self.player() for _ in range(3)]
        await self.load(host, guest)
        # The guest sends one heartbeat but plays no game with the idle page.
        await idle[0].send_bytes(bytes([255, 0]))
        await host[0].send_bytes(bytes([255, 0]))
        with self.assertRaises(TimeoutError):
            async with asyncio.timeout(.3):
                while (await guest[0].receive()).type != WSMsgType.BINARY:
                    pass
        await asyncio.sleep(.6)
        # The guest (no heartbeats: an older launcher) and the idle page (no
        # game) stay; the silent host in a game does not.
        self.assertFalse(guest[0].closed)
        self.assertFalse(idle[0].closed)
        self.assertEqual(await self.close_code(host[0]), 4000)
        self.assertEqual(sorted(self.app[STATE]['relay'].rooms['shared-1'].peers), sorted([guest[1], idle[1]]))

    async def test_runtime_exit_and_idle_timeout_broadcast_decrements(self):
        observer = await self.observer()
        host, guest = [await self.player() for _ in range(2)]
        await self.play(host, guest)
        await self.count(observer, 1)
        await host[0].send_bytes(b'\x00'+frame(8, src=0, dst=0, connection=0))
        # GONE forwards to the guest; consume it before starting another stream.
        while (await guest[0].receive()).type != WSMsgType.BINARY:
            pass
        await self.count(observer, 0)
        await self.play(host, guest)
        await self.count(observer, 1)
        relay = self.app[STATE]['relay']
        for connection in relay.rooms['shared-1'].matches.connections.values():
            connection.last_seen -= 121
        relay.prune_matches()
        await self.count(observer, 0)

    async def test_solo_host_map_lifecycle_is_counted_without_remote_game_traffic(self):
        observer = await self.observer()
        host = await self.player()
        await host[0].send_bytes(bytes([255])+frame(9, src=6112, dst=0, connection=1))
        await self.count(observer, 1)
        self.assertEqual(self.app[STATE]['relay'].game_count(), 1)
        await host[0].send_bytes(bytes([255])+frame(9, src=6112, dst=0, connection=0))
        await self.count(observer, 0)
        await host[0].send_bytes(bytes([255])+frame(9, src=6112, dst=0, connection=1))
        await self.count(observer, 1)
        await host[0].close();await self.count(observer, 0)

    async def test_host_report_is_not_forwarded_or_counted_twice_and_outlives_last_guest(self):
        observer = await self.observer()
        host, guest = [await self.player() for _ in range(2)]
        await self.play(host, guest);await self.count(observer, 1)
        await host[0].send_bytes(bytes([255])+frame(9, src=6112, dst=0, connection=1))
        with self.assertRaises(TimeoutError):
            async with asyncio.timeout(.1):
                while (await guest[0].receive()).type != WSMsgType.BINARY:
                    pass
        self.assertEqual(self.app[STATE]['relay'].game_count(), 1)
        await guest[0].close();await asyncio.sleep(.05)
        self.assertEqual(self.app[STATE]['relay'].game_count(), 1)
        await host[0].send_bytes(bytes([255])+frame(9, src=6112, dst=0, connection=0))
        await self.count(observer, 0)

