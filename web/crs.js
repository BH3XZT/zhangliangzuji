/*!
 * 坐标系转换 —— WGS-84 / GCJ-02 / BD-09
 * 与后端 Python 实现（app/crs.py）保持一致，供前端地图显示使用。
 * 暴露全局 window.CRS。
 */
(function (global) {
  "use strict";

  var PI = Math.PI;
  var A = 6378245.0;
  var EE = 0.00669342162296594323;
  var X_PI = (PI * 3000.0) / 180.0;

  var LABELS = {
    WGS84: "WGS-84（GPS / GPX / KML 标准坐标）",
    GCJ02: "GCJ-02（高德 / 腾讯 / Google 中国）",
    BD09: "BD-09（百度地图）"
  };

  function normalizeCrs(crs, fallback) {
    var value = String(crs == null ? "" : crs).trim().toUpperCase().replace(/\s+/g, "");
    var map = {
      WGS84: "WGS84", "WGS-84": "WGS84", WGS_84: "WGS84", WGS: "WGS84", GPS: "WGS84", "EPSG:4326": "WGS84",
      GCJ02: "GCJ02", "GCJ-02": "GCJ02", GCJ_02: "GCJ02", GCJ: "GCJ02", AMAP: "GCJ02",
      BD09: "BD09", "BD-09": "BD09", BD_09: "BD09", BD: "BD09", BAIDU: "BD09"
    };
    return map[value] || fallback || "WGS84";
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  function outOfChina(lng, lat) {
    if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) return true;
    return !(lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271);
  }

  function transformLat(x, y) {
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  function transformLng(x, y) {
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }

  function delta(lng, lat) {
    var dlat = transformLat(lng - 105.0, lat - 35.0);
    var dlng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = (lat / 180.0) * PI;
    var magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dlat = (dlat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
    dlng = (dlng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
    return [dlng, dlat];
  }

  function wgs84ToGcj02(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    var d = delta(lng, lat);
    return [lng + d[0], lat + d[1]];
  }

  function gcj02ToWgs84(lng, lat, iterations) {
    if (outOfChina(lng, lat)) return [lng, lat];
    var maxIterations = iterations || 8;
    var wlng = lng;
    var wlat = lat;
    for (var i = 0; i < maxIterations; i++) {
      var g = wgs84ToGcj02(wlng, wlat);
      var dlng = lng - g[0];
      var dlat = lat - g[1];
      wlng += dlng;
      wlat += dlat;
      if (Math.abs(dlng) < 1e-12 && Math.abs(dlat) < 1e-12) break;
    }
    return [wlng, wlat];
  }

  function bd09ToGcj02(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    var x = lng - 0.0065;
    var y = lat - 0.006;
    var z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
    var theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
    var glng = z * Math.cos(theta);
    var glat = z * Math.sin(theta);
    // 迭代逼近，与 gcj02ToBd09 严格互逆（与后端 app/crs.py 一致）
    for (var i = 0; i < 6; i++) {
      var b = gcj02ToBd09(glng, glat);
      var dlng = lng - b[0];
      var dlat = lat - b[1];
      glng += dlng;
      glat += dlat;
      if (Math.abs(dlng) < 1e-12 && Math.abs(dlat) < 1e-12) break;
    }
    return [glng, glat];
  }

  function gcj02ToBd09(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    var z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
    var theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
    return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006];
  }

  function wgs84ToBd09(lng, lat) {
    var g = wgs84ToGcj02(lng, lat);
    return gcj02ToBd09(g[0], g[1]);
  }

  function bd09ToWgs84(lng, lat) {
    var g = bd09ToGcj02(lng, lat);
    return gcj02ToWgs84(g[0], g[1]);
  }

  function fromWgs84(lng, lat, crs) {
    var target = normalizeCrs(crs, "WGS84");
    if (target === "GCJ02") return wgs84ToGcj02(lng, lat);
    if (target === "BD09") return wgs84ToBd09(lng, lat);
    return [lng, lat];
  }

  function toWgs84(lng, lat, crs) {
    var source = normalizeCrs(crs, "WGS84");
    if (source === "GCJ02") return gcj02ToWgs84(lng, lat);
    if (source === "BD09") return bd09ToWgs84(lng, lat);
    return [lng, lat];
  }

  /** 地图显示用：内部 WGS-84 → 当前底图坐标系 */
  function toDisplay(lng, lat, displayCrs) {
    return fromWgs84(lng, lat, displayCrs);
  }

  function fromDisplay(lng, lat, displayCrs) {
    return toWgs84(lng, lat, displayCrs);
  }

  /** 批量转换 [[lng, lat], ...] */
  function convertPoints(points, displayCrs) {
    var target = normalizeCrs(displayCrs, "WGS84");
    if (target === "WGS84") return points;
    var result = new Array(points.length);
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      result[i] = fromWgs84(p[0], p[1], target);
    }
    return result;
  }

  global.CRS = {
    LABELS: LABELS,
    normalizeCrs: normalizeCrs,
    outOfChina: outOfChina,
    wgs84ToGcj02: wgs84ToGcj02,
    gcj02ToWgs84: gcj02ToWgs84,
    gcj02ToBd09: gcj02ToBd09,
    bd09ToGcj02: bd09ToGcj02,
    wgs84ToBd09: wgs84ToBd09,
    bd09ToWgs84: bd09ToWgs84,
    toWgs84: toWgs84,
    fromWgs84: fromWgs84,
    toDisplay: toDisplay,
    fromDisplay: fromDisplay,
    convertPoints: convertPoints
  };
})(typeof window !== "undefined" ? window : globalThis);
