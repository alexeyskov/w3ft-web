import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGLISH = ROOT / "var/locales/en"


@unittest.skipUnless((ENGLISH / "war3.mpq").is_file(), "English localization is not prepared (make locale-en)")
class CyrillicFontTests(unittest.TestCase):
    def test_english_font_gains_cyrillic_and_keeps_latin(self):
        from io import BytesIO
        from fontTools.ttLib import TTFont
        from tools.prepare_fonts import CYRILLIC, MASTER, add_cyrillic, read

        original = read(ENGLISH, MASTER)
        data, count = add_cyrillic(original, read(ENGLISH, CYRILLIC))
        self.assertGreaterEqual(count, 66)  # А–я, Ё and ё at least
        before, after = TTFont(BytesIO(original)), TTFont(BytesIO(data))
        cmap = after.getBestCmap()
        for letter in "АБВЁЖЯабвёжяІЇЄҐіїєґ№":
            self.assertIn(ord(letter), cmap, letter)
        # Latin glyphs, metrics and the font's own name are unchanged.
        for letter in "AHWagz09!":
            name = before.getBestCmap()[ord(letter)]
            self.assertEqual(cmap[ord(letter)], name)
            self.assertEqual(after["glyf"][name].compile(after["glyf"]), before["glyf"][name].compile(before["glyf"]), letter)
            self.assertEqual(after["hmtx"][name], before["hmtx"][name])
        self.assertEqual(after["name"].getDebugName(4), before["name"].getDebugName(4))
        # Capital letters share one height: Cyrillic П matches Latin H.
        glyphs = after.getGlyphSet()

        def top(letter):
            from fontTools.pens.boundsPen import BoundsPen
            pen = BoundsPen(glyphs)
            glyphs[cmap[ord(letter)]].draw(pen)
            return pen.bounds[3]
        self.assertAlmostEqual(top("П"), top("H"), delta=2)
        # A second run finds the letters and changes nothing.
        self.assertEqual(add_cyrillic(data, read(ENGLISH, CYRILLIC))[1], 0)


if __name__ == "__main__":
    unittest.main()
