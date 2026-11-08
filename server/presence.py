"""Anonymous live counts for the launcher page ("Playing now").

Every open launcher page reports its game state. A LAN game also needs the
opaque token of a live relay connection. Counts and public lobby occupancy are
broadcast together, so a departed connection cannot leave a ghost LAN player.
"""
from __future__ import annotations

import asyncio
import json
import time

from aiohttp import WSMsgType, web

from .relay import Relay


class Presence:
    def __init__(self, max_connections: int = 4096, broadcast_interval: float = 1.0, heartbeat: float = 15,
                 relay: Relay | None = None):
        # Behind the reverse proxy every visitor shares the proxy's address, so
        # only the total number of connections is capped. The counts are
        # informational: an inflated number cannot affect games or lobbies.
        self.states: dict[web.WebSocketResponse, tuple[bool, str | None]] = {}
        self.relay = relay
        self.max_connections = max_connections
        self.broadcast_interval = broadcast_interval
        self.heartbeat = heartbeat  # a vanished page stops counting within 1.5×
        self.dirty = False
        self.broadcast_task: asyncio.Task | None = None

    def counts(self):
        return {"online": len(self.states),
                "playing": sum(1 for playing, _ in self.states.values() if playing),
                "lan": len({token for playing, token in self.states.values()
                            if playing and token and self.relay is not None and self.relay.has_presence_token(token)})}

    def snapshot(self):
        return {"type": "presence", **self.counts(),
                **(self.relay.lobby_snapshot() if self.relay is not None else {})}

    def changed(self):
        self.dirty = True
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
        if len(self.states) >= self.max_connections:
            raise web.HTTPServiceUnavailable(text="Too many open launcher pages")
        socket = web.WebSocketResponse(max_msg_size=256, heartbeat=self.heartbeat)
        # Reserve before the first await, so concurrent upgrades respect the cap.
        self.states[socket] = (False, None)
        try:
            await socket.prepare(request)
            self.changed()
            await self.send(socket, json.dumps(self.snapshot()))
            window, count = time.monotonic(), 0
            async for message in socket:
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
                if self.states.get(socket) != state:
                    self.states[socket] = state
                    self.changed()
        finally:
            if self.states.pop(socket, None) is not None and socket.prepared:
                self.changed()
        return socket

    async def shutdown(self, app):
        if self.relay is not None:
            self.relay.on_change = None
        await asyncio.gather(*(socket.close(code=1001, message=b"Server stopping") for socket in list(self.states)))
        if self.broadcast_task is not None:
            self.broadcast_task.cancel()
            await asyncio.gather(self.broadcast_task, return_exceptions=True)
