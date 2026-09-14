import http.client
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tests" / "legal"))
from test_web_asset_guard import fake_rom  # noqa: E402

SERVE = REPO / "packaging" / "web" / "serve.py"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ServeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.web, self.dev = root / "web", root / "dev"
        self.web.mkdir()
        self.dev.mkdir()
        (self.web / "index.html").write_text("<title>ok</title>")
        (self.dev / "game.gba").write_bytes(fake_rom())
        self.proc = None

    def tearDown(self):
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            self.proc.communicate(timeout=10)
        self.tmp.cleanup()

    def start(self, *extra):
        self.port = free_port()
        self.proc = subprocess.Popen([sys.executable, str(SERVE), str(self.web), str(self.port), *extra],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for _ in range(100):
            if self.proc.poll() is not None:
                return
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.1).close()
                return
            except OSError:
                time.sleep(0.05)

    def get(self, path, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", path, headers={"Host": host} if host else {})
        response = conn.getresponse()
        return response, response.read()

    def test_headers_and_dev_assets(self):
        self.start("--dev-assets", str(self.dev))
        response, _ = self.get("/")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Cross-Origin-Embedder-Policy"), "require-corp")
        self.assertEqual(response.getheader("Cross-Origin-Opener-Policy"), "same-origin")
        self.assertEqual(response.getheader("X-Robots-Tag"), "noindex, nofollow")
        response, body = self.get("/dev-assets/game.gba")
        self.assertEqual((response.status, body), (200, fake_rom()))
        self.assertEqual(self.get("/dev-assets/../../index.html")[0].status, 404)
        self.assertEqual(self.get("/dev-assets/game.gba", host=f"gbr.test:{self.port}")[0].status, 403)

    def test_no_dev_assets_by_default(self):
        self.start()
        self.assertEqual(self.get("/dev-assets/game.gba")[0].status, 404)

    def test_refuses_bundle_with_rom(self):
        (self.web / "game.gba").write_bytes(fake_rom())
        self.start()
        stdout, stderr = self.proc.communicate(timeout=10)
        self.assertEqual(self.proc.returncode, 1)
        self.assertIn("web_asset_guard", stdout + stderr)


if __name__ == "__main__":
    unittest.main()
