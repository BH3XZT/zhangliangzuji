"""导出格式测试（含导出后再解析的往返校验）。"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import exporters, geo  # noqa: E402
from app.parsers import parse_file  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(ROOT, "samples")

BASE_TIME = 1717200000.0


def sample_track(multi_segment=False):
    points = [
        [120.0 + index * 0.001, 30.0, 10.0 + index, 1.4, BASE_TIME + index * 10]
        for index in range(10)
    ]
    segments = [0, 5] if multi_segment else [0]
    return [{"name": "测试轨迹", "points": points, "segments": segments}]


class TestExporters(unittest.TestCase):
    def test_roundtrip_all_formats_and_crs(self):
        tracks = sample_track(multi_segment=True)
        for fmt in ("gpx", "kml", "geojson", "csv", "json"):
            for crs_name in ("WGS84", "GCJ02", "BD09"):
                data, mime, filename = exporters.export_tracks(fmt, crs_name, tracks, "测试导出")
                self.assertGreater(len(data), 200)
                self.assertTrue(filename.endswith("." + ("geojson" if fmt == "geojson" else fmt)))
                self.assertTrue(mime)
                parsed = parse_file(data, filename, crs_name)
                total = sum(len(track["points"]) for track in parsed.tracks)
                self.assertEqual(total, 10, f"{fmt}/{crs_name} 点数")
                if crs_name == "WGS84":
                    bbox = geo.bbox(parsed.tracks[0]["points"])
                    self.assertAlmostEqual(bbox[0], 120.0, places=5)
                    self.assertAlmostEqual(bbox[1], 30.0, places=5)

    def test_csv_bom_and_header(self):
        data, _mime, _name = exporters.export_tracks("csv", "WGS84", sample_track(), "轨迹")
        self.assertTrue(data.startswith(b"\xef\xbb\xbf"))
        header = data.decode("utf-8-sig").splitlines()[0]
        self.assertIn("track", header)
        self.assertIn("lng", header)
        self.assertIn("time_iso", header)

    def test_kml_gx_track_and_multigeometry(self):
        data, _mime, _name = exporters.export_tracks("kml", "WGS84", sample_track(multi_segment=True), "轨迹")
        text = data.decode("utf-8")
        self.assertIn("<gx:Track>", text)
        self.assertIn("<MultiGeometry>", text)
        self.assertEqual(text.count("<gx:Track>"), 2)

    def test_geojson_multilinestring(self):
        data, _mime, _name = exporters.export_tracks("geojson", "WGS84", sample_track(multi_segment=True), "轨迹")
        payload = json.loads(data)
        feature = payload["features"][0]
        self.assertEqual(feature["geometry"]["type"], "MultiLineString")
        self.assertEqual(len(feature["geometry"]["coordinates"]), 2)
        self.assertEqual(payload["crs_note"], "WGS84")

    def test_filename_sanitize(self):
        _data, _mime, filename = exporters.export_tracks("gpx", "WGS84", sample_track(), 'a/b:c*?"<>|')
        self.assertNotRegex(filename, r'[<>:"/\\|?*]')
        self.assertTrue(filename.endswith(".gpx"))

    def test_invalid_format(self):
        with self.assertRaises(ValueError):
            exporters.export_tracks("exe", "WGS84", sample_track())
        with self.assertRaises(ValueError):
            exporters.export_tracks("gpx", "WGS84", [])

    def test_gpx_valid_xml(self):
        import xml.etree.ElementTree as ET

        data, _mime, _name = exporters.export_tracks("gpx", "WGS84", sample_track(multi_segment=True), "轨迹")
        root = ET.fromstring(data)
        self.assertTrue(root.tag.endswith("gpx"))
        segments = [element for element in root.iter() if element.tag.endswith("trkseg")]
        self.assertEqual(len(segments), 2)


if __name__ == "__main__":
    unittest.main()
