import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("package_runtime", ROOT / "tools/package_runtime.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


def metadata(variant, data, **changes):
    value = {"variant": variant, "features": ["+atomics"] + (["+tail-call"] if variant == "standard" else []),
             "sha256": hashlib.sha256(data).hexdigest(), "modules": [{"name": "game", "sha256": "a" * 64}],
             "runtime_headers": {"runtime/cpu.h": "b" * 64}, "strict_memory": False, "link_flags": ["-Wl,--no-entry"],
             "configuration": {"version": "clang 23"}, "sources": [{"source": "shard_0000.c", "sha256": "c" * 64}]}
    value.update(changes)
    return value


class CompatPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.target = Path(self.temp.name)
        self.wasm = b"\0asm\x01\0\0\0compat"
        self.build = metadata("standard", b"\0asm\x01\0\0\0standard")

    def tearDown(self):
        self.temp.cleanup()

    def write(self, **changes):
        (self.target / "wc3-compat.wasm").write_bytes(self.wasm)
        (self.target / "build-compat.json").write_text(json.dumps(metadata("compat", self.wasm, **changes)))

    def test_no_compat_build_packages_without_it(self):
        self.assertIsNone(package.compat_build(self.target, self.build))

    def test_build_identity_covers_host_modules_and_both_wasm_builds(self):
        host = self.target / 'client.mjs'
        host.write_text('export const value=1;')
        first = package.runtime_build_id(self.build, [host])
        self.assertEqual(first, package.runtime_build_id(self.build, [host]))
        host.write_text('export const value=2;')
        self.assertNotEqual(first, package.runtime_build_id(self.build, [host]))
        host.write_text('export const value=1;')
        self.assertNotEqual(first, package.runtime_build_id({**self.build, 'sha256':'e'*64}, [host]))
        compat = metadata('compat', self.wasm)
        other = package.runtime_build_id(self.build, [host], compat)
        self.assertNotEqual(first, other)
        self.assertNotEqual(other, package.runtime_build_id(self.build, [host], {**compat, 'sha256':'f'*64}))

    def test_a_build_from_the_same_code_is_listed(self):
        self.write()
        self.assertEqual(package.compat_build(self.target, self.build), "wc3-compat.wasm")

    def test_a_stale_or_altered_compat_build_stops_packaging(self):
        for changes in ({"sources": [{"source": "shard_0000.c", "sha256": "d" * 64}]},
                        {"runtime_headers": {"runtime/cpu.h": "e" * 64}},
                        {"modules": [{"name": "game", "sha256": "f" * 64}]},
                        {"memory": {"layout": "compact"}},
                        {"configuration": {"version": "clang 23", "self_calls": 1}},
                        {"configuration": {"version": "clang 23", "local_registers": True}},
                        {"configuration": {"version": "clang 23", "local_register_version": 1}},
                        {"configuration": {"version": "clang 23", "local_register_source": "e" * 64}},
                        {"features": ["+atomics", "+tail-call"]},
                        {"sha256": "0" * 64}):
            with self.subTest(changes=list(changes)):
                self.write(**changes)
                with self.assertRaises(SystemExit):
                    package.compat_build(self.target, self.build)
        (self.target / "wc3-compat.wasm").unlink()
        with self.assertRaises(SystemExit):
            package.compat_build(self.target, self.build)


if __name__ == "__main__":
    unittest.main()
