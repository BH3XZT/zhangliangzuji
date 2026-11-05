/* 在轨迹总览地图（overviewMap）上叠加等时圈，不再使用独立的等时圈地图页。 */
(function () {
  "use strict";

  var DEFAULT_CENTER = { lat: 37.8706, lon: 112.5489 };
  var MODE_LABELS = { car: "汽车", motorcycle: "摩托车", bike: "自行车", walk: "步行" };
  var ROAD_LABELS = { highway: "高速优先", national: "国道/主干优先", balanced: "均衡", avoid_highway: "避开高速" };

  function minutesForHours(hours) {
    var result = [];
    for (var hour = 1; hour <= hours; hour++) result.push(hour * 60);
    return result;
  }

  function colorForHour(hour, total) {
    var t = total <= 1 ? 0 : (hour - 1) / (total - 1);
    var start = [11, 61, 145];
    var end = [125, 211, 252];
    var c = [];
    for (var i = 0; i < 3; i++) c.push(Math.round(start[i] + (end[i] - start[i]) * t));
    return "rgb(" + c.join(",") + ")";
  }

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
    renderMode: "both",
    hours: 4,
    isoLayers: [],
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
    var render = document.querySelector('input[name="ovRenderMode"]:checked');
    var mode = document.querySelector('input[name="ovTravelMode"]:checked');
    var road = $("ovRoadPref");
    var hours = $("ovHours");
    if (render) state.renderMode = render.value;
    if (mode) state.mode = mode.value;
    if (road) state.roadPref = road.value;
    if (hours) state.hours = Math.max(1, Math.min(10, parseInt(hours.value, 10) || 4));
    state.avoidTolls = !!($("ovAvoidTolls") && $("ovAvoidTolls").checked);
    state.avoidFerries = !!($("ovAvoidFerries") && $("ovAvoidFerries").checked);
    state.avoidUnpaved = !!($("ovAvoidUnpaved") && $("ovAvoidUnpaved").checked);
  }

  function updateLegend() {
    var box = $("ovIsoLegend");
    if (!box) return;
    box.innerHTML = "";
    for (var hour = 1; hour <= state.hours; hour++) {
      var span = document.createElement("span");
      var swatch = document.createElement("i");
      swatch.style.background = colorForHour(hour, state.hours);
      span.appendChild(swatch);
      span.appendChild(document.createTextNode(hour + " 小时"));
      box.appendChild(span);
    }
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
    var hoursHint = $("ovHoursHint");
    if (hoursHint) {
      hoursHint.textContent = state.hours > 4
        ? "当前数据约覆盖太原周边 300km；超过 4 小时的范围可能被数据边界截断。"
        : "显示 1 小时至所选小时的分层，最多 10 小时。";
    }
    var badgeTitle = $("isoBadgeTitle");
    var badgeSub = $("isoBadgeSub");
    if (badgeTitle && badgeSub) {
      var h = state.hours;
      if (state.mode === "walk") {
        badgeTitle.textContent = h + "h 步行范围";
        badgeSub.textContent = "轻松可达";
      } else if (state.mode === "bike") {
        badgeTitle.textContent = h + "h 骑行范围";
        badgeSub.textContent = "量力而行";
      } else {
        badgeTitle.textContent = h + "h 内可达";
        badgeSub.textContent = h >= 4 ? "建议过夜" : "当日可达";
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
    if (state.cityLayer) {
      if (map.hasLayer(state.cityLayer)) map.removeLayer(state.cityLayer);
      state.cityLayer = null;
    }
    if (state.startMarker) {
      if (map.hasLayer(state.startMarker)) map.removeLayer(state.startMarker);
      state.startMarker = null;
    }
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
    var maxHour = state.hours;
    var byMinutes = {};
    features.forEach(function (feature) {
      var minutes = Number(feature.properties && feature.properties.minutes);
      var hour = minutes / 60;
      if (!isFinite(hour) || hour < 1 || hour > maxHour) return;
      (byMinutes[minutes] = byMinutes[minutes] || []).push(convertFeature(feature));
    });
    var fillOpacity = maxHour >= 8 ? 0.10 : (maxHour >= 6 ? 0.13 : 0.22);
    Object.keys(byMinutes).map(Number).sort(function (a, b) { return b - a; }).forEach(function (minutes) {
      var list = byMinutes[minutes];
      if (!list || !list.length) return;
      var colorOnly = state.renderMode === "color";
      var color = colorForHour(minutes / 60, maxHour);
      var layer = L.geoJSON(
        { type: "FeatureCollection", features: list },
        {
          style: {
            stroke: !colorOnly,
            color: color,
            weight: colorOnly ? 0 : (minutes === 60 ? 2.2 : 1.4),
            opacity: colorOnly ? 0 : 0.9,
            fillColor: color,
            fillOpacity: fillOpacity
          }
        }
      ).addTo(map);
      state.isoLayers.push(layer);
    });
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
    var maxLabels = zoom < 7.5 ? 45 : 120;
    var placed = [];
    var markers = [];
    list.forEach(function (feature) {
      if (markers.length >= maxLabels) return;
      var geometry = feature.geometry || {};
      if (geometry.type !== "Point") return;
      var coords = geometry.coordinates || [];
      if (coords.length < 2) return;
      var props = feature.properties || {};
      if (!props.name) return;
      var p = toDisplay(coords[0], coords[1]);
      var screen = map.latLngToContainerPoint([p[1], p[0]]);
      for (var j = 0; j < placed.length; j++) {
        if (Math.abs(placed[j].x - screen.x) < 66 && Math.abs(placed[j].y - screen.y) < 24) return;
      }
      placed.push(screen);
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
    var cities = features.filter(function (f) { return f.properties && f.properties.layer === "city"; });
    drawIsochrone(iso);
    drawCities(cities);
    drawStartMarker();

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
        " · " + state.hours + "h · 城市 " + (meta.city_count || 0) + " 个" +
        (state.hours > 4 ? " · 远距离可能受数据范围截断" : ""),
      "ok"
    );
    updateLegend();
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
        minutes: minutesForHours(state.hours),
        mode: state.mode,
        road_pref: state.roadPref,
        avoid_tolls: state.avoidTolls,
        avoid_ferries: state.avoidFerries,
        avoid_unpaved: state.avoidUnpaved,
        include_water: false
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

    document.querySelectorAll('input[name="ovRenderMode"]').forEach(function (input) {
      input.addEventListener("change", function () {
        readSettings();
        if (state.open && state.raw) {
          render(state.raw, false);
        }
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
    var hours = $("ovHours");
    if (hours) hours.addEventListener("change", function () {
      readSettings();
      updateSettingsUi();
      updateLegend();
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
    readSettings();
    updateSettingsUi();
    updateLegend();
    bind();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
