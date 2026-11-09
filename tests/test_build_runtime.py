import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import subprocess

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
    @unittest.skipUnless(SDK, "Local WASI SDK required")
    def test_relocated_module_executes_in_the_compact_window(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); image = root / 'fixture.dll'; image.write_bytes(fixture.pe32_fixture())
            fixture.adapter.generate(image, root / 'lift', max_functions=0, image_base=0x02000000)
            for variant in ('standard', 'compat'):
                builder.build(argparse.Namespace(sdk=SDK, module_dirs=[root / 'lift'], output=root / 'build',
                    jobs=1, objects_only=False, variant=variant, memory_layout='compact'))
            tested = subprocess.run(['node', str(ROOT / 'tests/compact_runtime_test.mjs'), str(root)],
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(tested.returncode, 0, tested.stdout + tested.stderr)
            self.assertIn('compact relocation passed', tested.stdout)

    def test_compact_layout_rejects_old_modules_and_overlapping_reserved_regions(self):
        module = lambda base, size=0x10000: {'name':'game', 'report':{'image_base':hex(base), 'image_size':size}}
        good = builder.memory_layout('compact', [module(0x02000000)])
        self.assertEqual(good['guest_window'], 512 * 1024 * 1024)
        self.assertGreater(good['heap_limit'] - good['heap_base'], 400 * 1024 * 1024)
        for base in (0x6f000000, 0x00c00000, 0x01ff0000, 0x04000000):
            with self.subTest(base=hex(base)), self.assertRaisesRegex(ValueError, 'does not fit'):
                builder.memory_layout('compact', [module(base)])
        with self.assertRaisesRegex(ValueError, 'does not fit'):
            builder.memory_layout('compact', [module(0x02000000), module(0x02000000)])
        old = module(0x02000000); del old['report']['image_size']
        with self.assertRaisesRegex(ValueError, 'Regenerate'):
            builder.memory_layout('compact', [old])

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
    def test_inlined_callee_change_rebuilds_its_caller_in_another_shard(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); image = root / 'fixture.exe'; image.write_bytes(fixture.pe32_fixture())
            fixture.adapter.generate(image, root / 'lift', max_functions=0)
            lift = root / 'lift'
            # Original synthetic functions: a flag-taking wrapper and its
            # virtual visitor live in different compilation units.
            with (lift / 'decls.h').open('a') as stream:
                stream.write('\nvoid sub_00502000(CPU *restrict c);\n')
            (lift / 'shard_1000.c').write_text('''#include "cpu.h"
#include "decls.h"
void sub_00501000(CPU *restrict c) {
    goto L_00501000;
L_00501000:;
    PUSH32(0x501005u); sub_00502000(c);
    if (MR8(c->esp+0x4u) & 0x1u) c->eax += 1;
    POP32(c->eip); c->esp += 4u; return;
}
''')
            callee = lift / 'shard_1001.c'
            callee.write_text('''#include "cpu.h"
void sub_00502000(CPU *restrict c) {
    goto L_00502000;
L_00502000:;
    if (c->ecx) {
        { uint32_t _ct = c->edx; PUSH32(0x502005u); DISPATCH_CALL(c, _ct); }
    }
    c->eax += 7;
    POP32(c->eip); return;
}
''')
            args = argparse.Namespace(sdk=SDK, module_dirs=[lift], output=root / 'build', jobs=1, objects_only=True)
            first = builder.build(args)
            second = builder.build(args)
            self.assertEqual(second['cached_objects'], first['objects'])
            callee.write_text(callee.read_text().replace('c->eax += 7;', 'c->eax += 9;'))
            third = builder.build(args)
            self.assertEqual(third['cached_objects'], third['objects'] - 2,
                             'The callee and its unchanged caller both need recompilation')

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
