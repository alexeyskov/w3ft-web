"""Native GL staging against shared WASM and the existing JS command queue."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from tests.test_native_runtime import compile_fixture

ROOT = Path(__file__).resolve().parents[1]


class NativeGraphicsTests(unittest.TestCase):
    def test_native_state_staging(self):
        if not list((ROOT / 'var/toolchains').glob('wasi-sdk-*/bin/clang')) or not shutil.which('node'):
            self.skipTest('WASI SDK and Node required')
        with tempfile.TemporaryDirectory(prefix='wc3-native-graphics-') as directory:
            module = Path(directory) / 'graphics.wasm'
            compile_fixture(module)
            result = subprocess.run(['node', str(ROOT / 'tests/native_graphics_fixture.mjs'), str(module)],
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('Native graphics staging passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
