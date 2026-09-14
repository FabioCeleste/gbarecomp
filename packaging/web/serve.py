#!/usr/bin/env python3
"""Serve a web build locally with the headers a PROXY_TO_PTHREAD build needs.

SharedArrayBuffer (pthreads) is only available to cross-origin-isolated pages,
so every response carries COOP/COEP. Caching is disabled so a rebuild is picked
up on reload. Pages are marked noindex: playable bundles are private (LEGAL.md).

The bundle is refused if it contains a ROM, a BIOS or generated code
(tools/web_asset_guard.py). For automated tests, --dev-assets DIR serves your own
local dumps as /dev-assets/<name>, to loopback clients only; they never become
part of the bundle.

Usage: python3 packaging/web/serve.py <web dir> [port] [--dev-assets DIR]
"""
import argparse
import functools
import http.server
import posixpath
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import web_asset_guard  # noqa: E402

LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
DEV_PREFIX = "/dev-assets/"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
    }

    def __init__(self, *args, dev_assets=None, **kwargs):
        self.dev_assets = dev_assets
        super().__init__(*args, **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        super().end_headers()

    def _host_is_loopback(self):
        host = urllib.parse.urlsplit("//" + (self.headers.get("Host") or "")).hostname or ""
        return host in LOOPBACK_HOSTS

    def do_GET(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path.startswith(DEV_PREFIX):
            name = path[len(DEV_PREFIX):]
            if not self.dev_assets or not name or name != posixpath.basename(name) or name in (".", ".."):
                self.send_error(404)
                return
            if not self._host_is_loopback():
                self.send_error(403, "dev assets are served to localhost only")
                return
            target = self.dev_assets / name
            if not target.is_file():
                self.send_error(404)
                return
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve a gbarecomp web bundle on 127.0.0.1")
    parser.add_argument("web_dir", type=Path)
    parser.add_argument("port", nargs="?", type=int, default=8080)
    parser.add_argument("--dev-assets", type=Path, metavar="DIR",
                        help="serve your own local dumps as /dev-assets/<name> (loopback only)")
    args = parser.parse_args()
    findings = web_asset_guard.scan_tree(args.web_dir, web_asset_guard.parse_bios_sha1())
    if findings:
        for finding in findings:
            print(finding, file=sys.stderr)
        print("web_asset_guard: refusing to serve a bundle that contains ROM/BIOS/generated code "
              "(move them to a --dev-assets dir; see docs/WEB_PRIVATE_TEST_HOSTING.md)", file=sys.stderr)
        return 1
    dev_assets = args.dev_assets.resolve() if args.dev_assets else None
    if dev_assets and not dev_assets.is_dir():
        print(f"error: --dev-assets is not a directory: {dev_assets}", file=sys.stderr)
        return 2
    handler = functools.partial(Handler, directory=str(args.web_dir), dev_assets=dev_assets)
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        extra = f" (dev assets from {dev_assets})" if dev_assets else ""
        print(f"serving {args.web_dir} on http://127.0.0.1:{args.port}/{extra}", flush=True)
        server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
