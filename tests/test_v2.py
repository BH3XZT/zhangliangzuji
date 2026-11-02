"""v2 功能测试：轨迹库、同步中心、里程碑。"""

from __future__ import annotations

import os
import shutil
import sys
import time
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import crs  # noqa: E402
from app.geo_admin import AdminGeo  # noqa: E402
from app.library import Library  # noqa: E402
from app.milestones import MilestoneService  # noqa: E402
from app.parsers import parse_file  # noqa: E402
from app.sync import SyncManager  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = ROOT / "data" / "_test"


def make_dir() -> Path:
    TEST_ROOT.mkdir(parents=True, exist_ok=True)
    path = TEST_ROOT / uuid.uuid4().hex
    path.mkdir()
    return path


def sample_gpx() -> bytes:
    return b"""<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>t</name><trkseg>
<trkpt lat="30.2500" lon="120.1500"><ele>10</ele><time>2024-06-01T00:00:00Z</time></trkpt>
<trkpt lat="30.2510" lon="120.1510"><ele>11</ele><time>2024-06-01T00:00:10Z</time></trkpt>
</trkseg></trk></gpx>"""


def track_points(points):
    return [
        {"name": name, "points": [[lng, lat, ele, None, ts] for lng, lat, ele, ts in items]}
        for name, items in points.items()
    ]


class TestLibrary(unittest.TestCase):
    def setUp(self):
        self.dir = make_dir()
        self.library = Library(self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_add_get_stats_dedupe(self):
        points = [[120.15 + i * 0.0001, 30.25, 10.0, None, 1717200000.0 + i * 5] for i in range(100)]
        summary, duplicate = self.library.add_track("A", points, [0], {"format": "gpx", "format_label": "GPX", "source_crs": "WGS84", "filename": "a.gpx"})
        self.assertFalse(duplicate)
        self.assertEqual(summary["point_count"], 100)
        self.assertGreater(summary["distance_m"], 0)
        again, duplicate2 = self.library.add_track("A-dup", points, [0], {})
        self.assertTrue(duplicate2)
        self.assertEqual(again["id"], summary["id"])
        self.assertEqual(len(self.library.list_tracks()), 1)
        detail = self.library.get_track(summary["id"])
        self.assertEqual(len(detail["points"]), 100)
        self.assertEqual(detail["segments"], [0])
        stats = self.library.stats()
        self.assertEqual(stats["track_count"], 1)
        self.assertEqual(stats["source_count"], 1)

    def test_persist_update_delete(self):
        points = [[120.0, 30.0, None, None, None], [120.001, 30.001, None, None, None]]
        summary, _ = self.library.add_track("原名", points)
        reloaded = Library(self.dir)
        self.assertEqual(len(reloaded.list_tracks()), 1)
        updated = reloaded.update_track(summary["id"], name="新名字", color="#ff0000")
        self.assertEqual(updated["name"], "新名字")
        self.assertEqual(updated["color"], "#ff0000")
        reloaded.delete_track(summary["id"])
        self.assertEqual(reloaded.stats()["track_count"], 0)
        with self.assertRaises(Exception):
            reloaded.get_track(summary["id"])

    def test_clear(self):
        self.library.add_track("a", [[120.0, 30.0, None, None, None]])
        self.library.add_track("b", [[120.1, 30.1, None, None, None]])
        self.assertEqual(len(self.library.list_tracks()), 2)
        self.assertEqual(self.library.clear(), 2)
        self.assertEqual(len(self.library.list_tracks()), 0)
        self.assertEqual(len(list(self.library.iter_tracks())), 0)

    def test_invalid_points(self):
        with self.assertRaises(Exception):
            self.library.add_track("bad", [])
        with self.assertRaises(Exception):
            self.library.add_track("bad", [[999, 999, None, None, None]])


class TestSync(unittest.TestCase):
    def setUp(self):
        self.dir = make_dir()
        self.library = Library(self.dir)
        self.sync = SyncManager(self.dir, self.library)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_token(self):
        token, expires = self.sync.new_token()
        self.assertTrue(self.sync.check_token(token))
        self.assertFalse(self.sync.check_token("bad"))
        self.assertGreater(expires, time.time())
        self.sync._tokens[token] = time.time() - 1
        self.assertFalse(self.sync.check_token(token))
        self.assertTrue(self.sync.mobile_path(token).startswith("/mobile.html?token="))

    def test_scan_import_duplicate_and_failed(self):
        gpx = sample_gpx()
        name = self.sync.save_upload("a.gpx", gpx)
        result = self.sync.scan(only_names=[name])
        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(self.library.list_tracks()), 1)
        self.assertEqual(len(self.sync.list_inbox()), 0)
        self.assertGreaterEqual(self.sync.status()["processed"], 1)

        name2 = self.sync.save_upload("a-copy.gpx", gpx)
        result2 = self.sync.scan(only_names=[name2])
        self.assertEqual(result2["imported"], 0)
        self.assertEqual(result2["duplicates"], 1)

        name3 = self.sync.save_upload("bad.xyz", b"not a track")
        result3 = self.sync.scan(only_names=[name3])
        self.assertEqual(len(result3["errors"]), 1)
        self.assertGreaterEqual(self.sync.status()["failed"], 1)

    def test_upload_and_scan(self):
        result = self.sync.upload_and_scan([{"filename": "mobile.gpx", "content": sample_gpx()}])
        self.assertEqual(result["imported"], 1)
        self.assertEqual(len(result["saved"]), 1)
        self.assertEqual(self.sync.status()["pending"], 0)

    def test_sample_formats(self):
        for filename in ("西湖环线_GPS.gpx", "百度地图轨迹示例.json", "高德地图轨迹示例.json", "环湖骑行.kml", "运动手表记录.tcx"):
            data = (ROOT / "samples" / filename).read_bytes()
            name = self.sync.save_upload(filename, data)
            result = self.sync.scan(only_names=[name])
            self.assertEqual(result["errors"], [], filename)
        # 示例基本都是同一条路线，按内容 hash 去重后只会入库少量（不同格式的速度/时间字段可能不同）
        self.assertGreaterEqual(len(self.library.list_tracks()), 1)
        self.assertLessEqual(len(self.library.list_tracks()), 5)


