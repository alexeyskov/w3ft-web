import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_runtime", ROOT / "tools/build_runtime.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
fixture_spec = importlib.util.spec_from_file_location("lift_fixture", ROOT / "tests/test_lift_wc3.py")
fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixture)
try:
    SDK = builder.sdk_path(None)
except ValueError:
    SDK = None


@unittest.skipUnless(fixture.HAVE_DEPS, "Lifter dependencies required")
class BuildInputTests(unittest.TestCase):
    def test_partial_module_cannot_be_published_as_complete_build_input(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); image = root / "fixture.exe"
            image.write_bytes(fixture.pe32_fixture())
            fixture.adapter.generate(image, root / "lift", max_functions=1)
            with self.assertRaisesRegex(ValueError, "Incomplete generation"):
                builder.module_inputs([root / "lift"])

    @unittest.skipUnless(SDK, "Local WASI SDK required")
    def test_cache_reuses_unchanged_objects_and_invalidates_changed_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); image = root / "fixture.exe"
            image.write_bytes(fixture.pe32_fixture())
            fixture.adapter.generate(image, root / "lift", max_functions=0)
            args = argparse.Namespace(sdk=SDK, module_dirs=[root / "lift"], output=root / "build",
                                      jobs=1, objects_only=True)
            first = builder.build(args)
            second = builder.build(args)
            self.assertEqual(first["cached_objects"], 0)
            self.assertEqual(second["cached_objects"], second["objects"])
            shard = root / "lift/shard_0000.c"
            shard.write_text(shard.read_text() + "\n/* changed source */\n")
            third = builder.build(args)
            self.assertEqual(third["cached_objects"], third["objects"] - 1)
            self.assertFalse(third["linked"])
            self.assertFalse(third["playable"])

    @unittest.skipUnless(SDK, "Local WASI SDK required")
    def test_compat_variant_links_without_tail_calls_next_to_the_standard_build(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); image = root / "fixture.exe"
            image.write_bytes(fixture.pe32_fixture())
            fixture.adapter.generate(image, root / "lift", max_functions=0)
            for variant in ("standard", "compat"):
                args = argparse.Namespace(sdk=SDK, module_dirs=[root / "lift"], output=root / "build",
                                          jobs=1, objects_only=False, variant=variant)
                result = builder.build(args)
                self.assertTrue(result["wasm_built"])
            build = root / "build"
            standard = json.loads((build / "build.json").read_text())
            compat = json.loads((build / "build-compat.json").read_text())
            self.assertEqual((standard["artifact"], compat["artifact"]), ("wc3.wasm", "wc3-compat.wasm"))
            self.assertIn("+tail-call", standard["features"])
            self.assertNotIn("+tail-call", compat["features"])
            self.assertEqual(builder.wasm_features(build / "wc3-compat.wasm"), compat["features"])
            self.assertIn("-DWC3_TAIL_TRAMPOLINE=1", compat["configuration"]["flags"])
            self.assertEqual(sorted((item["source"], item["sha256"]) for item in standard["sources"]),
                             sorted((item["source"], item["sha256"]) for item in compat["sources"]),
                             "Both builds record the shards as generated")
            self.assertTrue((build / "objects-compat").is_dir() and (build / "objects").is_dir())
            # The shards themselves stay as the lifter wrote them.
            self.assertNotIn("TAIL_RESUME", "".join(path.read_text() for path in (root / "lift").glob("*.c")))
