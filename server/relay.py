"""Room-isolated reliable frame transport; this is NOT a Winsock implementation.

Wire: client binary [destination:u8, payload...]; destination 0 broadcasts.
Server binary [source:u8, payload...]. Peer IDs are assigned by the server.
JSON control messages never carry game traffic. A WC3 Winsock shim must implement
socket addressing, listen/connect/accept and UDP over this reliable transport.

Rooms are Garena-style lobbies of up to 200 players; one Warcraft match still
holds 12. Every game language has shared lobbies 1–2 that always exist. "Play"
without a lobby connects to /api/relay/auto?language=xx, which seats the player
in the first shared lobby of that language with a free seat, in numeric order,
and opens the next one when all are full. Created lobbies have no language:
the same Warcraft version plays across localizations.
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


@dataclass
class Room:
    peers: dict[int, web.WebSocketResponse] = field(default_factory=dict)
    name: str | None = None
    created_at: float = field(default_factory=time.monotonic)
    capacity: int = 200
    shared: int = 0  # number of a shared lobby, 0 for created lobbies and codes
    language: str | None = None  # game language of a shared lobby
    permanent: bool = False


class Relay:
    def __init__(self, max_rooms: int = 256, capacity: int = 200, shared_lobbies: int = 2,
                 languages: tuple[str, ...] = ("en", "ru"), default_language: str = "ru",
                 empty_lobby_ttl: float = 120, heartbeat: float = 10):
        # Peer IDs are one byte, 0 is broadcast: at most 254 peers per room.
        if not 1 <= capacity <= 254:
            raise ValueError("Room capacity must be 1–254")
        self.rooms: dict[str, Room] = {}
        self.max_rooms = max_rooms
        self.capacity = capacity
        self.empty_lobby_ttl = empty_lobby_ttl
        # A player whose page vanished without closing the connection (crash,
        # sleep, lost network) misses a ping and frees the seat within 1.5×.
        self.heartbeat = heartbeat
        self.pending_announcements: set[asyncio.Task] = set()
        # Listing order of language groups, as on the site: Latin-script names
        # A–Z (English), then Cyrillic А–Я (Русский). Players without a
        # language join the base installation's language.
        self.languages = tuple(languages)
        self.default_language = default_language if default_language in self.languages else self.languages[0]
        for language in self.languages:
            for number in range(1, shared_lobbies + 1):
                self.rooms[self.shared_key(language, number)] = self.shared_room(language, number, permanent=True)

    @staticmethod
    def shared_key(language, number):
        return f"shared-{language}-{number}"

    def shared_room(self, language, number, permanent=False):
        return Room(name=f"{language.upper()} lobby {number}", capacity=self.capacity, shared=number,
                    language=language, permanent=permanent)

    def assign_shared(self, language):
        # Synchronous with the caller's seat reservation: concurrent players
        # cannot both take the last free seat of a lobby.
        if language not in self.languages:
            raise web.HTTPBadRequest(text="Unknown lobby language")
        shared = sorted((room.shared, key) for key, room in self.rooms.items() if room.shared and room.language == language)
        for _, key in shared:
            if len(self.rooms[key].peers) < self.rooms[key].capacity:
                return key
        if len(self.rooms) >= self.max_rooms:
            raise web.HTTPServiceUnavailable(text="Room limit reached")
        used = {number for number, _ in shared}
        number = next(n for n in itertools.count(1) if n not in used)
        self.rooms[self.shared_key(language, number)] = self.shared_room(language, number)
        return self.shared_key(language, number)

    @staticmethod
    def check_origin(request):
        origin = request.headers.get("Origin")
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme not in ("http", "https") or parsed.netloc != request.host:
                raise web.HTTPForbidden(text="Origin must match this server")

    def prune_empty_lobbies(self):
        now = time.monotonic()
        for key, room in list(self.rooms.items()):
            if not room.peers and not room.permanent and now - room.created_at >= self.empty_lobby_ttl:
                self.rooms.pop(key)

    def lobby_info(self, key, room):
        info = {"id": key, "name": room.name, "players": len(room.peers), "maxPlayers": room.capacity}
        if room.shared:
            info["shared"] = room.shared
            info["language"] = room.language
        return info

    async def list_lobbies(self, request):
        self.prune_empty_lobbies()
        # Ad-hoc room codes remain private and are never published here.
        # Shared lobbies first, by language and number; then created ones.
        order = {language: index for index, language in enumerate(self.languages)}
        rooms = sorted(((key, room) for key, room in self.rooms.items() if room.name is not None),
                       key=lambda item: (0, order.get(item[1].language, 0), item[1].shared, 0.0) if item[1].shared
                       else (1, 0, 0, item[1].created_at))
        lobbies = [self.lobby_info(key, room) for key, room in rooms]
        return web.json_response({"lobbies": lobbies, "maxPlayers": self.capacity},
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
            key = self.assign_shared(request.query.get("language", self.default_language))
        elif not re.fullmatch(r"[a-zA-Z0-9_-]{8,64}", key):
            raise web.HTTPBadRequest(text="Room code must contain 8–64 letters, digits, underscores or hyphens")
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
        room.peers[peer_id] = socket
        try:
            await socket.prepare(request)
            await self.send(socket, control={"type": "welcome", "peerId": peer_id,
                                            "room": key, "protocol": "wc3-frame-relay-v1",
                                            "peers": sorted(room.peers),
                                            "lobby": self.lobby_info(key, room)})
            await self.announce(room)
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
                    if len(message.data) < 2:
                        await socket.close(code=1008, message=b"Missing destination or payload")
                        break
                    destination = message.data[0]
                    packet = bytes([peer_id]) + message.data[1:]
                    targets = [p for i, p in room.peers.items()
                               if i != peer_id and destination in (0, i) and p.prepared]
                    await asyncio.gather(*(self.send(p, packet=packet) for p in targets))
                elif message.type == WSMsgType.TEXT:
                    await socket.close(code=1003, message=b"Game transport accepts binary frames only")
                    break
                elif message.type == WSMsgType.ERROR:
                    break
        finally:
            room.peers.pop(peer_id, None)
            if room.peers:
                # A disconnected HTTP request may be cancelled while this
                # broadcast yields. Other peers still need the leave event to
                # update the lobby and fail the departed player's TCP streams.
                announcement = asyncio.create_task(self.announce(room))
                self.pending_announcements.add(announcement)
                announcement.add_done_callback(self.pending_announcements.discard)
                await asyncio.shield(announcement)
            elif not room.permanent:
                self.rooms.pop(key, None)
        return socket

    async def shutdown(self, app):
        peers = [p for r in self.rooms.values() for p in r.peers.values()]
        await asyncio.gather(*(p.close(code=1001, message=b"Server stopping") for p in peers))
        await asyncio.gather(*list(self.pending_announcements), return_exceptions=True)
