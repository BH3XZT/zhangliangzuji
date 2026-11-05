/* 城市自驾等时圈 —— 集成到 maptrack-merger 的 Leaflet 页面 */
(function () {
  "use strict";

  var DEFAULT_CENTER = { lat: 37.8706, lon: 112.5489 };
  var MINUTES = [60, 120, 180, 240];
  var COLORS = { 60: "#0b3d91", 120: "#1d4ed8", 180: "#3b82f6", 240: "#7dd3fc" };
  var MODE_LABELS = { car: "汽车", motorcycle: "摩托车", bike: "自行车", walk: "步行" };
  var ROAD_LABELS = {
    highway: "高速优先",
    national: "国道/主干优先",
    balanced: "均衡",
    avoid_highway: "避开高速"
  };

  var state = {
    lat: DEFAULT_CENTER.lat,
    lon: DEFAULT_CENTER.lon,
    map: null,
    isoLayers: [],
    waterLayer: null,
    cityLayer: null,
    startMarker: null,
    cityFeatures: [],
    requestId: 0,
    mode: "car",
    roadPref: "balanced",
    avoidTolls: false,
    avoidFerries: false,
    avoidUnpaved: false,
    displayMode: "all"
  };

  function $(id) { return document.getElementById(id); }

  function setStatus(text, mode) {
    var el = $("status");
    if (!el) return;
    var textEl = $("statusText");
    if (textEl) textEl.textContent = text;
    el.classList.toggle("busy", mode === "busy");
    el.classList.toggle("error", mode === "error");
  }

  function showLoading(show) {
    var el = $("loading");
    if (el) el.hidden = !show;
  }

  function showError(message) {
    var box = $("errorToast");
    var text = $("errorText");
    if (text) text.textContent = message || "未知错误";
    if (box) box.hidden = false;
  }

  function hideError() {
    var box = $("errorToast");
    if (box) box.hidden = true;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  /* ------------------------- 设置读取 ------------------------- */

  function readSettings() {
    var display = document.querySelector('input[name="displayMode"]:checked');
    var mode = document.querySelector('input[name="travelMode"]:checked');
    var road = $("roadPref");
    if (display) state.displayMode = display.value;
    if (mode) state.mode = mode.value;
    if (road) state.roadPref = road.value;
    state.avoidTolls = !!($("avoidTolls") && $("avoidTolls").checked);
    state.avoidFerries = !!($("avoidFerries") && $("avoidFerries").checked);
    state.avoidUnpaved = !!($("avoidUnpaved") && $("avoidUnpaved").checked);
  }

  function motorizedMode() {
    return state.mode === "car" || state.mode === "motorcycle";
  }

  function updateSettingsUI() {
    var motorized = motorizedMode();
    var road = $("roadPref");
    var tolls = $("avoidTolls");
    var unpaved = $("avoidUnpaved");
    if (road) road.disabled = !motorized;
    if (tolls) tolls.disabled = !motorized;
    if (unpaved) unpaved.disabled = !motorized;

    var roadHint = $("roadHint");
    if (roadHint) {
      roadHint.textContent = motorized
        ? "Valhalla 没有国道独立分类，国道/主干优先用高速与主干路权重近似；避开收费会自动把收费权重设为 0。"
        : "步行 / 自行车不使用“道路偏好”和收费选项，仍可避开轮渡。";
    }
    var modeHint = $("modeHint");
    if (modeHint) {
      modeHint.textContent = motorized
        ? "汽车/摩托车支持高速权重、避开收费、避开非铺装路；步行/自行车使用各自的路网。"
        : "自行车更偏好道路与低坡度；步行使用人行道/步道网络。";
    }

    var badgeTitle = $("badgeTitle");
    var badgeSub = $("badgeSub");
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

  /* ------------------------- 地图与图层 ------------------------- */

  function initMap() {
    var map = L.map("map", {
      zoomControl: false,
      attributionControl: true,
      minZoom: 3,
      maxZoom: 16
    }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lon], 7);

    L.control.zoom({ position: "topright" }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);

    map.on("click", function (event) {
      var latlng = event.latlng;
      state.lat = latlng.lat;
      state.lon = latlng.lng;
      drawStartMarker();
      fetchIsochrone();
    });

    map.on("zoomend", function () {
      if (state.cityFeatures.length) drawCityLabels(state.cityFeatures);
    });

    state.map = map;
    drawStartMarker();
    window.__iso = state;
  }

  function setLayerVisible(layer, visible) {
    if (!layer || !state.map) return;
    if (visible) {
      if (!state.map.hasLayer(layer)) state.map.addLayer(layer);
    } else if (state.map.hasLayer(layer)) {
      state.map.removeLayer(layer);
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
    if (!state.map) return;
    if (state.startMarker) state.map.removeLayer(state.startMarker);
    var icon = L.divIcon({
      className: "",
      html: '<div class="start-wrap"><span class="pulse"></span><span class="dot"></span></div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
    state.startMarker = L.marker([state.lat, state.lon], {
      icon: icon,
      interactive: false,
      keyboard: false
    }).addTo(state.map);
    applyDisplayMode();
  }

  function clearIsoLayers() {
    state.isoLayers.forEach(function (layer) { state.map.removeLayer(layer); });
    state.isoLayers = [];
    if (state.waterLayer) {
      state.map.removeLayer(state.waterLayer);
      state.waterLayer = null;
    }
  }

  function drawIsochrone(features) {
    var map = state.map;
    clearIsoLayers();
    var byMinutes = {};
    features.forEach(function (feature) {
      var minutes = Number(feature.properties && feature.properties.minutes);
      if (!COLORS[minutes]) return;
      (byMinutes[minutes] = byMinutes[minutes] || []).push(feature);
    });

    // 大范围先画，小范围后画，保证 60 分钟深色区域在最上层
    MINUTES.slice().sort(function (a, b) { return b - a; }).forEach(function (minutes) {
      var list = byMinutes[minutes];
      if (!list || !list.length) return;
      var layer = L.geoJSON(
        { type: "FeatureCollection", features: list },
        {
          style: {
            color: COLORS[minutes],
            weight: minutes === 60 ? 2 : 1.4,
            opacity: 0.9,
            fillColor: COLORS[minutes],
            fillOpacity: 0.24
          }
        }
      ).addTo(map);
      state.isoLayers.push(layer);
    });
  }

  function drawWater(features) {
    if (!state.map || !features.length) return;
    state.waterLayer = L.geoJSON(
      { type: "FeatureCollection", features: features },
      {
        style: {
          color: "#1e3a8a",
          weight: 1.2,
          opacity: 0.72
        }
      }
    ).addTo(state.map);
  }

  function drawCityLabels(features) {
    if (!state.map) return;
    if (state.cityLayer) {
      state.map.removeLayer(state.cityLayer);
      state.cityLayer = null;
    }
    state.cityFeatures = features;
    var zoom = state.map.getZoom();
    var list = features;
    if (zoom < 7.5) {
      list = features.filter(function (feature) {
        return feature.properties && feature.properties.place === "city";
      });
    }
    list = list.slice(0, zoom < 7.5 ? 45 : 140);
    var markers = [];
    list.forEach(function (feature) {
      var geometry = feature.geometry || {};
      if (geometry.type !== "Point") return;
      var coords = geometry.coordinates || [];
      if (coords.length < 2) return;
      var props = feature.properties || {};
      if (!props.name) return;
      var town = props.place === "town" ? " town" : "";
      var icon = L.divIcon({
        className: "",
        html: '<span class="city-label' + town + '">' + escapeHtml(props.name) + "</span>",
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      });
      markers.push(L.marker([coords[1], coords[0]], { icon: icon, interactive: false, keyboard: false }));
    });
    state.cityLayer = L.layerGroup(markers).addTo(state.map);
    state.cityMarkerCount = markers.length;
  }

  function applyData(data) {
    var features = Array.isArray(data.features) ? data.features : [];
    var iso = features.filter(function (f) { return f.properties && f.properties.layer === "isochrone"; });
    var water = features.filter(function (f) { return f.properties && f.properties.layer === "water"; });
    var cities = features.filter(function (f) { return f.properties && f.properties.layer === "city"; });

    drawIsochrone(iso);
    drawWater(water);
    drawCityLabels(cities);
    applyDisplayMode();

    var meta = data.meta || {};
    var metaCard = $("metaCard");
    if (metaCard) metaCard.hidden = false;
    if ($("metaIso")) $("metaIso").textContent = iso.length + " 层";
    if ($("metaWater")) $("metaWater").textContent = water.length + " 条";
    if ($("metaCity")) $("metaCity").textContent = cities.length + " 个";

    if (meta.bbox && meta.bbox.length === 4 && state.map) {
      var mobile = window.innerWidth < 720;
      var bounds = L.latLngBounds(
        [meta.bbox[1], meta.bbox[0]],
        [meta.bbox[3], meta.bbox[2]]
      );
      state.map.fitBounds(bounds, {
        paddingTopLeft: mobile ? [16, 96] : [260, 120],
        paddingBottomRight: mobile ? [16, 120] : [90, 90],
        maxZoom: mobile ? 9 : 10,
        animate: true,
        duration: 0.6
      });
    }
  }

  function fetchIsochrone() {
    var requestId = ++state.requestId;
    readSettings();
    showLoading(true);
    hideError();
    setStatus("正在计算" + MODE_LABELS[state.mode] + "等时圈…", "busy");

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
          if (!response.ok || data.ok === false) {
            throw new Error(data.error || "HTTP " + response.status);
          }
          return data;
        });
      })
      .then(function (data) {
        if (requestId !== state.requestId) return;
        applyData(data);
        var meta = data.meta || {};
        var roadText = motorizedMode() ? " · " + (ROAD_LABELS[state.roadPref] || meta.road_pref_label || "") : "";
        setStatus(
          (meta.mode_label || MODE_LABELS[state.mode]) + roadText +
            " · 水系 " + (meta.water_count || 0) + " 条 · 城市 " + (meta.city_count || 0) + " 个",
          "ok"
        );
        showLoading(false);
      })
      .catch(function (error) {
        if (requestId !== state.requestId) return;
        showLoading(false);
        setStatus("计算失败", "error");
        showError(error && error.message ? error.message : "请求失败，请检查 maptrack 容器日志");
      });
  }

  function buildLegend() {
    var list = $("legendList");
    if (!list) return;
    MINUTES.forEach(function (minutes) {
      var item = document.createElement("li");
      var swatch = document.createElement("i");
      swatch.className = "iso-swatch";
      swatch.style.background = COLORS[minutes];
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(minutes + " 分钟"));
      list.appendChild(item);
    });
  }

  function checkStatus() {
    return fetch("/api/isochrone/status")
      .then(function (response) { return response.json(); })
      .then(function (status) {
        if (!status.available) {
          setStatus("等时圈数据未生成", "error");
          showError("还没有等时圈数据。请在 NAS 上先运行 scripts/isochrone/ 下的下载、构建和提取脚本，再启动 valhalla 服务。");
          showLoading(false);
          return false;
        }
        return true;
      })
      .catch(function () { return true; });
  }

  function onSettingChanged(requery) {
    readSettings();
    updateSettingsUI();
    if (requery) {
      fetchIsochrone();
    }
  }

  function bindControls() {
    var refresh = $("btnRefresh");
    if (refresh) refresh.addEventListener("click", fetchIsochrone);

    var reset = $("btnReset");
    if (reset) {
      reset.addEventListener("click", function () {
        state.lat = DEFAULT_CENTER.lat;
        state.lon = DEFAULT_CENTER.lon;
        drawStartMarker();
        fetchIsochrone();
      });
    }

    var retry = $("btnRetry");
    if (retry) retry.addEventListener("click", function () {
      hideError();
      fetchIsochrone();
    });

    document.querySelectorAll('input[name="displayMode"]').forEach(function (input) {
      input.addEventListener("change", function () {
        readSettings();
        applyDisplayMode();
      });
    });

    document.querySelectorAll('input[name="travelMode"]').forEach(function (input) {
      input.addEventListener("change", function () { onSettingChanged(true); });
    });

    var road = $("roadPref");
    if (road) road.addEventListener("change", function () { onSettingChanged(true); });
    ["avoidTolls", "avoidFerries", "avoidUnpaved"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("change", function () { onSettingChanged(true); });
    });

    var settings = $("settings");
    if (settings && window.innerWidth < 720) settings.open = false;
  }

  function boot() {
    readSettings();
    buildLegend();
    bindControls();
    updateSettingsUI();
    initMap();
    checkStatus().then(function (available) {
      if (available) fetchIsochrone();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
