import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "packaging" / "web"))
import bundle_policy as policy  # noqa: E402

A40, B40 = "a" * 40, "b" * 40


class BundlePolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.project = self.root / "MyGame"
        self.project.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def game_toml(self, sha1=A40.upper()):
        (self.project / "game.toml").write_text(
            '[program]\nname = "Test Game #1"  # trailing comment\n'
            '[[extra_func]]\nname = "not the program name"\n'
            f'[identity]\nsha1 = "{sha1}"\n')

    def test_toml_string_sections(self):
        text = ('[program]\nname = "Game #1"  # c\n[[extra_func]]\nname = "nope"\n'
                '[identity]\nranges = [\n  [0x08000000, 0x08001000],\n]\nsha1 = "ABC"\n')
        self.assertEqual(policy.toml_string(text, "program", "name"), "Game #1")
        self.assertEqual(policy.toml_string(text, "identity", "sha1"), "ABC")
        self.assertIsNone(policy.toml_string(text, "identity", "md5"))
        self.assertIsNone(policy.toml_string(text, "extra_func", "addr"))

    def test_expected_from_game_toml(self):
        self.game_toml()
        assets = policy.expected_assets(self.project, None)
        self.assertEqual(assets["rom_sha1"], A40)
        self.assertEqual(assets["game_name"], "Test Game #1")
        self.assertRegex(assets["bios_sha1"], r"^[0-9a-f]{40}$")
        self.assertEqual(assets["bios_size"], 16384)
        self.assertEqual(assets["policy"], "visitor-supplied")

    def test_expected_needs_a_hash(self):
        with self.assertRaises(ValueError):
            policy.expected_assets(self.project, None)

    def test_override_must_match_config(self):
        self.game_toml()
        with self.assertRaises(ValueError):
            policy.expected_assets(self.project, B40)
        self.assertEqual(policy.expected_assets(self.project, A40)["rom_sha1"], A40)
        (self.project / "game.toml").unlink()
        assets = policy.expected_assets(self.project, B40)
        self.assertEqual((assets["rom_sha1"], assets["game_name"]), (B40, "MyGame"))

    def test_stale(self):
        out = self.root / "web"
        out.mkdir()
        self.assertEqual(policy.stale_assets(out), [])
        for name in ["game.gba", "gba_bios.bin", "rom_sha1.js", "other.gba", "game.wasm"]:
            (out / name).write_bytes(b"x")
        self.assertEqual(policy.stale_assets(out), ["game.gba", "gba_bios.bin", "other.gba", "rom_sha1.js"])

    def test_manifest(self):
        self.game_toml()
        out, bios_gen = self.root / "web", self.root / "bios_gen"
        out.mkdir()
        bios_gen.mkdir()
        (out / "index.html").write_text("<title>x</title>")
        assets = policy.expected_assets(self.project, None)
        policy.write_manifest(REPO, out, bios_gen, self.project, assets, emcc="emcc test")
        data = json.loads((out / "manifest.json").read_text())
        self.assertEqual(data["assets"], assets)
        self.assertEqual(data["distribution"], "private-test")
        self.assertEqual(sorted(data["files"]), ["index.html"])
        self.assertEqual(sorted(data["inputs"]), ["game.toml"])
        self.assertEqual(data["emcc"], "emcc test")

    def test_build_web_refuses_rom_and_bios_arguments(self):
        result = subprocess.run(
            ["bash", str(REPO / "packaging/web/build_web.sh"),
             "/nonexistent-project", "/nonexistent-bios", "game.gba", "gba_bios.bin"],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("never copied", result.stderr)


if __name__ == "__main__":
    unittest.main()
