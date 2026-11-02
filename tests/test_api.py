"""HTTP API 集成测试（在随机端口启动真实服务器）。"""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import geo  # noqa: E402
from app.parsers import parse_file  # noqa: E402
from app.server import Handler  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(ROOT, "samples")


def build_multipart(files, fields=None):
    boundary = "----TestBoundary7d91f2"
    buffer = io.BytesIO()
    for name, value in (fields or {}).items():
        buffer.write(f"--{boundary}\r\n".encode())
        buffer.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        buffer.write(str(value).encode("utf-8"))
        buffer.write(b"\r\n")
    for filename, content in files:
        buffer.write(f"--{boundary}\r\n".encode())
        buffer.write(
            f'Content-Disposition: form-data; name="files"; filename="{filename}"\r\n'.encode("utf-8")
        )
        buffer.write(b"Content-Type: application/octet-stream\r\n\r\n")
        buffer.write(content)
        buffer.write(b"\r\n")
    buffer.write(f"--{boundary}--\r\n".encode())
    return buffer.getvalue(), f"multipart/form-data; boundary={boundary}"


class TestApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def get(self, path):
        request = urllib.request.Request(self.base + path)
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.headers, response.read()

    def post_json(self, path, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.base + path, data=data, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, response.headers, response.read()

    def post_multipart(self, path, files, fields=None):
        body, content_type = build_multipart(files, fields)
        request = urllib.request.Request(
            self.base + path, data=body, headers={"Content-Type": content_type}
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, response.headers, response.read()

    def test_health_and_formats(self):
        status, headers, body = self.get("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("Content-Type", "").startswith("application/json"))
        payload = json.loads(body)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["name"], "MapTrackMerger")

        status, _headers, body = self.get("/api/formats")
        payload = json.loads(body)
        self.assertEqual(len(payload["crs"]), 3)
        self.assertGreaterEqual(len(payload["formats"]), 10)
        self.assertEqual(len(payload["export_formats"]), 5)

    def test_samples_and_static(self):
        status, _headers, body = self.get("/api/samples")
        payload = json.loads(body)
        self.assertGreaterEqual(len(payload["files"]), 8)
        self.assertTrue(all(item["url"].startswith("/samples/") for item in payload["files"]))

        status, headers, body = self.get("/static/crs.js")
        self.assertEqual(status, 200)
        self.assertIn("javascript", headers.get("Content-Type", ""))
        self.assertIn(b"window.CRS", body)

        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("Content-Type", ""))

    def test_parse_merge_export_flow(self):
        files = []
        for name in ("百度地图轨迹示例.json", "高德地图轨迹示例.json", "西湖环线_GPS.gpx"):
            with open(os.path.join(SAMPLES, name), "rb") as fh:
                files.append((name, fh.read()))
        status, _headers, body = self.post_multipart("/api/parse", files)
        parsed = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(len(parsed["tracks"]), 3)
        self.assertEqual([t["source_crs"] for t in parsed["tracks"]], ["BD09", "GCJ02", "WGS84"])
        for track in parsed["tracks"]:
            self.assertEqual(len(track["points"]), 180)
            self.assertEqual(len(track["points"][0]), 5)

        status, _headers, body = self.post_json(
            "/api/merge",
            {
                "tracks": [{"name": t["name"], "points": t["points"]} for t in parsed["tracks"]],
                "options": {"mode": "single", "dedupe_meters": 1, "gap_seconds": 600},
            },
        )
        merged = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(merged["stats"]["point_count"], 540)
        self.assertGreater(merged["stats"]["distance_m"], 19000)
        self.assertIn("time_start_iso", merged["stats"])

        track = merged["tracks"][0]
        for fmt in ("gpx", "kml", "geojson", "csv", "json"):
            status, headers, body = self.post_json(
                "/api/export",
                {
                    "format": fmt,
                    "crs": "GCJ02",
                    "filename": "合并轨迹",
                    "tracks": [{"name": track["name"], "points": track["points"], "segments": track["segments"]}],
                },
            )
            self.assertEqual(status, 200)
            self.assertIn("attachment", headers.get("Content-Disposition", ""))
            reparsed = parse_file(body, f"export.{fmt}", "GCJ02")
            self.assertEqual(sum(len(t["points"]) for t in reparsed.tracks), 540)

    def test_parse_crs_override(self):
        with open(os.path.join(SAMPLES, "百度地图轨迹示例.json"), "rb") as fh:
            content = fh.read()
        _status, _headers, body = self.post_multipart(
            "/api/parse", [("百度地图轨迹示例.json", content)], {"crs": "WGS84"}
        )
        payload = json.loads(body)
        self.assertEqual(payload["tracks"][0]["source_crs"], "WGS84")
        self.assertFalse(payload["tracks"][0]["crs_auto"])

    def test_guide_page(self):
        status, headers, body = self.get("/guide.html")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("Content-Type", ""))
        self.assertIn("轨迹导出操作指南", body.decode("utf-8"))
        status, _headers, body = self.get("/guide")
        self.assertEqual(status, 200)

    def test_bad_file_and_404(self):
        _status, _headers, body = self.post_multipart("/api/parse", [("bad.xyz", b"hello")])
        payload = json.loads(body)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["tracks"], [])
        self.assertEqual(len(payload["errors"]), 1)

        with self.assertRaises(urllib.error.HTTPError) as context:
            self.get("/api/not-exist")
        self.assertEqual(context.exception.code, 404)

        with self.assertRaises(urllib.error.HTTPError) as context:
            self.get("/static/../app/server.py")
        self.assertEqual(context.exception.code, 404)

    def test_export_unknown_format(self):
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.post_json("/api/export", {"format": "exe", "tracks": [{"points": [[120, 30, None, None, None]]}]})
        self.assertEqual(context.exception.code, 400)

    def test_merge_empty(self):
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.post_json("/api/merge", {"tracks": []})
        self.assertEqual(context.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
