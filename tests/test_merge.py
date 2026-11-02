"""合并引擎测试。"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import merge  # noqa: E402

BASE_TIME = 1717200000.0


def make_track(name, points):
    return {"name": name, "points": points}


def line(lng0=120.0, lat0=30.0, count=5, step_lng=0.001, start=BASE_TIME, dt=10.0):
    return [
        [lng0 + index * step_lng, lat0, 10.0, None, start + index * dt]
        for index in range(count)
    ]


class TestMerge(unittest.TestCase):
    def test_single_merge_basic(self):
        tracks = [make_track("A", line()), make_track("B", line(lng0=120.01))]
        merged, stats = merge.merge_tracks(tracks, {"mode": "single", "join_tracks": False})
        self.assertEqual(len(merged), 1)
        self.assertEqual(stats["point_count"], 10)
        self.assertEqual(stats["segment_count"], 2)
        self.assertEqual(len(merged[0]["segments"]), 2)
        self.assertGreater(stats["distance_m"], 300)

    def test_join_tracks_when_time_continuous(self):
        first = line()
        second = [
            [120.005 + index * 0.001, 30.0, 10.0, None, BASE_TIME + 40 + index * 10]
            for index in range(5)
        ]
        merged, stats = merge.merge_tracks(
            [make_track("A", first), make_track("B", second)],
            {"mode": "single", "join_tracks": True, "gap_seconds": 600},
        )
        self.assertEqual(stats["segment_count"], 1)

    def test_gap_creates_segments(self):
        points = line()
        for point in points[3:]:
            point[4] += 3600  # 1 小时空档
        merged, stats = merge.merge_tracks([make_track("A", points)], {"mode": "single", "gap_seconds": 600})
        self.assertEqual(stats["segment_count"], 2)
        self.assertEqual(merged[0]["segments"], [0, 3])

    def test_dedupe(self):
        points = line(count=6)
        points.insert(2, list(points[1]))
        merged, stats = merge.merge_tracks([make_track("A", points)], {"mode": "single", "dedupe_meters": 1})
        self.assertEqual(stats["point_count"], 6)

    def test_simplify(self):
        points = line(count=100, step_lng=0.0001)
        merged, stats = merge.merge_tracks([make_track("A", points)], {"mode": "single", "simplify_meters": 1})
        self.assertLess(stats["point_count"], 10)
        self.assertGreaterEqual(stats["point_count"], 2)

    def test_speed_filter(self):
        points = line(count=5)
        points[2] = [120.05, 30.0, 10.0, None, points[2][4]]  # 10 秒瞬移约 5 公里
        merged, stats = merge.merge_tracks(
            [make_track("A", points)], {"mode": "single", "max_speed_kmh": 120}
        )
        self.assertLess(stats["point_count"], 5)

    def test_sort_by_time(self):
        late = line(start=BASE_TIME + 3600)
        early = line(lng0=121.0, start=BASE_TIME)
        merged, _stats = merge.merge_tracks(
            [make_track("late", late), make_track("early", early)],
            {"mode": "single", "sort_by_time": True, "join_tracks": False},
        )
        points = merged[0]["points"]
        times = [point[4] for point in points]
        self.assertEqual(times, sorted(times))
        self.assertAlmostEqual(points[0][0], 121.0, places=6)

    def test_separate_mode(self):
        tracks = [make_track("A", line()), make_track("B", line(lng0=121.0))]
        merged, stats = merge.merge_tracks(tracks, {"mode": "separate"})
        self.assertEqual(len(merged), 2)
        self.assertEqual(stats["track_count"], 2)
        self.assertEqual(stats["point_count"], 10)
        self.assertEqual([track["name"] for track in merged], ["A", "B"])

    def test_stats(self):
        merged, stats = merge.merge_tracks([make_track("A", line(count=2, step_lng=0.001))], {"mode": "single"})
        # 0.001 度经度在 30°N 约 96.5 米
        self.assertAlmostEqual(stats["distance_m"], 96.5, delta=2.0)
        self.assertAlmostEqual(stats["duration_s"], 10.0)
        self.assertAlmostEqual(stats["avg_speed_kmh"], 96.5 / 10.0 * 3.6, delta=1.0)

    def test_empty_raises(self):
        with self.assertRaises(ValueError):
            merge.merge_tracks([], {})


if __name__ == "__main__":
    unittest.main()