class TestMilestones(unittest.TestCase):
    def setUp(self):
        self.dir = make_dir()
        self.library = Library(self.dir)
        self.service = MilestoneService(ROOT / "geo", self.library)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_admin_geo_locate(self):
        geo = AdminGeo(ROOT / "geo")
        cases = [
            ("杭州", 120.15, 30.25, "浙江省", "杭州市", "西湖区"),
            ("北京", 116.397, 39.908, "北京市", "北京市", "东城区"),
            ("上海", 121.49, 31.24, "上海市", "上海市", "浦东新区"),
            ("广州", 113.26, 23.13, "广东省", "广州市", "越秀区"),
        ]
        for name, lng, lat, province, city, district in cases:
            gcj = crs.wgs84_to_gcj02(lng, lat)
            location = geo.locate(*gcj)
            self.assertIsNotNone(location, name)
            self.assertEqual(location["province"]["name"], province, name)
            self.assertEqual(location["city"]["name"], city, name)
            self.assertEqual(location["district"]["name"], district, name)
        outside = crs.wgs84_to_gcj02(139.69, 35.68)
        self.assertIsNone(geo.locate(*outside))

    def test_milestones_counts_and_geojson(self):
        self.library.add_track("杭州", [[120.15, 30.25, None, None, 1717200000.0]])
        self.library.add_track("北京", [[116.397, 39.908, None, None, 1717200000.0]])
        self.library.add_track("上海", [[121.49, 31.24, None, None, 1717200000.0]])
        payload = self.service.payload()
        counts = payload["counts"]
        self.assertEqual(counts["country"], {"visited": 1, "total": 1})
        self.assertEqual(counts["province"]["total"], 34)
        self.assertGreaterEqual(counts["province"]["visited"], 3)
        self.assertGreaterEqual(counts["city"]["visited"], 3)
        self.assertGreaterEqual(counts["district"]["visited"], 3)
        visited = {province["name"] for province in payload["provinces"] if province["visited"]}
        self.assertTrue({"浙江省", "北京市", "上海市"}.issubset(visited))
        geojson = self.service.geojson("WGS84")
        self.assertEqual(len(geojson["features"]), 34)
        self.assertEqual(sum(1 for f in geojson["features"] if f["properties"]["visited"]), len(visited))

    def test_cache_invalidates_after_add(self):
        self.library.add_track("杭州", [[120.15, 30.25, None, None, None]])
        first = self.service.payload()["counts"]["province"]["visited"]
        self.library.add_track("广州", [[113.26, 23.13, None, None, None]])
        second = self.service.payload()["counts"]["province"]["visited"]
        self.assertGreater(second, first)

    def test_sample_track_milestones(self):
        parsed = parse_file((ROOT / "samples" / "西湖环线_GPS.gpx").read_bytes(), "x.gpx", "auto")
        for track in parsed.tracks:
            self.library.add_track(track["name"], track["points"], track["segments"], {})
        payload = self.service.payload()
        self.assertEqual(payload["counts"]["province"]["visited"], 1)
        self.assertGreaterEqual(payload["counts"]["district"]["visited"], 1)
        self.assertLessEqual(payload["counts"]["district"]["visited"], 3)


if __name__ == "__main__":
    unittest.main()
