"""坐标系转换测试。"""

from __future__ import annotations

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import crs  # noqa: E402


class TestCrs(unittest.TestCase):
    def test_roundtrip_china(self):
        points = [(120.15, 30.25), (116.397, 39.908), (121.47, 31.23), (113.26, 23.13), (87.62, 43.79)]
        for lng, lat in points:
            gcj = crs.wgs84_to_gcj02(lng, lat)
            back = crs.gcj02_to_wgs84(*gcj)
            self.assertAlmostEqual(back[0], lng, places=9)
            self.assertAlmostEqual(back[1], lat, places=9)
            bd = crs.wgs84_to_bd09(lng, lat)
            back_bd = crs.bd09_to_wgs84(*bd)
            self.assertAlmostEqual(back_bd[0], lng, places=6)
            self.assertAlmostEqual(back_bd[1], lat, places=6)

    def test_offsets_are_reasonable(self):
        lng, lat = 120.15, 30.25
        gcj = crs.wgs84_to_gcj02(lng, lat)
        offset = math.hypot(gcj[0] - lng, gcj[1] - lat)
        self.assertGreater(offset, 0.0005)
        self.assertLess(offset, 0.01)
        bd = crs.wgs84_to_bd09(lng, lat)
        bd_offset = math.hypot(bd[0] - gcj[0], bd[1] - gcj[1])
        self.assertGreater(bd_offset, 0.001)
        self.assertLess(bd_offset, 0.02)

    def test_out_of_china_unchanged(self):
        for lng, lat in [(0.0, 0.0), (-74.0, 40.7), (139.69, 35.68), (-0.13, 51.5)]:
            self.assertEqual(crs.wgs84_to_gcj02(lng, lat), (lng, lat))
            self.assertEqual(crs.wgs84_to_bd09(lng, lat), (lng, lat))
            self.assertEqual(crs.gcj02_to_wgs84(lng, lat), (lng, lat))

    def test_normalize_crs(self):
        self.assertEqual(crs.normalize_crs("wgs84"), "WGS84")
        self.assertEqual(crs.normalize_crs("GCJ-02"), "GCJ02")
        self.assertEqual(crs.normalize_crs("bd09"), "BD09")
        self.assertEqual(crs.normalize_crs("高德"), "GCJ02")
        self.assertEqual(crs.normalize_crs("百度"), "BD09")
        self.assertEqual(crs.normalize_crs("未知"), "WGS84")
        self.assertEqual(crs.normalize_crs(None), "WGS84")

    def test_generic_convert(self):
        point = [120.15, 30.25, 10.0, 1.5, 1717200000.0]
        converted = crs.convert_point_to_wgs84(point, "GCJ02")
        self.assertNotEqual(converted[0], point[0])
        self.assertEqual(converted[2:], point[2:])
        restored = crs.convert_point_from_wgs84(converted, "GCJ02")
        self.assertAlmostEqual(restored[0], point[0], places=8)
        self.assertAlmostEqual(restored[1], point[1], places=8)


if __name__ == "__main__":
    unittest.main()
