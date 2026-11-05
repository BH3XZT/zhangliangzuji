/* 在轨迹总览地图（overviewMap）上叠加等时圈，不再使用独立的等时圈地图页。 */
(function () {
  "use strict";

  var DEFAULT_CENTER = { lat: 37.8706, lon: 112.5489 };
  var MINUTES = [60, 120, 180, 240];
  var COLORS = { 60: "#0b3d91", 120: "#1d4ed8", 180: "#3b82f6", 240: "#7dd3fc" };
  var MODE_LABELS = { car: "汽车", motorcycle: "摩托车", bike: "自行车", walk: "步行" };
  var ROAD_LABELS = { highway: "高速优先", national: "国道/主干优先", balanced: "均衡", avoid_highway: "避开高速" };

  var state = {
    open: false,
    busy: false,
    requestId: 0,
    lat: DEFAULT_CENTER.lat,
    lon: DEFAULT_CENTER.lon,
    mode: "car",
    roadPref: "balanced",
    avoidTolls: false,
    avoidFerries: false,
    avoidUnpaved: false,
    displayMode: "all",
    isoLayers: [],
    waterLayer: null,
    cityLayer: null,
    startMarker: null,
    cityFeatures: [],
    raw: null,
    map: null,
    clickBound: false
  };

  function $(id) { return document.getElementById(id); }

  function mapApi() {
    return window.__maptrack || null;
  }

  function getMap() {
    var api = mapApi();
    return api && api.overviewMap ? api.overviewMap : null;
  }

  function getCrs() {
    var api = mapApi();
    return api && api.displayCrs ? api.displayCrs : "WGS84";
  }

  function toDisplay(lon, lat) {
    var api = mapApi();
    if (!api || typeof api.wgsToDisplay !== "function") return [lon, lat];
    return api.wgsToDisplay(lon, lat, getCrs());
  }

  function toWgs(lon, lat) {
    var api = mapApi();
    if (!api || typeof api.displayToWgs !== "function") return [lon, lat];
    return api.displayToWgs(lon, lat, getCrs());
  }

  function setStatus(text, mode) {
    var node = $("isoStatus");
    if (!node) return;
    node.textContent = text;
    node.classList.toggle("is-busy", mode === "busy");
    node.classList.toggle("is-error", mode === "error");
  }

  function readSettings() {
    var display = document.querySelector('input[name="ovDisplayMode"]:checked');
    var mode = document.querySelector('input[name="ovTravelMode"]:checked');
    var road = $("ovRoadPref");
    if (display) state.displayMode = display.value;
    if (mode) state.mode = mode.value;
    if (road) state.roadPref = road.value;
    state.avoidTolls = !!($("ovAvoidTolls") && $("ovAvoidTolls").checked);
    state.avoidFerries = !!($("ovAvoidFerries") && $("ovAvoidFerries").checked);
    state.avoidUnpaved = !!($("ovAvoidUnpaved") && $("ovAvoidUnpaved").checked);
  }

  function motorized() {
    return state.mode === "car" || state.mode === "motorcycle";
  }

  function updateSettingsUi() {
    var isMotor = motorized();
    var road = $("ovRoadPref");
    var tolls = $("ovAvoidTolls");
    var unpaved = $("ovAvoidUnpaved");
    if (road) road.disabled = !isMotor;
    if (tolls) tolls.disabled = !isMotor;
    if (unpaved) unpaved.disabled = !isMotor;
    var hint = $("ovRoadHint");
    if (hint) {
      hint.textContent = isMotor
        ? "Valhalla 无国道独立分类，国道/主干优先用高速与主干路权重近似。"
        : "步行 / 自行车不使用道路偏好、收费和非铺装选项。";
    }
    var badgeTitle = $("isoBadgeTitle");
    var badgeSub = $("isoBadgeSub");
    if (badgeTitle && badgeSub) {
      if (state.mode === "walk") {
        badgeTitle.textContent = "4h 步行范围";
        badgeSub.textContent = "轻松可达";
      } else if (state.mode === "bike") {
        badgeTitle.textContent = "4h 骑行范围";
        badgeSub.textContent = "量力而行";
      } else {
        badgeTitle.textContent = "4h 内可达";
        badgeSub.textContent = "建议过夜";
      }
    }
  }

  function convertGeometry(geometry) {
    if (!geometry || !geometry.coordinates) return geometry;
    var g = { type: geometry.type, coordinates: convertCoords(geometry.coordinates) };
    if (geometry.type === "GeometryCollection" && geometry.geometries) {
      g = { type: "GeometryCollection", geometries: geometry.geometries.map(convertGeometry) };
    }
    return g;
  }

  function convertCoords(coords) {
    if (!Array.isArray(coords)) return coords;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      var p = toDisplay(coords[0], coords[1]);
      return [p[0], p[1]];
    }
    return coords.map(convertCoords);
  }

  function convertFeature(feature) {
    return {
      type: "Feature",
      properties: feature.properties || {},
      geometry: convertGeometry(feature.geometry)
    };
  }

  function clearLayers() {
    var map = getMap();
    if (!map) return;
    state.isoLayers.forEach(function (layer) { if (map.hasLayer(layer)) map.removeLayer(layer); });
    state.isoLayers = [];
    if (state.waterLayer) {
      if (map.hasLayer(state.waterLayer)) map.removeLayer(state.waterLayer);
      state.waterLayer = null;
    }
    if (state.cityLayer) {
      if (map.hasLayer(state.cityLayer)) map.removeLayer(state.cityLayer);
      state.cityLayer = null;
    }
    if (state.startMarker) {
      if (map.hasLayer(state.startMarker)) map.removeLayer(state.startMarker);
      state.startMarker = null;
    }
  }

  function setLayerVisible(layer, visible) {
    var map = getMap();
    if (!map || !layer) return;
    if (visible) {
      if (!map.hasLayer(layer)) map.addLayer(layer);
    } else if (map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
  }

  function applyDisplayMode() {
    var showIso = state.displayMode !== "origin";
    var showOrigin = state.displayMode !== "destination";
    state.isoLayers.forEach(function (layer) { setLayerVisible(layer, showIso); });
    setLayerVisible(state.waterLayer, showIso);
    setLayerVisible(state.cityLayer, showIso);
    setLayerVisible(state.startMarker, showOrigin);
  }

  function drawStartMarker() {
    var map = getMap();
    if (!map) return;
    if (state.startMarker) map.removeLayer(state.startMarker);
    var icon = L.divIcon({
      className: "",
      html: '<div class="ov-start-wrap"><span class="pulse"></span><span class="dot"></span></div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
    var p = toDisplay(state.lon, state.lat);
    state.startMarker = L.marker([p[1], p[0]], {
      icon: icon,
      interactive: false,
      keyboard: false
    }).addTo(map);
  }

  function drawIsochrone(features) {
    var map = getMap();
    if (!map) return;
    var byMinutes = {};
    features.forEach(function (feature) {
      var minutes = Number(feature.properties && feature.properties.minutes);
      if (!COLORS[minutes]) return;
      (byMinutes[minutes] = byMinutes[minutes] || []).push(convertFeature(feature));
    });
    MINUTES.slice().sort(function (a, b) { return b - a; }).forEach(function (minutes) {
      var list = byMinutes[minutes];
      if (!list || !list.length) return;
      var layer = L.geoJSON(
        { type: "FeatureCollection", features: list },
        {
          style: {
            color: COLORS[minutes],
            weight: minutes === 60 ? 2.2 : 1.6,
            opacity: 0.92,
            fillColor: COLORS[minutes],
            fillOpacity: 0.23
          }
        }
      ).addTo(map);
      state.isoLayers.push(layer);
    });
  }

  function drawWater(features) {
    var map = getMap();
    if (!map || !features.length) return;
    state.waterLayer = L.geoJSON(
      { type: "FeatureCollection", features: features.map(convertFeature) },
      { style: { color: "#1e3a8a", weight: 1.25, opacity: 0.7 } }
    ).addTo(map);
  }

  function drawCities(features) {
    var map = getMap();
    if (!map) return;
    if (state.cityLayer) {
      if (map.hasLayer(state.cityLayer)) map.removeLayer(state.cityLayer);
      state.cityLayer = null;
    }
    state.cityFeatures = features;
    var zoom = map.getZoom();
    var list = features;
    if (zoom < 7.5) {
      list = features.filter(function (f) { return f.properties && f.properties.place === "city"; });
    }
    list = list.slice(0, zoom < 7.5 ? 50 : 160);
    var markers = [];
    list.forEach(function (feature) {
      var geometry = feature.geometry || {};
      if (geometry.type !== "Point") return;
      var coords = geometry.coordinates || [];
      if (coords.length < 2) return;
      var props = feature.properties || {};
      if (!props.name) return;
      var p = toDisplay(coords[0], coords[1]);
      var icon = L.divIcon({
        className: "",
        html: '<span class="ov-city-label' + (props.place === "town" ? " is-town" : "") + '">' +
          String(props.name).replace(/[&<>"']/g, function (ch) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
          }) + "</span>",
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      });
      markers.push(L.marker([p[1], p[0]], { icon: icon, interactive: false, keyboard: false }));
    });
    state.cityLayer = L.layerGroup(markers).addTo(map);
  }

  function render(data, fit) {
    var map = getMap();
    if (!map) return;
    state.raw = data;
    clearLayers();
    var features = Array.isArray(data.features) ? data.features : [];
    var iso = features.filter(function (f) { return f.properties && f.properties.layer === "isochrone"; });
    var water = features.filter(function (f) { return f.properties && f.properties.layer === "water"; });
    var cities = features.filter(function (f) { return f.properties && f.properties.layer === "city"; });
    drawIsochrone(iso);
    drawWater(water);
    drawCities(cities);
    drawStartMarker();
    applyDisplayMode();

    if (fit && data.meta && data.meta.bbox && data.meta.bbox.length === 4) {
      var a = toDisplay(data.meta.bbox[0], data.meta.bbox[1]);
      var b = toDisplay(data.meta.bbox[2], data.meta.bbox[3]);
      var bounds = L.latLngBounds([a[1], a[0]], [b[1], b[0]]);
      map.fitBounds(bounds, { padding: [56, 56], maxZoom: 10, animate: true });
    }
    var meta = data.meta || {};
    setStatus(
      (meta.mode_label || MODE_LABELS[state.mode]) +
        (motorized() ? " · " + (ROAD_LABELS[state.roadPref] || "") : "") +
        " · 水系 " + (meta.water_count || 0) + " 条 · 城市 " + (meta.city_count || 0) + " 个",
      "ok"
    );
    var badge = $("isoBadge");
    if (badge) badge.hidden = false;
    updateSettingsUi();
  }

  function fetchIsochrone(fit) {
    var map = getMap();
    if (!map) return;
    readSettings();
    updateSettingsUi();
    state.busy = true;
    var requestId = ++state.requestId;
    setStatus("正在计算" + MODE_LABELS[state.mode] + "等时圈…", "busy");
    var badge = $("isoBadge");
    if (badge) badge.hidden = true;

    fetch("/api/isochrone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: state.lat,
        lon: state.lon,
        minutes: MINUTES,
        mode: state.mode,
        road_pref: state.roadPref,
        avoid_tolls: state.avoidTolls,
        avoid_ferries: state.avoidFerries,
        avoid_unpaved: state.avoidUnpaved
      })
    })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok || data.ok === false) throw new Error(data.error || "HTTP " + response.status);
          return data;
        });
      })
      .then(function (data) {
        if (requestId !== state.requestId) return;
        state.busy = false;
        render(data, fit !== false);
      })
      .catch(function (error) {
        if (requestId !== state.requestId) return;
        state.busy = false;
        setStatus("计算失败：" + (error && error.message ? error.message : "请求失败"), "error");
      });
  }

  function clearOverlay() {
    clearLayers();
    state.raw = null;
    var badge = $("isoBadge");
    if (badge) badge.hidden = true;
  }

  function openOverlay() {
    var map = getMap();
    if (!map) {
      window.setTimeout(openOverlay, 250);
      return;
    }
    var panel = $("isoPanel");
    var button = $("btnIsoToggle");
    if (!panel || !button) return;
    state.open = true;
    panel.hidden = false;
    button.classList.add("is-active");
    button.setAttribute("aria-pressed", "true");
    if (!state.clickBound) {
      map.on("click", function (event) {
        if (!state.open) return;
        var wgs = toWgs(event.latlng.lng, event.latlng.lat);
        state.lon = wgs[0];
        state.lat = wgs[1];
        if (state.startMarker) map.removeLayer(state.startMarker);
        drawStartMarker();
        applyDisplayMode();
        fetchIsochrone(true);
      });
      state.clickBound = true;
    }
    if (!state.raw && !state.busy) {
      setStatus("正在检查等时圈数据…", "busy");
      fetch("/api/isochrone/status")
        .then(function (r) { return r.json(); })
        .then(function (status) {
          if (!status.available) {
            setStatus("等时圈数据未生成，请先运行 scripts/isochrone/ 初始化数据", "error");
            return;
          }
          fetchIsochrone(true);
        })
        .catch(function () { fetchIsochrone(true); });
    }
  }

  function closeOverlay() {
    state.open = false;
    var panel = $("isoPanel");
    var button = $("btnIsoToggle");
    if (panel) panel.hidden = true;
    if (button) {
      button.classList.remove("is-active");
      button.setAttribute("aria-pressed", "false");
    }
    clearOverlay();
    setStatus("已关闭等时圈叠加", "ok");
  }

  function bind() {
    var map = getMap();
    if (!map) {
      window.setTimeout(bind, 250);
      return;
    }
    state.map = map;
    var toggle = $("btnIsoToggle");
    if (toggle) toggle.addEventListener("click", function () {
      if (state.open) closeOverlay();
      else openOverlay();
    });
    var close = $("btnIsoClose");
    if (close) close.addEventListener("click", closeOverlay);
    var calc = $("btnIsoCalc");
    if (calc) calc.addEventListener("click", function () { fetchIsochrone(true); });
    var reset = $("btnIsoReset");
    if (reset) reset.addEventListener("click", function () {
      state.lat = DEFAULT_CENTER.lat;
      state.lon = DEFAULT_CENTER.lon;
      if (state.startMarker) state.map.removeLayer(state.startMarker);
      drawStartMarker();
      fetchIsochrone(true);
    });

    document.querySelectorAll('input[name="ovDisplayMode"]').forEach(function (input) {
      input.addEventListener("change", function () {
        readSettings();
        applyDisplayMode();
      });
    });
    document.querySelectorAll('input[name="ovTravelMode"]').forEach(function (input) {
      input.addEventListener("change", function () {
        readSettings();
        updateSettingsUi();
        if (state.open) fetchIsochrone(true);
      });
    });
    var road = $("ovRoadPref");
    if (road) road.addEventListener("change", function () {
      readSettings();
      updateSettingsUi();
      if (state.open) fetchIsochrone(true);
    });
    ["ovAvoidTolls", "ovAvoidFerries", "ovAvoidUnpaved"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("change", function () {
        readSettings();
        updateSettingsUi();
        if (state.open) fetchIsochrone(true);
      });
    });

    map.on("zoomend", function () {
      if (state.open && state.cityFeatures.length) drawCities(state.cityFeatures);
      if (state.open) applyDisplayMode();
    });

    // 底图切换会改变显示坐标系（GCJ-02 / WGS-84），需要重新投影等时圈
    document.querySelectorAll("[data-basemap]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        window.setTimeout(function () {
          if (state.open && state.raw) render(state.raw, false);
        }, 350);
      });
    });
  }

  function boot() {
    bind();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
