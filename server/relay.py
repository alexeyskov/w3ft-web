"""Room-isolated reliable frame transport; this is NOT a Winsock implementation.

Wire: client binary [destination:u8, payload...]; destination 0 broadcasts.
Server binary [source:u8, payload...]. Peer IDs are assigned by the server.
Destination 255 carries heartbeats and match status for the server only.
JSON control messages never carry game traffic. A WC3 Winsock shim must implement
socket addressing, listen/connect/accept and UDP over this reliable transport.

Rooms are Garena-style lobbies of up to 200 players; one Warcraft match still
holds 12. Public lobbies 1–4 always exist and are shared by every game language.
"Play" without a lobby connects to /api/relay/auto, which seats the player in
the first public lobby with a free seat, in numeric order, and opens temporary
overflow lobbies when all existing public lobbies are full.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import itertools
import re
import secrets
import time
import unicodedata
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web

from .matches import MatchTracker

HEARTBEAT = 255  # no peer has this ID: old servers forward such a frame to nobody


@dataclass
class Room:
    peers: dict[int, web.WebSocketResponse] = field(default_factory=dict)
    matches: MatchTracker = field(default_factory=MatchTracker)
    name: str | None = None
    created_at: float = field(default_factory=time.monotonic)
    capacity: int = 200
    shared: int = 0  # number of a shared lobby, 0 for created lobbies and codes
    permanent: bool = False
    empty_since: float | None = None


class Relay:
    def __init__(self, max_rooms: int = 256, capacity: int = 200, shared_lobbies: int = 4,
                 empty_lobby_ttl: float = 120, heartbeat: float = 10, silence_timeout: float = 45):
        # Peer IDs are one byte, 0 is broadcast: at most 254 peers per room.
        if not 1 <= capacity <= 254:
            raise ValueError("Room capacity must be 1–254")
        if not 1 <= shared_lobbies <= max_rooms:
            raise ValueError("The room limit must accommodate the permanent public lobbies")
        self.rooms: dict[str, Room] = {}
        self.max_rooms = max_rooms
        self.capacity = capacity
        self.empty_lobby_ttl = empty_lobby_ttl
        # A player whose page vanished without closing the connection (crash,
        # sleep, lost network) misses a ping and frees the seat within 1.5×.
        self.heartbeat = heartbeat
        # A page that crashed or froze while its browser kept the connection
        # (the browser's network process answers pings) is closed after this
        # long without a frame, if it sends heartbeats and is in a Warcraft
        # game. Otherwise the others wait for it with no end: a guest's
        # "Waiting for host" offers only Disconnect.
        self.silence_timeout = silence_timeout
        self.pending_announcements: set[asyncio.Task] = set()
        self.presence_tokens: dict[str, web.WebSocketResponse] = {}
        self.on_change = None
        for number in range(1, shared_lobbies + 1):
            self.rooms[self.shared_key(number)] = self.shared_room(number, permanent=True)

    @staticmethod
    def shared_key(number):
        return f"shared-{number}"

    def shared_room(self, number, permanent=False):
        return Room(name=f"Public lobby {number}", capacity=self.capacity, shared=number, permanent=permanent)

    def assign_shared(self):
        # Synchronous with the caller's seat reservation: concurrent players
        # cannot both take the last free seat of a lobby.
        shared = sorted((room.shared, key) for key, room in self.rooms.items() if room.shared)
        for _, key in shared:
            if len(self.rooms[key].peers) < self.rooms[key].capacity:
                return key
        if len(self.rooms) >= self.max_rooms:
            raise web.HTTPServiceUnavailable(text="Room limit reached")
        used = {number for number, _ in shared}
        number = next(n for n in itertools.count(1) if n not in used)
        self.rooms[self.shared_key(number)] = self.shared_room(number)
        return self.shared_key(number)

    @staticmethod
    def check_origin(request):
        origin = request.headers.get("Origin")
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme not in ("http", "https") or parsed.netloc != request.host:
                raise web.HTTPForbidden(text="Origin must match this server")

    def prune_empty_lobbies(self):
        now = time.monotonic()
        changed = False
        for key, room in list(self.rooms.items()):
            idle_since = room.empty_since if room.empty_since is not None else room.created_at
            if not room.peers and not room.permanent and now - idle_since >= self.empty_lobby_ttl:
                self.rooms.pop(key)
                changed = True
        if changed:
            self.changed()

    def changed(self):
        if self.on_change is not None:
            self.on_change()

    def has_presence_token(self, token):
        socket = self.presence_tokens.get(token)
        return socket is not None and socket.prepared and not socket.closed

    def game_count(self):
        return sum(room.matches.count for room in self.rooms.values())

    def prune_matches(self):
        now = time.monotonic()
        changed = False
        for room in list(self.rooms.values()):
            changed = room.matches.expire(now) or changed
        if changed:
            self.changed()

    async def lifecycle(self, app):
        async def expire_matches():
            while True:
                await asyncio.sleep(10)
                self.prune_matches()
        task = asyncio.create_task(expire_matches())
        try:
            yield
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def disconnect_presence(self, token):
        socket = self.presence_tokens.get(token)
        if socket is not None:
            await socket.close(code=4003, message=b"Session ended by administrator")

    def lobby_info(self, key, room):
        info = {"id": key, "name": room.name, "players": len(room.peers), "maxPlayers": room.capacity}
        if room.shared:
            info["shared"] = room.shared
            info["temporary"] = not room.permanent
        return info

    def lobby_snapshot(self):
        # Ad-hoc room codes remain private and are never published here.
        # Public lobbies first, in numeric order; then created ones.
        rooms = sorted(((key, room) for key, room in self.rooms.items() if room.name is not None),
                       key=lambda item: (0, item[1].shared, 0.0) if item[1].shared
                       else (1, 0, item[1].created_at))
        lobbies = [self.lobby_info(key, room) for key, room in rooms]
        private_players = sum(len(room.peers) for room in self.rooms.values() if room.name is None)
        return {"lobbies": lobbies, "maxPlayers": self.capacity, "privatePlayers": private_players}

    async def list_lobbies(self, request):
        self.prune_empty_lobbies()
        return web.json_response(self.lobby_snapshot(),
                                 headers={"Cache-Control": "no-store"})

    async def create_lobby(self, request):
        self.check_origin(request)
        if request.content_type != "application/json":
            raise web.HTTPUnsupportedMediaType(text="Expected application/json")
        try:
            data = await request.clone(client_max_size=1024).json()
        except ValueError:
            raise web.HTTPBadRequest(text="Invalid JSON")
        name = data.get("name") if isinstance(data, dict) else None
        if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 48
                or any(unicodedata.category(char).startswith("C") for char in name)):
            raise web.HTTPBadRequest(text="Lobby name must contain 1–48 characters without control characters")
        self.prune_empty_lobbies()
        if len(self.rooms) >= self.max_rooms:
            raise web.HTTPServiceUnavailable(text="Room limit reached")
        key = secrets.token_urlsafe(12)
        while key in self.rooms:
            key = secrets.token_urlsafe(12)
        room = self.rooms[key] = Room(name=name.strip(), capacity=self.capacity)
        self.changed()
        return web.json_response(self.lobby_info(key, room), status=201,
                                 headers={"Cache-Control": "no-store"})

    async def send(self, socket, *, control=None, packet=None):
        try:
            async with asyncio.timeout(2):
                if control is not None:
                    await socket.send_json(control)
                else:
                    await socket.send_bytes(packet)
        except (TimeoutError, ConnectionError, RuntimeError):
            if socket.prepared:
                await socket.close()

    async def announce(self, room):
        control = {"type": "peers", "peers": sorted(room.peers)}
        await asyncio.gather(*(self.send(p, control=control) for p in list(room.peers.values()) if p.prepared))

    async def connect(self, request):
        self.check_origin(request)
        key = request.match_info["room"]
        self.prune_empty_lobbies()
        if key == "auto":
            # Older launchers may still send ?language=ru/en. All use one pool.
            key = self.assign_shared()
        elif legacy := re.fullmatch(r"shared-(?:en|ru)-([1-9]\d{0,8})", key):
            key = self.shared_key(int(legacy[1]))
        elif not re.fullmatch(r"[a-zA-Z0-9_-]{8,64}", key):
            raise web.HTTPBadRequest(text="Room code must contain 8–64 letters, digits, underscores or hyphens")
        if key.startswith("shared-") and key not in self.rooms:
            raise web.HTTPNotFound(text="Public lobby no longer exists")
        if request.query.get("lobby") == "1" and (key not in self.rooms or self.rooms[key].name is None):
            raise web.HTTPNotFound(text="Lobby no longer exists")
        if key not in self.rooms and len(self.rooms) >= self.max_rooms:
            raise web.HTTPServiceUnavailable(text="Room limit reached")
        room = self.rooms.setdefault(key, Room(capacity=self.capacity))
        if len(room.peers) >= room.capacity:
            raise web.HTTPConflict(text="Room is full")
        peer_id = next(i for i in range(1, room.capacity + 1) if i not in room.peers)
        socket = web.WebSocketResponse(max_msg_size=65536, heartbeat=self.heartbeat, receive_timeout=90)
        # Reserve before the first await, so concurrent upgrades cannot share an ID.
        room.empty_since = None
        room.peers[peer_id] = socket
        token = secrets.token_urlsafe(18)
        while token in self.presence_tokens:
            token = secrets.token_urlsafe(18)
        self.presence_tokens[token] = socket
        state = {"seen": time.monotonic(), "beats": False}
        watchdog = None
        try:
            await socket.prepare(request)
            self.changed()
            await self.send(socket, control={"type": "welcome", "peerId": peer_id,
                                            "room": key, "protocol": "wc3-frame-relay-v1",
                                            "presenceToken": token,
                                            "peers": sorted(room.peers),
                                            "lobby": self.lobby_info(key, room)})
            await self.announce(room)
            watchdog = asyncio.create_task(self.watch_silence(socket, room, peer_id, state))
            window_start, count, total = time.monotonic(), 0, 0
            async for message in socket:
                now = time.monotonic()
                if now - window_start >= 1:
                    window_start, count, total = now, 0, 0
                count += 1
                total += len(message.data) if isinstance(message.data, (bytes, str)) else 0
                if count > 2000 or total > 10 * 1024 * 1024:
                    await socket.close(code=1008, message=b"Rate limit")
                    break
                if message.type == WSMsgType.BINARY:
                    state["seen"] = now
                    if len(message.data) < 2:
                        await socket.close(code=1008, message=b"Missing destination or payload")
                        break
                    destination = message.data[0]
                    if destination == HEARTBEAT:
                        state["beats"] = True
                        # New launchers report a hosted map here even with no
                        # guests (a LAN game against AI). Never forward this.
                        if room.matches.observe(peer_id, destination, memoryview(message.data)[1:], now):
                            self.changed()
                        continue
                    packet = bytes([peer_id]) + message.data[1:]
                    targets = [p for i, p in room.peers.items()
                               if i != peer_id and destination in (0, i) and p.prepared]
                    # Observe the original stream without changing or delaying
                    # its bytes. GONE also matters when no other peer remains.
                    if (targets or destination == 0) and room.matches.observe(peer_id, destination, memoryview(message.data)[1:], now):
                        self.changed()
                    await asyncio.gather(*(self.send(p, packet=packet) for p in targets))
                elif message.type == WSMsgType.TEXT:
                    await socket.close(code=1003, message=b"Game transport accepts binary frames only")
                    break
                elif message.type == WSMsgType.ERROR:
                    break
        finally:
            if watchdog is not None:
                watchdog.cancel()
            self.presence_tokens.pop(token, None)
            room.peers.pop(peer_id, None)
            room.matches.disconnect(peer_id)
            if not room.peers and not room.permanent:
                if room.shared or room.name is not None:
                    # Give the last visitor time to reconnect to a named lobby
                    # after a lost socket or a fresh game launch.
                    room.empty_since = time.monotonic()
                else:
                    self.rooms.pop(key, None)
            self.changed()
            if room.peers:
                # A disconnected HTTP request may be cancelled while this
                # broadcast yields. Other peers still need the leave event to
                # update the lobby and fail the departed player's TCP streams.
                announcement = asyncio.create_task(self.announce(room))
                self.pending_announcements.add(announcement)
                announcement.add_done_callback(self.pending_announcements.discard)
                await asyncio.shield(announcement)
        return socket

    async def watch_silence(self, socket, room, peer_id, state):
        # Any frame, game data or heartbeat, proves the page runs. Pages
        # without heartbeats (older launchers) are never closed for silence.
        while not socket.closed:
            await asyncio.sleep(max(.05, self.silence_timeout / 3))
            if (state["beats"] and time.monotonic() - state["seen"] > self.silence_timeout
                    and room.matches.in_game(peer_id)):
                await socket.close(code=4000, message=b"Page stopped responding")
                return

    async def shutdown(self, app):
        peers = [p for r in self.rooms.values() for p in r.peers.values()]
        await asyncio.gather(*(p.close(code=1001, message=b"Server stopping") for p in peers))
        await asyncio.gather(*list(self.pending_announcements), return_exceptions=True)
