import struct
import unittest

from server.matches import MatchTracker, MAX_CONNECTIONS


def wire(kind, payload=b'', *, src=50000, dst=6112, connection=42):
    return struct.pack('<IBBHHHI', 0x31535743, kind, 0, src, dst, len(payload), connection)+payload


def w3gs(identifier, body=b''):
    return bytes([0xF7, identifier])+struct.pack('<H', 4+len(body))+body


class MatchTests(unittest.TestCase):
    def setUp(self):
        self.tracker = MatchTracker()

    def host_packet(self, host=1, guest=2, payload=b'', *, connection=42, now=1):
        return self.tracker.observe(host, guest, wire(5, payload, src=6112, dst=50000, connection=connection), now)

    def guest_packet(self, host=1, guest=2, payload=b'', *, connection=42, now=1):
        return self.tracker.observe(guest, host, wire(5, payload, connection=connection), now)

    def join(self, host=1, guest=2, connection=42):
        self.tracker.observe(guest, host, wire(2, connection=connection), 0)
        self.host_packet(host, guest, w3gs(0x04, bytes(4)), connection=connection)

    def start(self, host=1, guest=2, connection=42):
        self.join(host, guest, connection)
        self.host_packet(host, guest, w3gs(0x0B), connection=connection)
        return self.host_packet(host, guest, w3gs(0x0C, b'\x64\x00'), connection=connection)

    def test_waiting_for_players_and_loading_do_not_count(self):
        # LAN advertisements are not running games, even if a datagram or chat
        # happens to contain bytes that look like a start/action packet.
        self.tracker.observe(1, 0, wire(1, w3gs(0x30)+w3gs(0x0C, bytes(2))), 0)
        self.join()
        self.host_packet(payload=w3gs(0x0A)+w3gs(0x0B))
        self.guest_packet(payload=w3gs(0x23))
        self.assertEqual(self.tracker.count, 0)
        self.assertTrue(self.host_packet(payload=w3gs(0x0C, bytes(2))))
        self.assertEqual(self.tracker.count, 1)

    def test_multiple_guests_count_once_and_other_host_is_a_second_game(self):
        self.start(1, 2)
        self.join(1, 3)
        self.host_packet(1, 3, w3gs(0x0B)+w3gs(0x0C, bytes(2)))
        self.assertFalse(self.host_packet(1, 2, w3gs(0x0C, bytes(2))*10))
        self.assertEqual(self.tracker.count, 1)
        self.assertTrue(self.start(4, 5))
        self.assertEqual(self.tracker.count, 2)

    def test_tcp_fragmentation_and_combined_packets_in_both_directions(self):
        self.tracker.observe(2, 1, wire(2), 0)
        payload = w3gs(0x04, bytes(4))+w3gs(0x0B)+w3gs(0x0C, b'\x64\x00')
        for byte in payload:
            self.host_packet(payload=bytes([byte]))
            self.guest_packet(payload=w3gs(0x28, w3gs(0x0C, bytes(2))))
        self.assertEqual(self.tracker.count, 1)
        self.assertLessEqual(len(next(iter(self.tracker.connections.values())).streams[(1, 6112)].header), 4)

    def test_direction_and_start_sequence_matter(self):
        self.host_packet(payload=w3gs(0x04, bytes(4))+w3gs(0x0B)+w3gs(0x0C, bytes(2)))
        self.assertEqual(self.tracker.count, 0, 'TCP stream was never opened')
        self.join()
        self.guest_packet(payload=w3gs(0x0B)+w3gs(0x0C, bytes(2)))
        self.host_packet(payload=w3gs(0x0C, bytes(2)))
        self.assertEqual(self.tracker.count, 0, 'No host countdown-end/loading transition')
        self.host_packet(payload=w3gs(0x0B)+w3gs(0x48, bytes(2)))
        self.assertEqual(self.tracker.count, 1)

    def test_leaving_one_of_three_players_preserves_the_match(self):
        self.start()
        self.join(1, 3)
        self.assertFalse(self.guest_packet(1, 2, w3gs(0x21, bytes(4))))
        self.assertEqual(self.tracker.count, 1)
        self.assertTrue(self.guest_packet(1, 3, w3gs(0x21, bytes(4))))
        self.assertEqual(self.tracker.count, 0, 'Only the host remains; no network match')

    def test_closed_or_reset_connection_ends_match(self):
        for kind in (6, 7):
            with self.subTest(kind=kind):
                self.start()
                self.assertTrue(self.tracker.observe(2, 1, wire(kind), 2))
                self.assertEqual(self.tracker.count, 0)

    def test_runtime_stopping_or_page_disconnecting_clears_all_matches_of_peer(self):
        self.start()
        self.join(1, 3)
        self.start(4, 5)
        self.assertTrue(self.tracker.observe(1, 0, wire(8, src=0, dst=0, connection=0), 2))
        self.assertEqual(self.tracker.count, 1)
        self.assertTrue(self.tracker.disconnect(5))
        self.assertEqual(self.tracker.count, 0)

    def test_new_game_on_reused_host_port_and_peer_has_no_old_start_state(self):
        self.start()
        self.tracker.disconnect(1)
        self.join(connection=100)
        self.host_packet(payload=w3gs(0x0C, bytes(2)), connection=100)
        self.assertEqual(self.tracker.count, 0)
        self.host_packet(payload=w3gs(0x0B)+w3gs(0x0C, bytes(2)), connection=100)
        self.assertEqual(self.tracker.count, 1)

    def test_idle_games_expire_but_paused_game_with_pings_stays(self):
        self.start()
        self.host_packet(payload=w3gs(0x01, bytes(4)), now=90)
        self.assertFalse(self.tracker.expire(200))
        self.assertEqual(self.tracker.count, 1)
        self.assertTrue(self.tracker.expire(211))
        self.assertEqual(self.tracker.count, 0)
        self.assertFalse(self.tracker.connections)

    def test_large_map_body_is_skipped_without_false_packets_or_retention(self):
        self.join()
        self.host_packet(payload=w3gs(0x0B))
        body = (w3gs(0x0C, bytes(2))*11000)[:65531]
        packet = w3gs(0x43, body)
        for at in range(0, len(packet), 137):
            self.host_packet(payload=packet[at:at+137])
        self.assertEqual(self.tracker.count, 0)
        stream = next(iter(self.tracker.connections.values())).streams[(1, 6112)]
        self.assertEqual((len(stream.header), stream.remaining), (0, 0))
        self.assertTrue(self.host_packet(payload=w3gs(0x0C, bytes(2))))

    def test_invalid_frames_and_streams_cannot_create_matches(self):
        self.join()
        for data in (b'', b'bad frame', wire(5, w3gs(0x0B))+b'extra',
                     wire(5, b'noise'+w3gs(0x0B)+w3gs(0x0C, bytes(2)))):
            self.tracker.observe(1, 2, data, 2)
        self.assertEqual(self.tracker.count, 0)

    def test_connection_memory_is_bounded_and_departure_frees_it(self):
        for number in range(1, MAX_CONNECTIONS+3):
            self.tracker.observe(2, 1, wire(2, connection=number), 0)
        self.assertEqual(len(self.tracker.connections), MAX_CONNECTIONS)
        self.tracker.disconnect(2)
        self.assertFalse(self.tracker.connections)

    def report(self, source=1, active=True, now=1, port=6112):
        return self.tracker.observe(source, 255, wire(9, src=port, dst=0, connection=int(active)), now)

    def test_solo_host_reports_are_one_match_and_deduplicate_remote_streams(self):
        self.assertTrue(self.report())
        self.assertEqual(self.tracker.count, 1)
        self.assertTrue(self.tracker.in_game(1))
        self.assertFalse(self.start())
        self.assertEqual(self.tracker.count, 1)
        self.assertFalse(self.guest_packet(payload=w3gs(0x21, bytes(4))))
        self.assertEqual(self.tracker.count, 1, 'Host still playing with AI')
        self.assertTrue(self.report(3))
        self.assertEqual(self.tracker.count, 2)
        self.assertTrue(self.report(active=False))
        self.assertEqual(self.tracker.count, 1)

    def test_reported_host_exit_removes_remaining_guest_streams(self):
        self.start();self.report()
        self.assertTrue(self.report(active=False))
        self.assertFalse(self.tracker.connections)
        self.assertEqual(self.tracker.count, 0)
        self.host_packet(payload=w3gs(0x0C, bytes(2)))
        self.assertEqual(self.tracker.count, 0)

    def test_reports_expire_disconnect_and_cannot_inflate_a_single_peer(self):
        self.report(now=0);self.report(now=100, port=6113)
        self.assertEqual(self.tracker.count, 1)
        self.assertFalse(self.tracker.expire(219));self.assertTrue(self.tracker.expire(220))
        self.report();self.assertTrue(self.tracker.disconnect(1));self.assertEqual(self.tracker.count, 0)
        for destination, data in [(0, wire(9, src=6112, dst=0, connection=1)),
                                  (255, wire(9, b'x', src=6112, dst=0, connection=1)),
                                  (255, wire(9, src=6112, dst=0, connection=2)),
                                  (255, wire(9, src=0, dst=0, connection=1))]:
            self.tracker.observe(1, destination, data, 0)
        self.assertEqual(self.tracker.count, 0)
