import unittest

from server import filter_discovered_peers


class TestFilterDiscoveredPeers(unittest.TestCase):
    def test_empty_list(self):
        self.assertEqual(filter_discovered_peers([]), [])

    def test_single_peer(self):
        peers = [{"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.10", "subnet": "192.168.1.0/24"}]

        self.assertEqual(filter_discovered_peers(peers), peers)

    def test_one_entry_per_instance_id(self):
        peers = [
            {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.10", "subnet": "192.168.1.0/24"},
            {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.11", "subnet": "192.168.1.0/24"},
            {"name": "server-b", "instance_id": "instance-b", "address": "192.168.1.20", "subnet": "192.168.1.0/24"},
        ]

        result = filter_discovered_peers(peers)

        self.assertEqual(result, [peers[0], peers[2]])

    def test_global_preferred_subnet(self):
        peers = [
            {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.10", "subnet": "192.168.1.0/24"},
            {"name": "server-a", "instance_id": "instance-a", "address": "10.0.0.10", "subnet": "10.0.0.0/24"},
            {"name": "server-b", "instance_id": "instance-b", "address": "10.0.0.20", "subnet": "10.0.0.0/24"},
            {"name": "server-c", "instance_id": "instance-c", "address": "10.0.0.30", "subnet": "10.0.0.0/24"},
        ]

        result = filter_discovered_peers(peers)

        self.assertEqual(result, [peers[1], peers[2], peers[3]])

    def test_instance_without_preferred_subnet_is_excluded(self):
        peers = [
            {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.10", "subnet": "192.168.1.0/24"},
            {"name": "server-b", "instance_id": "instance-b", "address": "10.0.0.20", "subnet": "10.0.0.0/24"},
            {"name": "server-c", "instance_id": "instance-c", "address": "10.0.0.30", "subnet": "10.0.0.0/24"},
        ]

        result = filter_discovered_peers(peers)

        self.assertEqual(result, [peers[1], peers[2]])

    def test_duplicate_entries_same_instance_and_ip(self):
        peers = [
            {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.10", "subnet": "192.168.1.0/23"},
            {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.10", "subnet": "192.168.1.0/23"},
            {"name": "server-b", "instance_id": "instance-b", "address": "192.168.2.20", "subnet": "192.168.1.0/23"},
            {"name": "server-c", "instance_id": "instance-c", "address": "192.168.56.10", "subnet": "192.168.56.0/24"},
        ]

        result = filter_discovered_peers(peers)

        self.assertEqual(result, [peers[0], peers[2]])

    def test_different_ips_same_instance(self):
        peers = [
            {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.10", "subnet": "192.168.1.0/24"},
            {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.11", "subnet": "192.168.1.0/24"},
            {"name": "server-b", "instance_id": "instance-b", "address": "192.168.1.20", "subnet": "192.168.1.0/24"},
        ]

        result = filter_discovered_peers(peers)

        self.assertEqual(result, [peers[0], peers[2]])

    def test_same_name_different_instance_ids(self):
        peers = [
            {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.10", "subnet": "192.168.1.0/24"},
            {"name": "server-a", "instance_id": "instance-b", "address": "192.168.1.11", "subnet": "192.168.1.0/24"},
            {"name": "server-b", "instance_id": "instance-c", "address": "192.168.1.20", "subnet": "192.168.1.0/24"},
        ]

        result = filter_discovered_peers(peers)

        self.assertEqual(result, peers)

    def test_same_ip_different_instances(self):
        peers = [
            {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.10", "subnet": "192.168.1.0/24"},
            {"name": "server-b", "instance_id": "instance-b", "address": "192.168.1.10", "subnet": "192.168.1.0/24"},
            {"name": "server-c", "instance_id": "instance-c", "address": "192.168.1.20", "subnet": "192.168.1.0/24"},
        ]

        result = filter_discovered_peers(peers)

        self.assertEqual(result, peers)

    def test_preferred_subnet_tie_uses_first_subnet(self):
        peers = [
            {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.10", "subnet": "192.168.1.0/24"},
            {"name": "server-b", "instance_id": "instance-b", "address": "192.168.1.20", "subnet": "192.168.1.0/24"},
            {"name": "server-c", "instance_id": "instance-c", "address": "10.0.0.10", "subnet": "10.0.0.0/24"},
            {"name": "server-d", "instance_id": "instance-d", "address": "10.0.0.20", "subnet": "10.0.0.0/24"},
        ]

        result = filter_discovered_peers(peers)

        self.assertEqual(result, [peers[0], peers[1]])

        def test_unusual_multiple_interfaces(self):
            peers = [
                {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.10", "subnet": "192.168.1.0/23"},
                {"name": "server-a", "instance_id": "instance-a", "address": "192.168.2.10", "subnet": "192.168.1.0/23"},
                {"name": "server-a", "instance_id": "instance-a", "address": "192.168.56.1", "subnet": "192.168.56.0/24"},
                {"name": "server-a", "instance_id": "instance-a", "address": "192.168.1.20", "subnet": "192.168.1.0/24"},
                {"name": "server-b", "instance_id": "instance-b", "address": "192.168.1.30", "subnet": "192.168.1.0/23"},
            ]

            result = filter_discovered_peers(peers)

            self.assertEqual(result, [peers[0], peers[4]])


if __name__ == "__main__":
    unittest.main()
