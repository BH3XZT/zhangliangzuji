/* ============================================================
   城市自驾等时圈地图 — 前端逻辑
   - MapLibre GL JS（本地文件，无商业 Token）
   - OpenStreetMap raster 底图
   - 后端统一 GeoJSON：properties.layer = isochrone / water / city
   ============================================================ */

(function () {
  "use strict";

  var DEFAULT_CENTER = { lat: 37.8706, lon: 112.5489 };
  var MINUTES = [60, 120, 180, 240];
  var COLORS = {
    60: "#0b3d91",
    120: "#1d4ed8",
    180: "#3b82f6",
    240: "#7dd3fc"
  };
  var EMPTY_FC = { type: "FeatureCollection", features: [] };
  var debugErrors = [];

  var state = {
    lat: DEFAULT_CENTER.lat,
    lon: DEFAULT_CENTER.lon,
    map: null,
    startMarker: null,
    cityMarkers: [],
    cityFeatures: [],
    requestId: 0,
    busy: false
  };

  /* ------------------------- DOM 快捷方法 ------------------------- */

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text, mode) {
    var status = $("status");
    var statusText = $("statusText");
    if (!status || !statusText) return;
    statusText.textContent = text;
    status.classList.toggle("is-busy", mode === "busy");
    status.classList.toggle("is-error", mode === "error");
  }

  function showLoading(show) {
    var loading = $("loading");
    if (!loading) return;
    loading.hidden = !show;
  }

  function showError(message) {
    var toast = $("errorToast");
    var text = $("errorText");
    if (!toast || !text) return;
    text.textContent = message || "未知错误";
    toast.hidden = false;
  }

  function hideError() {
    var toast = $("errorToast");
    if (toast) toast.hidden = true;
  }

  /* ------------------------- 地图初始化 ------------------------- */

  function initMap() {
    var style = {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          maxzoom: 19,
          attribution: "© OpenStreetMap contributors"
        }
      },
      layers: [
        {
          id: "osm",
          type: "raster",
          source: "osm",
          minzoom: 0,
          maxzoom: 22
        }
      ]
    };

    var map = new maplibregl.Map({
      container: "map",
      style: style,
      center: [DEFAULT_CENTER.lon, DEFAULT_CENTER.lat],
      zoom: 7,
      minZoom: 3,
      maxZoom: 16,
      attributionControl: true
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 120 }), "bottom-right");

    map.on("load", function () {
      addSourcesAndLayers();
      drawStartMarker();
      setStatus("正在计算自驾等时圈…", "busy");
      fetchIsochrone(state.lat, state.lon);
    });

    map.on("click", function (event) {
      // 点击地图任意位置更换出发点
      var lngLat = event.lngLat;
      state.lat = lngLat.lat;
      state.lon = lngLat.lng;
      drawStartMarker();
      fetchIsochrone(state.lat, state.lon);
    });

    map.on("zoomend", function () {
      if (state.cityFeatures.length) {
        drawCityLabels(state.cityFeatures);
      }
    });

    map.on("error", function (event) {
      var message = event && event.error ? (event.error.message || String(event.error)) : "unknown map error";
      debugErrors.push(message);
    });

    state.map = map;
    // 便于调试（也可在浏览器控制台查看图层状态）
    window.__iso = state;
  }

  function addSourcesAndLayers() {
    var map = state.map;
    if (!map || map.getSource("isochrone")) return;

    map.addSource("isochrone", { type: "geojson", data: EMPTY_FC });
    map.addSource("water", { type: "geojson", data: EMPTY_FC });

    // 由大到小添加填充层，保证 60 分钟深色区域绘制在最上面
    MINUTES.slice().sort(function (a, b) { return b - a; }).forEach(function (minutes) {
      map.addLayer({
        id: "iso-fill-" + minutes,
        type: "fill",
        source: "isochrone",
        filter: ["==", ["get", "minutes"], minutes],
        paint: {
          "fill-color": COLORS[minutes],
          "fill-opacity": 0.24
        }
      });
    });

    // 水系线条（深蓝色）
    map.addLayer({
      id: "water-line",
      type: "line",
      source: "water",
      layout: {
        "line-cap": "round",
        "line-join": "round"
      },
      paint: {
        "line-color": "#1e3a8a",
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.8, 9, 1.6, 12, 2.4],
        "line-opacity": 0.72
      }
    });

    // 等时圈轮廓
    MINUTES.forEach(function (minutes) {
      map.addLayer({
        id: "iso-line-" + minutes,
        type: "line",
        source: "isochrone",
        filter: ["==", ["get", "minutes"], minutes],
        paint: {
          "line-color": COLORS[minutes],
          "line-width": minutes === 60 ? 2.0 : 1.5,
          "line-opacity": 0.9
        }
      });
    });
  }

  /* ------------------------- 请求后端 ------------------------- */

  function fetchIsochrone(lat, lon) {
    if (state.busy) {
      // 快速点击时取消上一次的显示结果，但仍允许最新请求继续
    }
    state.busy = true;
    var requestId = ++state.requestId;
    showLoading(true);
    hideError();
    setStatus("正在计算自驾等时圈…", "busy");

    fetch("/api/isochrone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: lat, lon: lon, minutes: MINUTES })
    })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) {
            var message = data && data.detail ? data.detail : "HTTP " + response.status;
            throw new Error(message);
          }
          return data;
        });
      })
      .then(function (data) {
        if (requestId !== state.requestId) return;
        applyData(data);
        setStatus("等时圈已生成 · 水系 " + (data.meta ? data.meta.water_count : 0) + " 条 · 城市 " + (data.meta ? data.meta.city_count : 0) + " 个", "ok");
        showLoading(false);
        state.busy = false;
      })
      .catch(function (error) {
        if (requestId !== state.requestId) return;
        state.busy = false;
        showLoading(false);
        setStatus("计算失败", "error");
        showError(error && error.message ? error.message : "请求失败，请检查后端与 Valhalla 日志");
      });
  }

  function applyData(data) {
    var map = state.map;
    if (!map) return;
    var features = Array.isArray(data.features) ? data.features : [];
    var isoFeatures = features.filter(function (f) {
      return f && f.properties && f.properties.layer === "isochrone";
    });
    var waterFeatures = features.filter(function (f) {
      return f && f.properties && f.properties.layer === "water";
    });
    var cityFeatures = features.filter(function (f) {
      return f && f.properties && f.properties.layer === "city";
    });

    var isoSource = map.getSource("isochrone");
    var waterSource = map.getSource("water");
    if (isoSource) isoSource.setData({ type: "FeatureCollection", features: isoFeatures });
    if (waterSource) waterSource.setData({ type: "FeatureCollection", features: waterFeatures });

    state.cityFeatures = cityFeatures;
    drawCityLabels(cityFeatures);

    var meta = data.meta || {};
    var metaCard = $("metaCard");
    if (metaCard) metaCard.hidden = false;
    var metaIso = $("metaIso");
    var metaWater = $("metaWater");
    var metaCity = $("metaCity");
    if (metaIso) metaIso.textContent = isoFeatures.length + " 层";
    if (metaWater) metaWater.textContent = waterFeatures.length + " 条";
    if (metaCity) metaCity.textContent = cityFeatures.length + " 个";

    if (meta.bbox && meta.bbox.length === 4) {
      var isMobile = window.innerWidth < 720;
      var padding = isMobile
        ? { top: 96, bottom: 120, left: 16, right: 16 }
        : { top: 120, bottom: 90, left: 260, right: 90 };
      map.fitBounds(
        [[meta.bbox[0], meta.bbox[1]], [meta.bbox[2], meta.bbox[3]]],
        { padding: padding, maxZoom: isMobile ? 9 : 10, duration: 650 }
      );
    }

    // 调试信息写入隐藏节点，方便无头浏览器检查图层是否真的渲染
    map.once("idle", function () {
      try {
        var layers = map.getStyle().layers.map(function (layer) {
          return { id: layer.id, type: layer.type, filter: layer.filter || null };
        });
        var point = map.project([state.lon, state.lat]);
        var rendered = {};
        ["iso-fill-60", "iso-fill-120", "iso-fill-180", "iso-fill-240"].forEach(function (id) {
          try {
            rendered[id] = map.queryRenderedFeatures(point, { layers: [id] }).length;
          } catch (err) {
            rendered[id] = "ERR: " + String(err);
          }
        });
        var debug = {
          zoom: map.getZoom(),
          center: map.getCenter(),
          layers: layers,
          iso_features: isoFeatures.length,
          water_features: waterFeatures.length,
          city_features: cityFeatures.length,
          rendered_at_start: rendered,
          errors: debugErrors.slice(-6)
        };
        var node = $("debug");
        if (node) node.textContent = JSON.stringify(debug, null, 2);
      } catch (err) {
        var node2 = $("debug");
        if (node2) node2.textContent = "DEBUG_ERROR: " + String(err);
      }
    });
  }

  /* ------------------------- 城市标注 ------------------------- */

  function drawCityLabels(features) {
    var map = state.map;
    state.cityMarkers.forEach(function (marker) { marker.remove(); });
    state.cityMarkers = [];

    var zoom = map.getZoom();
    var list = features;
    if (zoom < 7.5) {
      // 低缩放级别只显示“市”，避免县城/乡镇把地图挤满
      list = features.filter(function (feature) {
        return feature.properties && feature.properties.place === "city";
      });
    }
    var limit = zoom < 7.5 ? 45 : 140;
    list = list.slice(0, limit);

    list.forEach(function (feature) {
      var geometry = feature.geometry || {};
      if (geometry.type !== "Point") return;
      var coords = geometry.coordinates || [];
      if (coords.length < 2) return;
      var props = feature.properties || {};
      var name = props.name || "";
      if (!name) return;

      var element = document.createElement("div");
      element.className = "city-label" + (props.place === "town" ? " is-town" : "");
      element.textContent = name;
      var marker = new maplibregl.Marker({ element: element, anchor: "bottom" })
        .setLngLat([coords[0], coords[1]])
        .addTo(map);
      state.cityMarkers.push(marker);
    });
  }

  /* ------------------------- 起点标记 ------------------------- */

  function drawStartMarker() {
    var map = state.map;
    if (!map) return;
    if (state.startMarker) {
      state.startMarker.remove();
      state.startMarker = null;
    }
    var wrap = document.createElement("div");
    wrap.className = "start-wrap";
    wrap.title = "出发点";
    var pulse = document.createElement("span");
    pulse.className = "pulse";
    var dot = document.createElement("span");
    dot.className = "dot";
    wrap.appendChild(pulse);
    wrap.appendChild(dot);
    wrap.addEventListener("click", function (event) {
      event.stopPropagation();
    });

    state.startMarker = new maplibregl.Marker({ element: wrap, anchor: "center" })
      .setLngLat([state.lon, state.lat])
      .addTo(map);
  }

  /* ------------------------- 图例 / 按钮 ------------------------- */

  function buildLegend() {
    var list = $("legendList");
    if (!list) return;
    MINUTES.forEach(function (minutes) {
      var item = document.createElement("li");
      var swatch = document.createElement("i");
      swatch.className = "swatch";
      swatch.style.background = COLORS[minutes];
      if (minutes === 60) swatch.style.opacity = "0.9";
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(minutes + " 分钟"));
      list.appendChild(item);
    });
  }

  function bindButtons() {
    var refresh = $("btnRefresh");
    if (refresh) {
      refresh.addEventListener("click", function () {
        fetchIsochrone(state.lat, state.lon);
      });
    }
    var reset = $("btnReset");
    if (reset) {
      reset.addEventListener("click", function () {
        state.lat = DEFAULT_CENTER.lat;
        state.lon = DEFAULT_CENTER.lon;
        drawStartMarker();
        fetchIsochrone(state.lat, state.lon);
      });
    }
    var retry = $("btnRetry");
    if (retry) {
      retry.addEventListener("click", function () {
        hideError();
        fetchIsochrone(state.lat, state.lon);
      });
    }
  }

  /* ------------------------- 启动 ------------------------- */

  function boot() {
    if (typeof maplibregl === "undefined") {
      setStatus("地图库加载失败", "error");
      showError("MapLibre GL JS 未加载，请检查 /vendor/maplibre-gl.js 是否存在");
      return;
    }
    if (new URLSearchParams(window.location.search).has("debug")) {
      document.body.classList.add("debug");
    }
    buildLegend();
    bindButtons();
    initMap();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
