"""Count running multiplayer matches in one virtual LAN.

Only W3GS lifecycle headers are inspected; names, chat, maps and action payloads
are neither decoded nor retained. TCP writes may split or combine W3GS packets.
A match is grouped by its host's listening endpoint, not by guests or room.
Hosts also report their actual map/replay lifecycle so a LAN game against
only computer opponents is counted despite having no remote TCP stream.
Protocol identifiers: https://github.com/dcramer/ghostplusplus/blob/master/ghost/gameprotocol.h
"""
from __future__ import annotations

from dataclasses import dataclass, field
import struct


HEADER = struct.Struct('<IBBHHHI')
MAGIC = 0x31535743
SYN, DATA, FIN, RST, GONE, MATCH = 2, 5, 6, 7, 8, 9
MAX_CONNECTIONS = 2048


class PacketHeaders:
    """Retain at most four framing bytes, even during large map transfers."""
    def __init__(self):
        self.header = bytearray()
        self.remaining = 0
        self.identifier = self.size = 0
        self.invalid = False

    def feed(self, payload, received):
        while payload and not self.invalid:
            if self.remaining:
                take = min(self.remaining, len(payload))
                self.remaining -= take
                payload = payload[take:]
                if not self.remaining:
                    received(self.identifier, self.size)
            else:
                take = min(4-len(self.header), len(payload))
                self.header.extend(payload[:take])
                payload = payload[take:]
                if len(self.header) < 4:
                    continue
                self.identifier = self.header[1]
                self.size = int.from_bytes(self.header[2:4], 'little')
                self.invalid = self.header[0] != 0xF7 or self.size < 4
                self.header.clear()
                if self.invalid:
                    return
                self.remaining = self.size-4
                if not self.remaining:
                    received(self.identifier, self.size)


@dataclass
class Connection:
    host: tuple[int, int]
    guest: tuple[int, int]
    last_seen: float
    accepted: bool = False
    streams: dict = field(default_factory=dict)


@dataclass
class Match:
    connections: set = field(default_factory=set)
    loading: bool = False


class MatchTracker:
    def __init__(self):
        self.connections = {}
        self.matches = {}
        self.active = set()
        self.reported = {}  # peer -> (listening port, last report)
        self.running = set()  # union, updated on transitions rather than every frame

    @property
    def count(self):
        return len(self.running)

    def _sync(self, host):
        report = self.reported.get(host[0])
        if host in self.active or report is not None and report[0] == host[1]:
            self.running.add(host)
        else:
            self.running.discard(host)

    def _drop(self, key):
        connection = self.connections.pop(key, None)
        if connection is None:
            return
        match = self.matches.get(connection.host)
        if match is not None:
            match.connections.discard(key)
            if not match.connections:
                self.matches.pop(connection.host, None)
                self.active.discard(connection.host)
                self._sync(connection.host)

    def in_game(self, peer):
        """The peer hosts or joined a Warcraft game here (lobby slot, loading or match)."""
        return peer in self.reported or any(connection.accepted and peer in (connection.host[0], connection.guest[0])
                   for connection in self.connections.values())

    def disconnect(self, peer):
        before = self.count
        report = self.reported.pop(peer, None)
        if report is not None:
            self._sync((peer, report[0]))
        for key, connection in list(self.connections.items()):
            if peer in (connection.host[0], connection.guest[0]):
                self._drop(key)
        return before != self.count

    def expire(self, now, idle_timeout=120):
        before = self.count
        for key, connection in list(self.connections.items()):
            if now-connection.last_seen >= idle_timeout:
                self._drop(key)
        for peer, (port, last_seen) in list(self.reported.items()):
            if now-last_seen >= idle_timeout:
                self.reported.pop(peer)
                self._sync((peer, port))
        return before != self.count

    def _packet(self, key, connection, sender, identifier, size, now):
        if self.connections.get(key) is not connection:
            return  # a leave packet earlier in this same TCP write removed it
        connection.last_seen = now
        if sender == connection.host:
            if identifier == 0x04 and size >= 8:  # SLOTINFOJOIN: host accepted guest
                connection.accepted = True
                match = self.matches.setdefault(connection.host, Match())
                match.connections.add(key)
            elif connection.accepted:
                match = self.matches[connection.host]
                if identifier == 0x0B and size == 4:  # COUNTDOWN_END -> loading
                    match.loading = True
                elif identifier in (0x0C, 0x48) and size >= 6 and match.loading:
                    # Simulation time slots start after loading. All guests of
                    # this host contribute to the same single match.
                    self.active.add(connection.host)
                    self._sync(connection.host)
        elif sender == connection.guest and identifier == 0x21 and size == 8:
            self._drop(key)  # LEAVEGAME, including exit before socket close

    def observe(self, source, destination, frame, now):
        before = self.count
        if len(frame) < HEADER.size:
            return False
        magic, kind, reserved, src_port, dst_port, size, number = HEADER.unpack_from(frame)
        if magic != MAGIC or reserved or size != len(frame)-HEADER.size:
            return False
        if kind == MATCH:
            if destination != 255 or size or dst_port or not src_port or number not in (0, 1) or not 1 <= source <= 254:
                return False
            previous = self.reported.pop(source, None)
            if previous is not None:
                self._sync((source, previous[0]))
            if number:
                self.reported[source] = (src_port, now)
                self._sync((source, src_port))
            else:
                # An explicit host end is authoritative, even if an old guest
                # has not closed its stream yet. Remove old phase state too.
                for key, connection in list(self.connections.items()):
                    if connection.host == (source, src_port):
                        self._drop(key)
            return before != self.count
        if kind == GONE:
            return self.disconnect(source)
        if not (1 <= source <= 254 and 1 <= destination <= 254
                and source != destination and src_port and dst_port and number):
            return False
        sender, receiver = (source, src_port), (destination, dst_port)
        key = (*sorted((sender, receiver)), number)
        if kind == SYN:
            if key not in self.connections and len(self.connections) < MAX_CONNECTIONS:
                self.connections[key] = Connection(host=receiver, guest=sender, last_seen=now)
        elif kind in (FIN, RST):
            self._drop(key)
        elif kind == DATA and (connection := self.connections.get(key)) is not None:
            stream = connection.streams.setdefault(sender, PacketHeaders())
            stream.feed(memoryview(frame)[HEADER.size:],
                        lambda identifier, length: self._packet(key, connection, sender, identifier, length, now))
        return before != self.count
