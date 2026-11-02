"""解析器测试：覆盖 10 种示例格式与若干边界情况。"""

from __future__ import annotations

import io
import os
import sys
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import geo  # noqa: E402
from app.parsers import ParseError, detect_format, parse_file  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(ROOT, "samples")

EXPECTED = {
    "百度地图轨迹示例.json": ("baidu", "BD09", 180),
    "高德地图轨迹示例.json": ("amap", "GCJ02", 180),
    "西湖环线_GPS.gpx": ("gpx", "WGS84", 180),
    "环湖骑行.kml": ("kml", "WGS84", 180),
    "晨跑记录.csv": ("csv", "WGS84", 180),
    "运动手表记录.tcx": ("tcx", "WGS84", 180),
    "Google时间线示例.json": ("google", "WGS84", 180),
    "骑行记录.fit": ("fit", "WGS84", 180),
    "轨迹记录.nmea": ("nmea", "WGS84", 180),
    "西湖环线.geojson": ("geojson", "WGS84", 180),
}


def load(name):
    with open(os.path.join(SAMPLES, name), "rb") as fh:
        return fh.read()


class TestSamples(unittest.TestCase):
    def test_all_samples_parse_and_align(self):
        bboxes = []
        for name, (fmt, crs_name, count) in EXPECTED.items():
            data = load(name)
            self.assertEqual(detect_format(data, name), fmt)
            parsed = parse_file(data, name, "auto")
            self.assertEqual(parsed.format, fmt)
            self.assertEqual(parsed.source_crs, crs_name)
            self.assertEqual(len(parsed.tracks), 1)
            track = parsed.tracks[0]
            self.assertEqual(len(track["points"]), count)
            stats = geo.compute_stats(track["points"], track["segments"])
            self.assertGreater(stats["distance_m"], 6000)
            self.assertLess(stats["distance_m"], 7500)
            bbox = geo.bbox(track["points"])
            bboxes.append(bbox)
        # 百度 BD-09、高德 GCJ-02 转换后应与 WGS-84 完全对齐（误差 < 1e-5 度）
        base = bboxes[0]
        for bbox in bboxes[1:]:
            for a, b in zip(base, bbox):
                self.assertAlmostEqual(a, b, places=5)

    def test_crs_override(self):
        data = load("百度地图轨迹示例.json")
        parsed = parse_file(data, "x.json", "WGS84")
        self.assertEqual(parsed.source_crs, "WGS84")
        self.assertFalse(parsed.crs_auto)
        self.assertEqual(len(parsed.tracks[0]["points"]), 180)


class TestInline(unittest.TestCase):
    def test_gpx_multiple_segments(self):
        gpx = b"""<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
 <trk><name>A</name>
  <trkseg>
   <trkpt lat="30.0" lon="120.0"><time>2024-06-01T00:00:00Z</time></trkpt>
   <trkpt lat="30.001" lon="120.001"><time>2024-06-01T00:00:10Z</time></trkpt>
  </trkseg>
  <trkseg>
   <trkpt lat="30.002" lon="120.002"><time>2024-06-01T00:10:00Z</time></trkpt>
  </trkseg>
 </trk>
</gpx>"""
        parsed = parse_file(gpx, "multi.gpx", "auto")
        track = parsed.tracks[0]
        self.assertEqual(len(track["points"]), 3)
        self.assertEqual(track["segments"], [0, 2])

    def test_kmz(self):
        kml = b"""<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>KMZ</name>
<LineString><coordinates>120.0,30.0,0 120.001,30.001,0</coordinates></LineString>
</Placemark></Document></kml>"""
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zf:
            zf.writestr("doc.kml", kml)
        parsed = parse_file(buffer.getvalue(), "test.kmz", "auto")
        self.assertEqual(parsed.format, "kml")
        self.assertEqual(len(parsed.tracks[0]["points"]), 2)

    def test_csv_header_and_no_header(self):
        csv_data = "时间,纬度,经度,海拔\n2024-06-01 08:00:00,30.0,120.0,10\n2024-06-01 08:00:10,30.001,120.001,11\n"
        parsed = parse_file(csv_data.encode("utf-8"), "cn.csv", "auto")
        self.assertEqual(len(parsed.tracks[0]["points"]), 2)
        self.assertIsNotNone(parsed.tracks[0]["points"][0][4])

        no_header = b"2024-06-01 08:00:00,30.0,120.0,10\n2024-06-01 08:00:10,30.001,120.001,11\n"
        parsed = parse_file(no_header, "noheader.csv", "auto")
        self.assertEqual(len(parsed.tracks[0]["points"]), 2)
        self.assertAlmostEqual(parsed.tracks[0]["points"][0][0], 120.0, places=6)

    def test_generic_json(self):
        payload = b'{"data":[{"lat":30.0,"lng":120.0,"time":1717200000},{"lat":30.001,"lng":120.001,"time":1717200010}]}'
        parsed = parse_file(payload, "generic.json", "auto")
        self.assertEqual(parsed.format, "json")
        self.assertEqual(len(parsed.tracks[0]["points"]), 2)

    def test_geojson_multiline(self):
        payload = (
            b'{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"x"},'
            b'"geometry":{"type":"MultiLineString","coordinates":[[[120.0,30.0],[120.001,30.001]],'
            b'[[120.002,30.002],[120.003,30.003]]]}}]}'
        )
        parsed = parse_file(payload, "multi.geojson", "auto")
        track = parsed.tracks[0]
        self.assertEqual(len(track["points"]), 4)
        self.assertEqual(track["segments"], [0, 2])

    def test_errors(self):
        with self.assertRaises(ParseError):
            parse_file(b"", "empty.gpx", "auto")
        with self.assertRaises(ParseError):
            parse_file(b"hello world", "a.txt", "auto")
        with self.assertRaises(ParseError):
            parse_file(b'{"foo": 1}', "a.json", "auto")


if __name__ == "__main__":
    unittest.main()
