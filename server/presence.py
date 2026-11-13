"""Anonymous live counts for the launcher page ("Playing now").

Every open launcher page reports its game state. The legacy LAN player count
also needs the opaque token of a live relay connection. lanGames independently
counts started matches observed in the game protocol. Counts and public lobby
occupancy are broadcast together, so departures cannot leave ghost players.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import time

from aiohttp import WSMsgType, web

from .geoip import behind_proxy, connection_address, peer_address
from .relay import Relay

RECONNECT_COOKIE = "w3ft_presence"
LEGACY_KICK_IDLE_TTL = 3600


class Presence:
    def __init__(self, max_connections: int = 4096, broadcast_interval: float = 1.0, heartbeat: float = 15,
                 relay: Relay | None = None, track_clients: bool = False, legacy_kick_guard: bool = False):
        # Behind the reverse proxy every visitor shares the proxy's address, so
        # only the total number of connections is capped. The counts are
        # informational: an inflated number cannot affect games or lobbies.
        self.states: dict[web.WebSocketResponse, tuple[bool, str | None]] = {}
        # Owner-only troubleshooting. Never include these records in snapshot(),
        # the public WebSocket or /api/status; no connection history is kept.
        self.track_clients = track_clients
        self.clients: dict[web.WebSocketResponse, dict] = {}
        self.next_client_id = 1
        self.generation = secrets.token_hex(16)
        self.legacy_kick_guard = legacy_kick_guard
        self.reconnect_keys = {}
        self.legacy_kicks = {}
        self.pending = set()
        self.relay = relay
        self.max_connections = max_connections
        self.broadcast_interval = broadcast_interval
        self.heartbeat = heartbeat  # a vanished page stops counting within 1.5×
        self.dirty = False
        self.broadcast_task: asyncio.Task | None = None
        self.on_counts = None  # optional aggregate history, never client metadata

    def counts(self):
        return {"online": len(self.states),
                "playing": sum(1 for playing, _ in self.states.values() if playing),
                "lanGames": self.relay.game_count() if self.relay is not None else 0,
                "lan": len({token for playing, token in self.states.values()
                            if playing and token and self.relay is not None and self.relay.has_presence_token(token)})}

    def snapshot(self):
        return {"type": "presence", **self.counts(),
                **(self.relay.lobby_snapshot() if self.relay is not None else {})}

    def inspect_clients(self):
        sessions = []
        for socket, client in self.clients.items():
            playing, token = self.states[socket]
            sessions.append({**client, "playing": playing,
                             "lan": bool(playing and token and self.relay is not None
                                         and self.relay.has_presence_token(token))})
        return {"counts": self.counts(), "sessions": sessions}

    async def kick(self, identifier):
        socket = next((socket for socket, client in self.clients.items() if client["id"] == identifier), None)
        if socket is None or socket.closed:
            return "missing"
        supported = self.clients[socket]["kickSupported"]
        if not supported and (key := self.reconnect_keys.get(socket)):
            # Old launchers ignore the kick and retry forever. Remember their
            # browser cookie, not their IP: other devices behind a NAT are safe.
            self.remember_legacy_kick(key)
        _, token = self.states.pop(socket)
        self.clients.pop(socket)
        self.changed()
        try:
            async with asyncio.timeout(2):
                await socket.send_str(json.dumps({"type": "kick"}))
        except (TimeoutError, ConnectionError, RuntimeError):
            pass  # Still use the reserved close code, never a normal reconnect.
        finally:
            await asyncio.gather(socket.close(code=4003, message=b"Session ended by administrator"),
                                 self.relay.disconnect_presence(token) if self.relay and token else asyncio.sleep(0))
        return "kicked" if supported else "disconnected"

    def remember_legacy_kick(self, key):
        now = time.monotonic()
        self.legacy_kicks = {key: deadline for key, deadline in self.legacy_kicks.items() if deadline > now}
        self.legacy_kicks.pop(key, None)
        while len(self.legacy_kicks) >= self.max_connections:
            self.legacy_kicks.pop(next(iter(self.legacy_kicks)))
        # Retain active retries; forget idle entries after an hour or restart.
        self.legacy_kicks[key] = now + LEGACY_KICK_IDLE_TTL

    def changed(self):
        self.dirty = True
        if self.on_counts is not None:
            self.on_counts(self.counts())
        if self.broadcast_task is None or self.broadcast_task.done():
            self.broadcast_task = asyncio.create_task(self.broadcast())

    async def broadcast(self):
        # Bursts (page loads, a LAN match starting) become one message per
        # interval; a change during sending schedules the next one.
        while self.dirty:
            await asyncio.sleep(self.broadcast_interval)
            self.dirty = False
            message = json.dumps(self.snapshot())
            await asyncio.gather(*(self.send(socket, message) for socket in list(self.states)))

    @staticmethod
    async def send(socket, message):
        try:
            async with asyncio.timeout(2):
                await socket.send_str(message)
        except (TimeoutError, ConnectionError, RuntimeError):
            if not socket.closed:
                await socket.close()

    async def connect(self, request):
        Relay.check_origin(request)
        if len(self.states) + len(self.pending) >= self.max_connections:
            raise web.HTTPServiceUnavailable(text="Too many open launcher pages")
        socket = web.WebSocketResponse(max_msg_size=256, heartbeat=self.heartbeat)
        key = None
        if self.legacy_kick_guard:
            key = request.cookies.get(RECONNECT_COOKIE, "")
            if not key.startswith(self.generation + ".") or len(key) != 65:
                key = self.generation + "." + secrets.token_urlsafe(24)
                socket.set_cookie(RECONNECT_COOKIE, key, path="/api/presence", httponly=True, samesite="Strict",
                                  secure=request.secure or (behind_proxy(peer_address(request))
                                          and request.headers.get("X-Forwarded-Proto") == "https"))
        # Pending upgrades count towards the cap, but not towards live players.
        self.pending.add(socket)
        try:
            await socket.prepare(request)
            first = None
            if key and self.legacy_kicks.get(key, 0) > time.monotonic():
                self.remember_legacy_kick(key)
                try:
                    first = await socket.receive(timeout=5)
                    data = json.loads(first.data) if first.type == WSMsgType.TEXT else None
                except (TimeoutError, ValueError):
                    data = None
                if not isinstance(data, dict) or type(data.get("control")) is not int or data["control"] != 1:
                    await socket.close(code=4003, message=b"Reload the page to reconnect")
                    return socket
                # A freshly loaded/current launcher can reconnect. Older tabs
                # in this browser remain blocked; no IP or modern tab is banned.
            self.pending.discard(socket)
            self.states[socket] = (False, None)
            self.reconnect_keys[socket] = key
            if self.track_clients:
                address, peer = connection_address(request), peer_address(request)
                self.clients[socket] = {"id": self.next_client_id,
                                        "ip": str(address) if address is not None else None,
                                        "peerIp": str(peer) if peer is not None else None,
                                        "userAgent": request.headers.get("User-Agent", "")[:512],
                                        "connectedAt": time.time(), "lastReportAt": None, "playingSince": None,
                                        "kickSupported": False}
                self.next_client_id += 1
            self.changed()
            await self.send(socket, json.dumps(self.snapshot()))
            window, count = time.monotonic(), 0

            async def reports():
                if first is not None:
                    yield first
                async for message in socket:
                    yield message

            async for message in reports():
                if socket not in self.states:
                    break  # removed by the administrator while a message arrived
                if message.type == WSMsgType.ERROR:
                    break
                if message.type != WSMsgType.TEXT:
                    await socket.close(code=1003, message=b"State messages are JSON text")
                    break
                now = time.monotonic()
                if now - window >= 10:
                    window, count = now, 0
                count += 1
                if count > 20:
                    await socket.close(code=1008, message=b"Rate limit")
                    break
                try:
                    data = json.loads(message.data)
                except ValueError:
                    data = None
                if (not isinstance(data, dict) or not isinstance(data.get("playing"), bool)
                        or not isinstance(data.get("lan", False), bool)
                        or (data.get("presenceToken") is not None
                            and (not isinstance(data["presenceToken"], str) or len(data["presenceToken"]) > 64))):
                    await socket.close(code=1008, message=b"Expected {playing, lan} booleans")
                    break
                state = (data["playing"], data.get("presenceToken") if data["playing"] and data.get("lan", False) else None)
                if client := self.clients.get(socket):
                    client["kickSupported"] = type(data.get("control")) is int and data["control"] == 1
                    client["lastReportAt"] = time.time()
                    if state[0] and not self.states[socket][0]:
                        client["playingSince"] = client["lastReportAt"]
                    elif not state[0]:
                        client["playingSince"] = None
                if self.states.get(socket) != state:
                    self.states[socket] = state
                    self.changed()
        finally:
            self.pending.discard(socket)
            self.reconnect_keys.pop(socket, None)
            self.clients.pop(socket, None)
            if self.states.pop(socket, None) is not None and socket.prepared:
                self.changed()
        return socket

    async def shutdown(self, app):
        if self.relay is not None:
            self.relay.on_change = None
        await asyncio.gather(*(socket.close(code=1001, message=b"Server stopping")
                               for socket in list(self.states) + list(self.pending)))
        if self.broadcast_task is not None:
            self.broadcast_task.cancel()
            await asyncio.gather(self.broadcast_task, return_exceptions=True)
