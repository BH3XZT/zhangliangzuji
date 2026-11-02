/* ============================================================
 * 地图轨迹合并工具 — 前端交互逻辑
 * 依赖：window.L（web/vendor/leaflet.js）、window.CRS（web/crs.js）
 * 无构建、无第三方 CDN。接口契约见 _SPEC_内部.md 第 3 节。
 * ============================================================ */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
   * 常量
   * ------------------------------------------------------------------ */

  const CRS_IDS = ['WGS84', 'GCJ02', 'BD09'];
  const CRS_LABELS = { WGS84: 'WGS-84', GCJ02: 'GCJ-02', BD09: 'BD-09' };
  const CRS_SELECT_OPTIONS = [
    { id: 'auto', label: '自动识别' },
    { id: 'WGS84', label: 'WGS-84' },
    { id: 'GCJ02', label: 'GCJ-02' },
    { id: 'BD09', label: 'BD-09' }
  ];

  // 内置 8 色（每条轨迹一种颜色）
  const COLORS = [
    '#0ea5e9', '#f97316', '#22c55e', '#a855f7',
    '#ef4444', '#14b8a6', '#eab308', '#ec4899'
  ];

  const FALLBACK_FORMATS = {
    crs: [
      { id: 'WGS84', label: 'WGS-84（GPS / GPX / KML 标准坐标）' },
      { id: 'GCJ02', label: 'GCJ-02（高德 / 腾讯 / Google 中国）' },
      { id: 'BD09', label: 'BD-09（百度地图）' }
    ],
    formats: [
      { id: 'gpx', label: 'GPX', ext: ['.gpx'], crs: 'WGS84' },
      { id: 'kml', label: 'KML', ext: ['.kml'], crs: 'WGS84' },
      { id: 'tcx', label: 'TCX', ext: ['.tcx'], crs: 'WGS84' },
      { id: 'geojson', label: 'GeoJSON', ext: ['.geojson'], crs: 'WGS84' },
      { id: 'csv', label: 'CSV', ext: ['.csv'], crs: 'WGS84' },
      { id: 'json', label: 'JSON', ext: ['.json'], crs: 'WGS84' },
      { id: 'nmea', label: 'NMEA', ext: ['.nmea', '.txt'], crs: 'WGS84' },
      { id: 'fit', label: 'FIT', ext: ['.fit'], crs: 'WGS84' },
      { id: 'baidu', label: '百度地图', ext: ['.json'], crs: 'BD09' },
      { id: 'amap', label: '高德地图', ext: ['.json'], crs: 'GCJ02' }
    ],
    export_formats: [
      { id: 'gpx', label: 'GPX', ext: '.gpx', mime: 'application/gpx+xml' },
      { id: 'kml', label: 'KML', ext: '.kml', mime: 'application/vnd.google-earth.kml+xml' },
      { id: 'geojson', label: 'GeoJSON', ext: '.geojson', mime: 'application/geo+json' },
      { id: 'csv', label: 'CSV', ext: '.csv', mime: 'text/csv' }
    ]
  };

  const BASEMAPS = {
    'gaode-vector': {
      label: '高德矢量',
      crs: 'GCJ02',
      url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      options: { subdomains: '1234', minZoom: 3, maxZoom: 19, attribution: '&copy; 高德地图' }
    },
    'gaode-satellite': {
      label: '高德卫星',
      crs: 'GCJ02',
      url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
      options: { subdomains: '1234', minZoom: 3, maxZoom: 19, attribution: '&copy; 高德地图' }
    },
    osm: {
      label: 'OSM',
      crs: 'WGS84',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { minZoom: 2, maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }
    }
  };

  const ICONS = {
    eye: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l16 16"/><path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.1 3.9"/><path d="M6.3 7.8A17.4 17.4 0 0 0 2.5 12S6 18.5 12 18.5c1.2 0 2.3-.25 3.3-.67"/><path d="M10.1 10.2a2.6 2.6 0 0 0 3.6 3.6"/></svg>',
    locate: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></svg>'
  };

  const MAX_FILE_BYTES = 32 * 1024 * 1024;
  const MAX_CHART_SAMPLES = 1400;
  const HEALTH_INTERVAL_MS = 10000;
  const DEFAULT_CENTER_WGS = [104.8, 35.2];
  const DEFAULT_ZOOM = 4;
  const DEMO_MAX_SAMPLES = 4;
  // 演示模式优先选择的示例类型（百度 / 高德 / GPX / KML）
  const DEMO_SAMPLE_KEYS = [
    ['baidu', '百度'],
    ['amap', 'gaode', '高德', 'gcj'],
    ['gpx'],
    ['kml']
  ];

  /* ------------------------------------------------------------------
   * 状态与 DOM
   * ------------------------------------------------------------------ */

  const dom = {};
  const state = {
    formats: FALLBACK_FORMATS,
    tracks: [],
    merged: null,
    chartSeries: null,
    chartLayout: null,
    chartMode: 'ele',
    chartHover: null,
    displayCrs: 'GCJ02',
    basemap: 'gaode-vector',
    customTile: { url: '', crs: 'WGS84' },
    focusedUid: null,
    colorCursor: 0,
    idSeq: 0,
    busy: { upload: false, merge: false, export: false },
    online: null,
    samples: [],
    samplesLoaded: false,
    crsMissing: false,
    tileErrorShown: false,
    demoRunning: false,
    panelRequested: false,
    autoSave: true,
    page: 'overview',
    library: {
      loaded: false,
      loading: false,
      stale: true,
      updatedAt: 0,
      tracks: [],
      stats: null,
      visibility: {},
      geometry: {},
      loadingIds: {},
      queue: [],
      activeRequests: 0,
      selectedId: null,
      fitted: false,
      filters: { q: '', source: 'all', year: 'all' }
    },
    milestones: {
      loaded: false,
      loading: false,
      data: null,
      expanded: { provinces: {}, cities: {} },
      onlyVisited: false
    },
    sync: {
      token: null,
      expiresAt: 0,
      loadingToken: false,
      statusLoading: false,
      scanning: false,
      timer: 0,
      status: null
    }
  };

  let L = null;
  let map = null;
  let currentTile = null;
  let trackLayer = null;
  let mergedLayer = null;
  let overviewMap = null;
  let overviewTile = null;
  let overviewLayer = null;
  let milestoneMap = null;
  let milestoneTile = null;
  let milestoneGeoLyr = null;
  let healthTimer = 0;
  let chartRaf = 0;
  let readoutNodes = null;
  const PAGE_NAMES = ['overview', 'import', 'milestones', 'sync'];
  const SIDEBAR_MIN = 280;
  const SIDEBAR_MAX = 600;
  const DOCK_MIN = 140;
  const DOCK_MAX = 480;
  const SIDEBAR_DEFAULT = 384;

  /* ------------------------------------------------------------------
   * 工具函数
   * ------------------------------------------------------------------ */

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function debounce(fn, wait) {
    let timer = 0;
    return function () {
      const args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = 0;
        fn.apply(null, args);
      }, wait);
    };
  }

  function isMobile() {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  function fmtInt(value) {
    if (!Number.isFinite(value)) return '—';
    return Math.round(value).toLocaleString('zh-CN');
  }

  function fmtNum(value, digits) {
    if (!Number.isFinite(value)) return '—';
    const d = typeof digits === 'number' ? digits : 1;
    return Number(value).toLocaleString('zh-CN', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  }

  function fmtKm(meters) {
    if (!Number.isFinite(meters)) return '—';
    return fmtNum(meters / 1000, 2) + ' km';
  }

  function fmtCoord(value) {
    if (!Number.isFinite(value)) return '—';
    return Number(value).toFixed(6);
  }

  function fmtDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    const total = Math.round(seconds);
    if (total < 60) return total + ' 秒';
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return hours + ' 小时 ' + String(minutes).padStart(2, '0') + ' 分';
    return minutes + ' 分 ' + String(secs).padStart(2, '0') + ' 秒';
  }

  function fmtDateTime(ts) {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return '';
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtClock() {
    const d = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtTimeRange(start, end) {
    if (!Number.isFinite(start) && !Number.isFinite(end)) return '无时间信息';
    if (Number.isFinite(start) && Number.isFinite(end)) return fmtDateTime(start) + ' ~ ' + fmtDateTime(end);
    return fmtDateTime(Number.isFinite(start) ? start : end);
  }

  /* 统计卡用的紧凑时间格式：同一天只显示一次日期，日期与时间之间用不换行空格，
     避免在 190~210px 的卡片里把 “2024-06-01 08:00” 拆成两截。 */
  function fmtShortDateTime(ts, withYear) {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return '';
    const pad = function (n) { return String(n).padStart(2, '0'); };
    const date = withYear
      ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      : pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    return date + '\u00a0' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtClockOf(ts) {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return '';
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtTimeRangeCompact(start, end) {
    if (!Number.isFinite(start) && !Number.isFinite(end)) return '无时间信息';
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return fmtShortDateTime(Number.isFinite(start) ? start : end, false);
    }
    const a = new Date(Number(start) * 1000);
    const b = new Date(Number(end) * 1000);
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return fmtTimeRange(start, end);
    const sameYear = a.getFullYear() === b.getFullYear();
    const sameDay = sameYear && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (sameDay) {
      return fmtShortDateTime(start, false) + ' ~ ' + fmtClockOf(end);
    }
    if (sameYear) {
      return fmtShortDateTime(start, false) + ' ~ ' + fmtShortDateTime(end, false);
    }
    return fmtShortDateTime(start, true) + ' ~ ' + fmtShortDateTime(end, true);
  }

  function fmtAxisDistance(meters) {
    if (!Number.isFinite(meters)) return '';
    if (Math.abs(meters) >= 1000) {
      const km = meters / 1000;
      return fmtNum(km, km >= 10 ? 1 : 2) + ' km';
    }
    return Math.round(meters) + ' m';
  }

  function fmtChartValue(value, mode) {
    if (!Number.isFinite(value)) return '';
    if (mode === 'ele') return String(Math.round(value));
    return Number(value).toFixed(1);
  }

  function safeFilename(name) {
    const cleaned = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || '合并轨迹';
  }

  function hexToRgba(hex, alpha) {
    const h = String(hex).replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  // 距离（米），参数 [lng, lat]
  const EARTH_RADIUS = 6371008.8;
  function haversine(a, b) {
    const toRad = Math.PI / 180;
    const lat1 = a[1] * toRad;
    const lat2 = b[1] * toRad;
    const dLat = lat2 - lat1;
    const dLng = (b[0] - a[0]) * toRad;
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /* ------------------------------------------------------------------
   * 坐标系换算（严格要求：只使用 window.CRS，绝不自行实现偏移算法）
   * ------------------------------------------------------------------ */

  function wgsToDisplay(lng, lat, displayCrs) {
    if (!displayCrs || displayCrs === 'WGS84') return [lng, lat];
    if (!window.CRS || typeof window.CRS.toDisplay !== 'function') return [lng, lat];
    try {
      const p = window.CRS.toDisplay(lng, lat, displayCrs);
      if (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        return [p[0], p[1]];
      }
    } catch (e) {
      console.warn('CRS.toDisplay 失败', e);
    }
    return [lng, lat];
  }

  function displayToWgs(lng, lat, displayCrs) {
    if (!displayCrs || displayCrs === 'WGS84') return [lng, lat];
    if (!window.CRS) return [lng, lat];
    try {
      if (displayCrs === 'GCJ02' && typeof window.CRS.gcj02ToWgs84 === 'function') {
        return window.CRS.gcj02ToWgs84(lng, lat);
      }
      if (displayCrs === 'BD09' && typeof window.CRS.bd09ToWgs84 === 'function') {
        return window.CRS.bd09ToWgs84(lng, lat);
      }
    } catch (e) {
      console.warn('坐标系反算失败', e);
    }
    return [lng, lat];
  }

  function wgsPointToLatLng(point, displayCrs) {
    const converted = wgsToDisplay(point[0], point[1], displayCrs);
    return [converted[1], converted[0]];
  }

  /* ------------------------------------------------------------------
   * 网络请求
   * ------------------------------------------------------------------ */

  function friendlyError(err) {
    const msg = err && err.message ? String(err.message) : String(err || '未知错误');
    if (/failed to fetch|networkerror|fetch failed|load failed|network request failed/i.test(msg)) {
      return '无法连接后端服务，请确认服务已启动';
    }
    return msg;
  }

  async function apiJson(url, options) {
    const resp = await fetch(url, options || {});
    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      data = null;
    }
    if (!resp.ok || !data || data.ok === false) {
      let message = '请求失败（HTTP ' + resp.status + '）';
      if (data && data.error) message = data.error;
      else if (resp.status >= 500) message = '服务器内部错误（HTTP ' + resp.status + '）';
      throw new Error(message);
    }
    return data;
  }

  async function parseFiles(files, crsMode) {
    const fd = new FormData();
    for (let i = 0; i < files.length; i++) {
      fd.append('files', files[i], files[i].name);
    }
    fd.append('crs', crsMode || 'auto');
    const resp = await fetch('/api/parse', { method: 'POST', body: fd });
    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      data = null;
    }
    if (!resp.ok || !data || data.ok === false) {
      const message = data && data.error ? data.error : '解析请求失败（HTTP ' + resp.status + '）';
      throw new Error(message);
    }
    return data;
  }

  function filenameFromContentDisposition(disposition) {
    if (!disposition) return null;
    let match = /filename\*\s*=\s*([^;]+)/i.exec(disposition);
    if (match) {
      let raw = match[1].trim().replace(/^["']|["']$/g, '');
      raw = raw.replace(/^utf-8''/i, '');
      try {
        return decodeURIComponent(raw);
      } catch (e) {
        return raw;
      }
    }
    match = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(disposition);
    if (match) {
      const raw = String(match[2] !== undefined ? match[2] : match[1]).trim();
      try {
        return decodeURIComponent(raw);
      } catch (e) {
        return raw;
      }
    }
    return null;
  }

  function exportExt(format) {
    const list = (state.formats && state.formats.export_formats) || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === format && list[i].ext) return list[i].ext;
    }
    const fallback = { gpx: '.gpx', kml: '.kml', geojson: '.geojson', csv: '.csv', json: '.json' };
    return fallback[format] || '.txt';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || 'download';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(function () {
      try {
        document.body.removeChild(link);
      } catch (e) {
        /* ignore */
      }
      URL.revokeObjectURL(url);
    }, 4000);
  }

  /* ------------------------------------------------------------------
   * Toast / 健康检查
   * ------------------------------------------------------------------ */

  function toast(message, type, timeout) {
    if (!dom.toastStack) return;
    const kind = type === 'error' ? 'error' : type === 'success' ? 'success' : 'info';
    const node = el('div', 'toast toast-' + kind);
    node.appendChild(el('div', 'toast-text', message));
    dom.toastStack.appendChild(node);
    window.requestAnimationFrame(function () {
      node.classList.add('show');
    });
    window.setTimeout(function () {
      node.classList.remove('show');
      window.setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 220);
    }, timeout || 4200);
    while (dom.toastStack.children.length > 6) {
      dom.toastStack.removeChild(dom.toastStack.firstChild);
    }
  }

  async function refreshHealth() {
    try {
      const resp = await fetch('/api/health', { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      if (!data || data.ok === false) throw new Error('服务异常');
      setHealth(true, data);
    } catch (e) {
      setHealth(false, null);
    }
  }

  function setHealth(online, data) {
    state.online = online;
    if (!dom.healthPill) return;
    dom.healthPill.classList.toggle('is-offline', !online);
    dom.healthDot.className = 'health-dot ' + (online ? 'is-ok' : 'is-bad');
    dom.healthText.textContent = online ? '服务正常' : '服务离线';
    dom.healthPill.title = online ? '后端服务已连接' : '无法连接后端服务，请确认服务已启动';
    if (online && data && data.version) {
      dom.versionBadge.textContent = 'v' + data.version;
      dom.versionBadge.title = (data.name || 'MapTrackMerger') + ' ' + data.version;
    } else if (!online) {
      dom.versionBadge.textContent = 'v—';
      dom.versionBadge.title = '服务离线';
    }
  }

  /* ------------------------------------------------------------------
   * 轨迹数据辅助
   * ------------------------------------------------------------------ */

  function findTrack(uid) {
    for (let i = 0; i < state.tracks.length; i++) {
      if (state.tracks[i].uid === uid) return state.tracks[i];
    }
    return null;
  }

  function trackTitle(track) {
    const data = (track && track.data) || {};
    return data.name || data.filename || '未命名轨迹';
  }

  function createTrack(data, file, gid) {
    const color = COLORS[state.colorCursor % COLORS.length];
    state.colorCursor += 1;
    const crsMode = data.crs_auto === false && CRS_IDS.indexOf(data.source_crs) >= 0
      ? data.source_crs
      : 'auto';
    return {
      uid: 't' + (++state.idSeq),
      gid: gid,
      data: data,
      file: file || null,
      color: color,
      visible: true,
      crsMode: crsMode,
      reparsing: false,
      dispCache: null
    };
  }

  function addTracksFromParse(parsedTracks, file) {
    const gid = 'g' + (++state.idSeq);
    const created = [];
    for (let i = 0; i < parsedTracks.length; i++) {
      const track = createTrack(parsedTracks[i], file, gid);
      state.tracks.push(track);
      created.push(track);
    }
    return created;
  }

  function replaceGroupTracks(gid, parsedTracks) {
    const oldTracks = state.tracks.filter(function (t) { return t.gid === gid; });
    if (!oldTracks.length || !parsedTracks.length) return;
    const preserved = {
      visible: oldTracks[0].visible,
      color: oldTracks[0].color,
      file: oldTracks[0].file
    };
    const newTracks = parsedTracks.map(function (data, index) {
      const track = createTrack(data, preserved.file, gid);
      track.visible = preserved.visible;
      if (index === 0) track.color = preserved.color;
      return track;
    });
    const result = [];
    let inserted = false;
    for (let i = 0; i < state.tracks.length; i++) {
      const track = state.tracks[i];
      if (track.gid !== gid) {
        result.push(track);
      } else if (!inserted) {
        for (let j = 0; j < newTracks.length; j++) result.push(newTracks[j]);
        inserted = true;
      }
    }
    state.tracks = result;
    if (state.focusedUid && oldTracks.some(function (t) { return t.uid === state.focusedUid; })) {
      state.focusedUid = newTracks.length ? newTracks[0].uid : null;
    }
  }

  function getTrackDisplayCoords(track) {
    const data = track.data || {};
    const points = Array.isArray(data.points) ? data.points : [];
    const crs = state.displayCrs;
    const cache = track.dispCache;
    if (cache && cache.crs === crs && cache.points === points) return cache.coords;
    const coords = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      coords.push(wgsToDisplay(p[0], p[1], crs));
    }
    track.dispCache = { crs: crs, points: points, coords: coords };
    return coords;
  }

  function getMergedDisplayCoords(track) {
    const points = Array.isArray(track.points) ? track.points : [];
    const crs = state.displayCrs;
    const cache = track._dispCache;
    if (cache && cache.crs === crs && cache.points === points) return cache.coords;
    const coords = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
        coords[i] = null;
        continue;
      }
      coords[i] = wgsToDisplay(p[0], p[1], crs);
    }
    track._dispCache = { crs: crs, points: points, coords: coords };
    return coords;
  }

  function visibleTracksWithPoints() {
    return state.tracks.filter(function (track) {
      return track.visible &&
        track.data &&
        Array.isArray(track.data.points) &&
        track.data.points.length > 0;
    });
  }

  function currentExportTracks() {
    if (state.merged && state.merged.tracks && state.merged.tracks.length) {
      return state.merged.tracks.map(function (track) {
        return {
          name: track.name || '合并轨迹',
          points: Array.isArray(track.points) ? track.points : [],
          segments: Array.isArray(track.segments) && track.segments.length ? track.segments : [0]
        };
      });
    }
    return visibleTracksWithPoints().map(function (track) {
      return {
        name: trackTitle(track),
        points: track.data.points,
        segments: [0]
      };
    });
  }

  function maybeShowWgs84Hint() {
    const labels = [];
    state.tracks.forEach(function (track) {
      const source = track.data && track.data.source_crs;
      if (source && source !== 'WGS84' && CRS_LABELS[source] && labels.indexOf(CRS_LABELS[source]) < 0) {
        labels.push(CRS_LABELS[source]);
      }
    });
    if (!labels.length) return;
    toast('已统一到 WGS-84（原始坐标：' + labels.join(' / ') + '）', 'info', 4600);
  }

  /* ------------------------------------------------------------------
   * 地图
   * ------------------------------------------------------------------ */

  function initMap() {
    L = window.L;
    map = L.map(dom.map, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
      minZoom: 2,
      maxZoom: 19,
      worldCopyJump: true
    });
    map.setView([DEFAULT_CENTER_WGS[1], DEFAULT_CENTER_WGS[0]], DEFAULT_ZOOM, { animate: false });
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 130 }).addTo(map);
    trackLayer = L.layerGroup().addTo(map);
    mergedLayer = L.layerGroup().addTo(map);
    map.on('mousemove', onMapMouseMove);
    map.on('mouseout', onMapMouseOut);
    setBasemap('gaode-vector', { silent: true, keepView: true });
    window.requestAnimationFrame(function () {
      if (map) map.invalidateSize();
    });
  }

  function currentBasemapConfig() {
    if (state.basemap === 'custom') {
      if (!state.customTile.url) return null;
      return {
        label: '自定义瓦片',
        crs: state.customTile.crs,
        url: state.customTile.url,
        options: { subdomains: 'abc', minZoom: 2, maxZoom: 19, attribution: '自定义瓦片' }
      };
    }
    return BASEMAPS[state.basemap] || BASEMAPS['gaode-vector'];
  }

  function makeTileLayer(cfg) {
    const layer = L.tileLayer(cfg.url, cfg.options);
    layer.on('tileerror', function () {
      console.warn('底图瓦片加载失败（可能无法访问瓦片服务）：', cfg.url);
    });
    return layer;
  }

  function updateBasemapUI() {
    const bars = document.querySelectorAll('.basemap-bar');
    for (let b = 0; b < bars.length; b++) {
      const buttons = bars[b].querySelectorAll('.base-btn');
      for (let i = 0; i < buttons.length; i++) {
        buttons[i].classList.toggle('is-active', buttons[i].dataset.basemap === state.basemap);
      }
    }
  }

  function updateMapCrsTags() {
    const label = CRS_LABELS[state.displayCrs] || state.displayCrs;
    const nodes = document.querySelectorAll('[data-crs-tag]');
    for (let i = 0; i < nodes.length; i++) nodes[i].textContent = label;
    if (dom.milestoneCrsTag) dom.milestoneCrsTag.textContent = label;
  }

  function setBasemap(key, options) {
    const opts = options || {};
    let cfg = null;
    if (key === 'custom') {
      if (!state.customTile.url) {
        openCustomTilePanel();
        return;
      }
      cfg = {
        label: '自定义瓦片',
        crs: state.customTile.crs,
        url: state.customTile.url,
        options: { subdomains: 'abc', minZoom: 2, maxZoom: 19, attribution: '自定义瓦片' }
      };
    } else {
      cfg = BASEMAPS[key];
    }
    if (!cfg) return;

    const oldCrs = state.displayCrs;
    state.basemap = key;
    state.displayCrs = cfg.crs;

    if (map) {
      if (currentTile) {
        try {
          map.removeLayer(currentTile);
        } catch (e) {
          /* ignore */
        }
        currentTile = null;
      }
      currentTile = makeTileLayer(cfg).addTo(map);
      if (!opts.keepView) {
        const center = map.getCenter();
        const wgs = displayToWgs(center.lng, center.lat, oldCrs);
        const next = wgsToDisplay(wgs[0], wgs[1], cfg.crs);
        map.setView([next[1], next[0]], map.getZoom(), { animate: false });
      }
    }

    updateBasemapUI();
    updateMapCrsTags();
    refreshAuxMapsBasemap(oldCrs);
    redrawMap();
    if (!opts.silent) {
      toast('已切换底图：' + cfg.label + '（' + CRS_LABELS[cfg.crs] + '），底图与坐标已匹配', 'info', 2600);
    }
  }

  function refreshAuxMapsBasemap(oldCrs) {
    const cfg = currentBasemapConfig();
    if (!cfg) return;
    if (overviewMap) {
      if (overviewTile) {
        try {
          overviewMap.removeLayer(overviewTile);
        } catch (e) {
          /* ignore */
        }
        overviewTile = null;
      }
      overviewTile = makeTileLayer(cfg).addTo(overviewMap);
      const center = overviewMap.getCenter();
      const wgs = displayToWgs(center.lng, center.lat, oldCrs);
      const next = wgsToDisplay(wgs[0], wgs[1], state.displayCrs);
      overviewMap.setView([next[1], next[0]], overviewMap.getZoom(), { animate: false });
      renderOverviewMap();
    }
    if (milestoneMap) {
      if (milestoneTile) {
        try {
          milestoneMap.removeLayer(milestoneTile);
        } catch (e) {
          /* ignore */
        }
        milestoneTile = null;
      }
      milestoneTile = makeTileLayer(cfg).addTo(milestoneMap);
      const center = milestoneMap.getCenter();
      const wgs = displayToWgs(center.lng, center.lat, oldCrs);
      const next = wgsToDisplay(wgs[0], wgs[1], state.displayCrs);
      milestoneMap.setView([next[1], next[0]], milestoneMap.getZoom(), { animate: false });
      if (state.milestones.loaded && state.milestones.data) {
        loadMilestoneGeoJSON(true);
      }
    }
  }

  function openCustomTilePanel() {
    if (!dom.customTilePanel) return;
    dom.tileUrl.value = state.customTile.url || '';
    dom.tileCrs.value = state.customTile.crs || 'WGS84';
    dom.customTilePanel.hidden = false;
    if (dom.customTileBackdrop) dom.customTileBackdrop.hidden = false;
    window.setTimeout(function () {
      if (dom.tileUrl) dom.tileUrl.focus();
    }, 40);
  }

  function closeCustomTilePanel() {
    if (dom.customTilePanel) dom.customTilePanel.hidden = true;
    if (dom.customTileBackdrop) dom.customTileBackdrop.hidden = true;
  }

  function applyCustomTile() {
    const url = (dom.tileUrl.value || '').trim();
    if (!url) {
      toast('请输入自定义瓦片 URL', 'error');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      toast('瓦片 URL 需以 http:// 或 https:// 开头', 'error');
      return;
    }
    if (!/\{z\}/.test(url) || !/\{x\}/.test(url) || !/\{y\}/.test(url)) {
      toast('瓦片 URL 需包含 {z}、{x}、{y} 占位符', 'error');
      return;
    }
    state.customTile = { url: url, crs: dom.tileCrs.value || 'WGS84' };
    closeCustomTilePanel();
    setBasemap('custom');
  }

  function onMapMouseMove(ev) {
    if (!dom.coordReadout) return;
    const displayCrs = state.displayCrs;
    const wgs = displayToWgs(ev.latlng.lng, ev.latlng.lat, displayCrs);
    if (!readoutNodes) {
      clear(dom.coordReadout);
      const label1 = el('span', 'crd-label', 'WGS-84 ');
      const value1 = document.createTextNode('—');
      const sep = el('span', 'crd-sep', '·');
      const label2 = el('span', 'crd-label', (CRS_LABELS[displayCrs] || displayCrs) + ' ');
      const value2 = document.createTextNode('—');
      dom.coordReadout.appendChild(label1);
      dom.coordReadout.appendChild(value1);
      dom.coordReadout.appendChild(sep);
      dom.coordReadout.appendChild(label2);
      dom.coordReadout.appendChild(value2);
      readoutNodes = { value1: value1, label2: label2, value2: value2 };
    }
    readoutNodes.label2.textContent = (CRS_LABELS[displayCrs] || displayCrs) + ' ';
    readoutNodes.value1.textContent = fmtCoord(wgs[1]) + ', ' + fmtCoord(wgs[0]);
    readoutNodes.value2.textContent = fmtCoord(ev.latlng.lat) + ', ' + fmtCoord(ev.latlng.lng);
  }

  function onMapMouseOut() {
    if (!dom.coordReadout) return;
    readoutNodes = null;
    dom.coordReadout.textContent = '移动鼠标查看坐标';
  }

  function addCircle(layer, latlng, color, radius, extra) {
    const options = {
      radius: radius || 5,
      color: '#ffffff',
      weight: 2,
      fillColor: color,
      fillOpacity: 1
    };
    if (extra) {
      for (const key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) options[key] = extra[key];
      }
    }
    return L.circleMarker(latlng, options).addTo(layer);
  }

  function redrawMap() {
    if (!map || !trackLayer || !mergedLayer) return;
    trackLayer.clearLayers();
    mergedLayer.clearLayers();

    state.tracks.forEach(function (track) {
      if (!track.visible) return;
      const coords = getTrackDisplayCoords(track);
      if (!coords.length) return;
      const focused = state.focusedUid === track.uid;
      const latlngs = [];
      for (let i = 0; i < coords.length; i++) {
        latlngs.push([coords[i][1], coords[i][0]]);
      }
      if (latlngs.length >= 2) {
        L.polyline(latlngs, {
          color: track.color,
          weight: focused ? 6 : 4,
          opacity: focused ? 1 : 0.92,
          lineCap: 'round',
          lineJoin: 'round'
        }).addTo(trackLayer);
      }
      addCircle(trackLayer, latlngs[0], track.color, focused ? 6 : 5);
      addCircle(trackLayer, latlngs[latlngs.length - 1], track.color, focused ? 6 : 5);
    });

    if (state.merged) drawMerged();
    updateLegend();
    updateMapEmpty();
  }

  function drawMerged() {
    const tracks = (state.merged && state.merged.tracks) || [];
    tracks.forEach(function (track) {
      const coords = getMergedDisplayCoords(track);
      if (!coords.length) return;
      const segments = Array.isArray(track.segments) && track.segments.length
        ? track.segments.slice().sort(function (a, b) { return a - b; })
        : [0];
      for (let s = 0; s < segments.length; s++) {
        const begin = Math.max(0, Math.floor(segments[s]));
        const end = s + 1 < segments.length
          ? Math.max(begin, Math.floor(segments[s + 1]))
          : coords.length;
        const latlngs = [];
        for (let i = begin; i < end; i++) {
          const p = coords[i];
          if (p) latlngs.push([p[1], p[0]]);
        }
        if (latlngs.length < 2) continue;
        L.polyline(latlngs, {
          color: '#ffffff',
          weight: 10,
          opacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false
        }).addTo(mergedLayer);
        L.polyline(latlngs, {
          color: '#0369a1',
          weight: 6,
          opacity: 0.95,
          lineCap: 'round',
          lineJoin: 'round'
        }).addTo(mergedLayer);
      }
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first) addCircle(mergedLayer, [first[1], first[0]], '#0369a1', 6);
      if (last) addCircle(mergedLayer, [last[1], last[0]], '#f59e0b', 6);
    });
  }

  function updateLegend() {
    if (!dom.legend) return;
    const items = [];
    state.tracks.forEach(function (track) {
      if (!track.visible) return;
      items.push({ name: trackTitle(track), color: track.color, strong: false });
    });
    if (state.merged) {
      items.push({ name: '合并结果', color: '#0369a1', strong: true });
    }
    if (!items.length) {
      clear(dom.legend);
      dom.legend.hidden = true;
      return;
    }
    clear(dom.legend);
    items.forEach(function (item) {
      const row = el('div', 'legend-item' + (item.strong ? ' is-strong' : ''));
      const dot = el('span', 'legend-dot');
      dot.style.background = item.color;
      const name = el('span', 'legend-name', item.name);
      name.title = item.name;
      row.appendChild(dot);
      row.appendChild(name);
      dom.legend.appendChild(row);
    });
    dom.legend.hidden = false;
  }

  function updateMapEmpty() {
    if (!dom.mapEmpty) return;
    const hasVisible = state.tracks.some(function (track) { return track.visible; });
    dom.mapEmpty.hidden = hasVisible || !!state.merged;
  }

  function fitLatLngs(latlngs, animate) {
    if (!map || !latlngs.length) return;
    if (latlngs.length === 1) {
      map.setView(latlngs[0], 15, { animate: !!animate });
      return;
    }
    const bounds = L.latLngBounds(latlngs);
    if (!bounds.isValid()) return;
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16, animate: !!animate });
  }

  function fitToVisibleTracks(animate) {
    const latlngs = [];
    state.tracks.forEach(function (track) {
      if (!track.visible) return;
      const coords = getTrackDisplayCoords(track);
      for (let i = 0; i < coords.length; i++) {
        latlngs.push([coords[i][1], coords[i][0]]);
      }
    });
    fitLatLngs(latlngs, animate);
  }

  function fitToMerged() {
    if (!state.merged || !map) return;
    const stats = state.merged.stats;
    if (stats && Array.isArray(stats.bbox) && stats.bbox.length === 4 &&
      stats.bbox.every(function (v) { return Number.isFinite(v); })) {
      const a = wgsToDisplay(stats.bbox[0], stats.bbox[1], state.displayCrs);
      const b = wgsToDisplay(stats.bbox[2], stats.bbox[3], state.displayCrs);
      const bounds = L.latLngBounds([a[1], a[0]], [b[1], b[0]]);
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [56, 56], maxZoom: 16, animate: true });
        return;
      }
    }
    const latlngs = [];
    (state.merged.tracks || []).forEach(function (track) {
      const coords = getMergedDisplayCoords(track);
      for (let i = 0; i < coords.length; i++) {
        if (coords[i]) latlngs.push([coords[i][1], coords[i][0]]);
      }
    });
    fitLatLngs(latlngs, true);
  }

  function focusTrack(uid) {
    const track = findTrack(uid);
    if (!track || !map) return;
    state.focusedUid = uid;
    renderTracks();
    redrawMap();
    const coords = getTrackDisplayCoords(track);
    const latlngs = coords.map(function (p) { return [p[1], p[0]]; });
    fitLatLngs(latlngs, true);
    if (isMobile()) closeSidebar();
  }

  function centerDefaultView() {
    if (!map) return;
    const display = wgsToDisplay(DEFAULT_CENTER_WGS[0], DEFAULT_CENTER_WGS[1], state.displayCrs);
    map.setView([display[1], display[0]], DEFAULT_ZOOM, { animate: false });
  }

  /* ------------------------------------------------------------------
   * 侧栏渲染
   * ------------------------------------------------------------------ */

  function buildTrackCard(track) {
    const data = track.data || {};
    const card = el('div', 'track-card');
    card.dataset.uid = track.uid;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', '定位到轨迹 ' + trackTitle(track));
    if (!track.visible) card.classList.add('is-hidden-track');
    if (state.focusedUid === track.uid) card.classList.add('is-focused');
    if (track.reparsing) card.classList.add('is-reparsing');

    const row1 = el('div', 'track-row');
    const dot = el('span', 'track-dot');
    dot.style.background = track.color;
    dot.setAttribute('aria-hidden', 'true');

    const info = el('div', 'track-info');
    const nameRow = el('div', 'track-name-row');
    const name = el('div', 'track-name', trackTitle(track));
    name.title = trackTitle(track);
    const formatLabel = data.format_label || (data.format ? String(data.format).toUpperCase() : '轨迹');
    const formatBadge = el('span', 'format-badge', formatLabel);
    nameRow.appendChild(name);
    nameRow.appendChild(formatBadge);
    const meta = el('div', 'track-meta');
    meta.textContent = fmtInt(data.point_count) + ' 点 · ' + fmtKm(data.distance_m) +
      (data.crs_detected && CRS_LABELS[data.crs_detected] ? ' · 源 ' + CRS_LABELS[data.crs_detected] : '');
    info.appendChild(nameRow);
    info.appendChild(meta);

    const actions = el('div', 'track-actions');
    const eye = el('button', 'icon-btn');
    eye.type = 'button';
    eye.dataset.action = 'toggle-visible';
    eye.title = track.visible ? '隐藏轨迹' : '显示轨迹';
    eye.setAttribute('aria-label', track.visible ? '隐藏轨迹' : '显示轨迹');
    eye.setAttribute('aria-pressed', String(track.visible));
    eye.innerHTML = track.visible ? ICONS.eye : ICONS.eyeOff;
    const remove = el('button', 'icon-btn');
    remove.type = 'button';
    remove.dataset.action = 'delete';
    remove.title = '删除轨迹';
    remove.setAttribute('aria-label', '删除轨迹');
    remove.innerHTML = ICONS.trash;
    actions.appendChild(eye);
    actions.appendChild(remove);
    row1.appendChild(dot);
    row1.appendChild(info);
    row1.appendChild(actions);

    const row2 = el('div', 'track-row2');
    const crsField = el('label', 'crs-field');
    crsField.appendChild(el('span', 'crs-label', '坐标系'));
    const select = el('select', 'select select-sm track-crs');
    select.dataset.action = 'crs';
    select.title = '修改后会使用原始文件重新解析该轨迹';
    CRS_SELECT_OPTIONS.forEach(function (option) {
      const node = el('option', null, option.label);
      node.value = option.id;
      select.appendChild(node);
    });
    select.value = track.crsMode || 'auto';
    if (track.reparsing) select.disabled = true;
    crsField.appendChild(select);
    row2.appendChild(crsField);
    row2.appendChild(el('span', 'crs-note', track.reparsing ? '重新解析中…' : '已统一 WGS-84'));

    card.appendChild(row1);
    card.appendChild(row2);

    if (Array.isArray(data.warnings) && data.warnings.length) {
      const warn = el('div', 'track-warn');
      warn.textContent = '⚠ ' + data.warnings.length + ' 条提示：' + data.warnings[0];
      warn.title = data.warnings.join('\n');
      card.appendChild(warn);
    }

    if (track.reparsing) {
      const overlay = el('div', 'track-overlay');
      overlay.appendChild(el('span', 'spinner'));
      overlay.appendChild(el('span', null, '重新解析中…'));
      card.appendChild(overlay);
    }

    return card;
  }

  function renderTracks() {
    if (!dom.trackList) return;
    const scrollTop = dom.trackList.scrollTop;
    clear(dom.trackList);
    state.tracks.forEach(function (track) {
      dom.trackList.appendChild(buildTrackCard(track));
    });
    dom.trackCount.textContent = String(state.tracks.length);
    dom.trackEmpty.hidden = state.tracks.length > 0;
    dom.trackList.scrollTop = scrollTop;
    updateDockExportVisibility();
  }

  function statCard(label, value, unit, options) {
    const opts = options || {};
    const card = el('div', 'stat-card' + (opts.wide ? ' is-wide' : ''));
    if (opts.title) card.title = opts.title;
    card.appendChild(el('span', 'stat-label', label));
    const valueNode = el('span', 'stat-value', value);
    if (unit) valueNode.appendChild(el('span', 'stat-unit', unit));
    card.appendChild(valueNode);
    return card;
  }

  function renderStats(stats) {
    if (!dom.statsStrip) return;
    clear(dom.statsStrip);
    if (!stats) {
      const placeholders = [
        ['轨迹数', '—', '条'],
        ['合并段数', '—', '段'],
        ['总里程', '—', 'km'],
        ['总时长', '—', ''],
        ['平均速度', '—', 'km/h'],
        ['最高速度', '—', 'km/h'],
        ['点数', '—', '点'],
        ['时间范围', '—', '']
      ];
      placeholders.forEach(function (item) {
        dom.statsStrip.appendChild(statCard(item[0], item[1], item[2], { wide: item[0] === '时间范围' }));
      });
      return;
    }
    dom.statsStrip.appendChild(statCard('轨迹数', fmtInt(stats.track_count), '条'));
    dom.statsStrip.appendChild(statCard('合并段数', fmtInt(stats.segment_count), '段'));
    dom.statsStrip.appendChild(statCard('总里程', fmtNum(stats.distance_m / 1000, 2), 'km'));
    dom.statsStrip.appendChild(statCard('总时长', fmtDuration(stats.duration_s), '', {
      title: '移动时长：' + fmtDuration(stats.moving_duration_s)
    }));
    dom.statsStrip.appendChild(statCard('平均速度', fmtNum(stats.avg_speed_kmh, 1), 'km/h'));
    dom.statsStrip.appendChild(statCard('最高速度', fmtNum(stats.max_speed_kmh, 1), 'km/h'));
    dom.statsStrip.appendChild(statCard('点数', fmtInt(stats.point_count), '点'));
    dom.statsStrip.appendChild(statCard(
      '时间范围',
      fmtTimeRangeCompact(stats.time_start, stats.time_end),
      '',
      {
        wide: true,
        title: '开始 ~ 结束（本地时间）：' + fmtTimeRange(stats.time_start, stats.time_end)
      }
    ));
  }

  function renderSamples() {
    if (!dom.samplesList) return;
    clear(dom.samplesList);
    if (dom.samplesCount) {
      dom.samplesCount.textContent = state.samples.length ? '（' + state.samples.length + '）' : '';
    }
    if (!state.samples.length) {
      dom.samplesList.appendChild(el('div', 'samples-empty', '暂无示例文件'));
      return;
    }
    state.samples.forEach(function (sample) {
      const chip = el('button', 'sample-chip');
      chip.type = 'button';
      chip.title = sample.name +
        (sample.format ? ' · ' + sample.format : '') +
        (sample.crs && CRS_LABELS[sample.crs] ? ' · ' + CRS_LABELS[sample.crs] : '');
      chip.appendChild(el('span', 'sample-name', sample.name || '示例'));
      if (sample.format) chip.appendChild(el('span', 'sample-badge', String(sample.format).toUpperCase()));
      chip.addEventListener('click', function () {
        importSample(sample, chip);
      });
      dom.samplesList.appendChild(chip);
    });
  }

  function updateExportHint() {
    if (!dom.exportHint) return;
    if (state.merged) {
      dom.exportHint.textContent = '将导出合并结果（' + state.merged.tracks.length + ' 条轨迹）。';
    } else {
      dom.exportHint.textContent = '尚未合并：将导出当前显示的所有轨迹。';
    }
  }

  function updateChartTabs() {
    if (!dom.chartTabs) return;
    const series = state.chartSeries;
    const hasEle = !!(series && series.hasEle);
    const hasSpeed = !!(series && series.hasSpeed);
    const eleBtn = dom.chartTabs.querySelector('[data-chart-mode="ele"]');
    const speedBtn = dom.chartTabs.querySelector('[data-chart-mode="speed"]');
    if (!eleBtn || !speedBtn) return;
    eleBtn.disabled = !hasEle;
    speedBtn.disabled = !hasSpeed;
    eleBtn.title = hasEle ? '显示海拔剖面' : '该轨迹没有海拔数据';
    speedBtn.title = hasSpeed ? '显示速度剖面' : '该轨迹没有速度数据';
    eleBtn.classList.toggle('is-active', state.chartMode === 'ele');
    speedBtn.classList.toggle('is-active', state.chartMode === 'speed');
  }

  /* ------------------------------------------------------------------
   * 合并结果失效 / 状态切换
   * ------------------------------------------------------------------ */

  function invalidateMerge() {
    const hadMerged = !!state.merged;
    if (!hadMerged && !state.chartSeries) return;
    state.merged = null;
    state.chartSeries = null;
    state.chartLayout = null;
    state.chartHover = null;
    if (dom.chartPanel) dom.chartPanel.hidden = true;
    if (dom.btnToggleChart) dom.btnToggleChart.hidden = true;
    if (dom.mergedBadge) dom.mergedBadge.hidden = true;
    if (dom.btnSaveMergedToLibrary) dom.btnSaveMergedToLibrary.hidden = true;
    if (dom.dockHint) dom.dockHint.textContent = hadMerged ? '轨迹已变化，请重新合并' : '合并后自动更新';
    hideChartTooltip();
    renderStats(null);
    updateExportHint();
    updateChartTabs();
    updateDockExportVisibility();
    redrawMap();
  }

  function setUploadBusy(busy) {
    state.busy.upload = busy;
    if (dom.uploadZone) dom.uploadZone.classList.toggle('is-busy', busy);
    if (dom.fileInput) dom.fileInput.disabled = busy;
    if (dom.uploadProgress) dom.uploadProgress.hidden = !busy;
    if (dom.btnSamples) dom.btnSamples.disabled = busy;
    if (dom.btnSampleList) dom.btnSampleList.disabled = busy;
    if (dom.btnEmptySamples) dom.btnEmptySamples.disabled = busy;
    if (dom.samplesList) {
      const chips = dom.samplesList.querySelectorAll('.sample-chip');
      for (let i = 0; i < chips.length; i++) chips[i].disabled = busy;
    }
  }

  function setProgress(text) {
    if (dom.uploadProgressText) dom.uploadProgressText.textContent = text;
  }

  function setMergeBusy(busy) {
    state.busy.merge = busy;
    if (!dom.btnMerge) return;
    dom.btnMerge.disabled = busy;
    const spinner = dom.btnMerge.querySelector('.spinner');
    if (spinner) spinner.hidden = !busy;
    dom.btnMergeText.textContent = busy ? '合并中…' : '合并轨迹';
  }

  function setExportBusy(busy) {
    state.busy.export = busy;
    if (!dom.btnExport) return;
    dom.btnExport.disabled = busy;
    const spinner = dom.btnExport.querySelector('.spinner');
    if (spinner) spinner.hidden = !busy;
    dom.btnExportText.textContent = busy ? '导出中…' : '下载';
  }

  /* ------------------------------------------------------------------
   * 参数读取
   * ------------------------------------------------------------------ */

  function numInput(node, fallback) {
    if (!node) return fallback;
    const value = parseFloat(node.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function readMergeOptions() {
    const separate = dom.optMode.value === 'separate';
    return {
      mode: separate ? 'separate' : 'single',
      sort_by_time: !!dom.optSortTime.checked,
      join_tracks: !!dom.optJoinTracks.checked,
      gap_seconds: Math.max(0, numInput(dom.optGap, 10)) * 60,
      dedupe_meters: Math.max(0, numInput(dom.optDedupe, 1)),
      simplify_meters: Math.max(0, numInput(dom.optSimplify, 0)),
      max_speed_kmh: Math.max(0, numInput(dom.optMaxSpeed, 0))
    };
  }

  function syncMergeOptionState() {
    const separate = dom.optMode.value === 'separate';
    dom.optJoinTracks.disabled = separate;
    dom.optGap.disabled = separate;
    const joinRow = dom.optJoinTracks.closest('.switch-row');
    if (joinRow) joinRow.classList.toggle('is-disabled', separate);
  }

  function updateAdvancedSummary() {
    if (!dom.advancedSummary) return;
    const gap = Math.max(0, numInput(dom.optGap, 10));
    const dedupe = Math.max(0, numInput(dom.optDedupe, 1));
    const simplify = Math.max(0, numInput(dom.optSimplify, 0));
    const maxSpeed = Math.max(0, numInput(dom.optMaxSpeed, 0));
    const compact = function (value) {
      return String(Math.round(value * 10) / 10);
    };
    dom.advancedSummary.textContent =
      '去重 ' + compact(dedupe) + ' m · 分段 ' + compact(gap) + ' 分 · 抽稀 ' +
      (simplify > 0 ? compact(simplify) + ' m' : '关') +
      ' · 限速 ' + (maxSpeed > 0 ? compact(maxSpeed) + ' km/h' : '关');
  }

  function toggleAdvanced(force) {
    if (!dom.btnAdvanced || !dom.advancedBody) return;
    const expanded = typeof force === 'boolean' ? force : dom.advancedBody.hidden;
    dom.advancedBody.hidden = !expanded;
    dom.btnAdvanced.setAttribute('aria-expanded', String(expanded));
    dom.btnAdvanced.classList.toggle('is-open', expanded);
    updateAdvancedSummary();
  }

  /** 把合并参数重置为默认值（演示模式 / 一键示例使用） */
  function applyDefaultMergeInputs() {
    if (!dom.optMode) return;
    dom.optMode.value = 'single';
    dom.optSortTime.checked = true;
    dom.optJoinTracks.checked = true;
    dom.optGap.value = '10';
    dom.optDedupe.value = '1';
    dom.optSimplify.value = '0';
    dom.optMaxSpeed.value = '0';
    syncMergeOptionState();
    updateAdvancedSummary();
  }

  function updateDockExportVisibility() {
    if (!dom.btnDockExport) return;
    const visible = !(state.tracks.length === 0 && !state.merged);
    dom.btnDockExport.hidden = !visible;
    if (!visible) return;
    let formatLabel = 'GPX';
    if (dom.expFormat && dom.expFormat.options.length) {
      const option = dom.expFormat.options[dom.expFormat.selectedIndex];
      if (option && option.textContent) {
        formatLabel = option.textContent.replace(/（.*$/, '').trim() || formatLabel;
      }
    }
    const crsValue = (dom.expCrs && dom.expCrs.value) ? dom.expCrs.value : 'WGS84';
    const crsLabel = CRS_LABELS[crsValue] || crsValue;
    dom.btnDockExport.title = '按当前导出设置直接下载（' + formatLabel + ' · ' + crsLabel + '）；可在侧栏导出面板调整格式';
  }

  /** 统计栏里的「导出」是下载快捷入口：直接用当前格式/坐标系下载；侧栏导出面板可调整设置。 */

  /* ------------------------------------------------------------------
   * 剖面图数据
   * ------------------------------------------------------------------ */

  function buildChartSeries() {
    const merged = state.merged;
    if (!merged || !merged.tracks || !merged.tracks.length) {
      return { samples: [], hasEle: false, hasSpeed: false, totalDistance: 0, pointCount: 0 };
    }
    const raw = [];
    let distance = 0;
    let hasEle = false;
    let hasSpeed = false;
    merged.tracks.forEach(function (track) {
      const points = Array.isArray(track.points) ? track.points : [];
      const segments = Array.isArray(track.segments) && track.segments.length
        ? track.segments.slice().sort(function (a, b) { return a - b; })
        : [0];
      const segStarts = {};
      segments.forEach(function (index) { segStarts[index] = true; });
      let prev = null;
      let prevTime = null;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!Array.isArray(p)) continue;
        const ele = Number.isFinite(p[2]) ? p[2] : null;
        let speed = Number.isFinite(p[3]) ? p[3] : null;
        const time = Number.isFinite(p[4]) ? p[4] : null;
        const newSegment = i > 0 && !!segStarts[i];
        if (prev && !newSegment) distance += haversine(prev, p);
        if (speed === null && prev && !newSegment && time !== null && prevTime !== null && time > prevTime) {
          const dt = time - prevTime;
          if (dt > 0.001) speed = haversine(prev, p) / dt;
        }
        if (ele !== null) hasEle = true;
        if (speed !== null) hasSpeed = true;
        raw.push({ d: distance, ele: ele, speed: speed, t: time });
        prev = p;
        prevTime = time;
      }
    });

    let samples = raw;
    if (raw.length > MAX_CHART_SAMPLES) {
      const stride = raw.length / MAX_CHART_SAMPLES;
      samples = [];
      for (let i = 0; i < MAX_CHART_SAMPLES; i++) {
        samples.push(raw[Math.floor(i * stride)]);
      }
      if (samples[samples.length - 1] !== raw[raw.length - 1]) {
        samples.push(raw[raw.length - 1]);
      }
    }

    return {
      samples: samples,
      hasEle: hasEle,
      hasSpeed: hasSpeed,
      totalDistance: distance,
      pointCount: raw.length
    };
  }

  function chartValueOf(sample, mode) {
    if (!sample) return null;
    if (mode === 'ele') return sample.ele;
    if (sample.speed === null || sample.speed === undefined) return null;
    return sample.speed * 3.6;
  }

  function chartSubText() {
    const series = state.chartSeries;
    if (!series) return '';
    const parts = [];
    const stats = state.merged && state.merged.stats;
    if (stats && Number.isFinite(stats.segment_count)) parts.push(fmtInt(stats.segment_count) + ' 段');
    parts.push(fmtKm(series.totalDistance));
    parts.push(fmtInt(series.pointCount) + ' 点');
    return parts.join(' · ');
  }

  function setChartEmpty(message) {
    if (!dom.chartEmpty) return;
    if (!message) {
      dom.chartEmpty.hidden = true;
      return;
    }
    dom.chartEmpty.textContent = message;
    dom.chartEmpty.hidden = false;
  }

  function hideChartTooltip() {
    if (dom.chartTip) dom.chartTip.hidden = true;
  }

  function updateChartTooltip(hover) {
    if (!dom.chartTip || !dom.chartWrap) return;
    clear(dom.chartTip);
    dom.chartTip.appendChild(el('span', 'tip-dist', '距离 ' + fmtAxisDistance(hover.d)));
    if (state.chartMode === 'ele') {
      dom.chartTip.appendChild(el('span', 'tip-val', '海拔 ' + Math.round(hover.v) + ' m'));
    } else {
      dom.chartTip.appendChild(el('span', 'tip-val', '速度 ' + hover.v.toFixed(1) + ' km/h'));
    }
    if (Number.isFinite(hover.t)) {
      dom.chartTip.appendChild(el('span', 'tip-time', fmtDateTime(hover.t)));
    }
    dom.chartTip.hidden = false;
    const width = dom.chartWrap.clientWidth || 0;
    const left = clamp(hover.x, 60, Math.max(60, width - 60));
    const top = hover.y - 12;
    dom.chartTip.style.left = left + 'px';
    dom.chartTip.style.top = top + 'px';
    dom.chartTip.style.transform = top < 64 ? 'translate(-50%, 10px)' : 'translate(-50%, -100%)';
  }

  function renderChart(hoverIndex) {
    if (!dom.chartCanvas || !dom.chartWrap || !dom.chartPanel) return;
    if (dom.chartPanel.hidden) return;
    const series = state.chartSeries;
    const wrap = dom.chartWrap;
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    const canvas = dom.chartCanvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(rect.width * dpr);
    const ch = Math.round(rect.height * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (!series || !series.samples.length) {
      state.chartLayout = null;
      setChartEmpty('暂无剖面数据');
      hideChartTooltip();
      return;
    }

    const mode = state.chartMode;
    const valueOf = function (sample) { return chartValueOf(sample, mode); };
    const valid = series.samples.filter(function (sample) { return valueOf(sample) !== null; });
    if (!valid.length) {
      state.chartLayout = null;
      setChartEmpty(mode === 'ele' ? '该轨迹没有海拔数据' : '该轨迹没有速度数据');
      hideChartTooltip();
      return;
    }
    setChartEmpty('');

    const W = rect.width;
    const H = rect.height;
    const margin = { l: 46, r: 16, t: 14, b: 24 };
    const plotW = Math.max(10, W - margin.l - margin.r);
    const plotH = Math.max(10, H - margin.t - margin.b);
    const samples = series.samples;

    let minD = samples[0].d;
    let maxD = samples[samples.length - 1].d;
    if (!(maxD > minD)) maxD = minD + 1;

    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < valid.length; i++) {
      const value = valueOf(valid[i]);
      if (value < minV) minV = value;
      if (value > maxV) maxV = value;
    }
    if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
      setChartEmpty('暂无剖面数据');
      return;
    }
    if (maxV - minV < 1e-9) {
      const pad = Math.max(1, Math.abs(maxV) * 0.08);
      minV -= pad;
      maxV += pad;
    } else {
      const pad = (maxV - minV) * 0.12;
      minV -= pad;
      maxV += pad;
    }
    if (mode === 'speed' && minV < 0) minV = 0;

    const xOf = function (d) {
      return margin.l + ((d - minD) / (maxD - minD)) * plotW;
    };
    const yOf = function (v) {
      return margin.t + (1 - (v - minV) / (maxV - minV)) * plotH;
    };

    ctx.font = '11px -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'middle';

    // 横向网格与纵轴刻度
    const rows = 4;
    const valueRange = maxV - minV;
    const yDecimals = mode === 'ele' ? (valueRange < 5 ? 1 : 0) : 1;
    for (let i = 0; i <= rows; i++) {
      const y = margin.t + (plotH * i) / rows;
      ctx.strokeStyle = i === rows ? '#dbe3ec' : '#eef2f7';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(margin.l, y + 0.5);
      ctx.lineTo(margin.l + plotW, y + 0.5);
      ctx.stroke();
      const value = maxV - (valueRange * i) / rows;
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'right';
      ctx.fillText(fmtNum(value, yDecimals), margin.l - 8, y);
    }

    // 横轴刻度（距离）
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const d = minD + ((maxD - minD) * i) / 4;
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      const x = i === 0 ? margin.l : i === 4 ? margin.l + plotW : xOf(d);
      ctx.fillText(fmtAxisDistance(d), x, margin.t + plotH + 7);
    }

    // 有效数据分段
    const runs = [];
    let run = null;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const value = valueOf(sample);
      if (value === null) {
        if (run) {
          runs.push(run);
          run = null;
        }
        continue;
      }
      if (!run) run = [];
      run.push({ x: xOf(sample.d), y: yOf(value), d: sample.d, v: value, t: sample.t, idx: i });
    }
    if (run) runs.push(run);

    const accent = mode === 'ele' ? '#0ea5e9' : '#f97316';
    const bottom = margin.t + plotH;
    const gradient = ctx.createLinearGradient(0, margin.t, 0, bottom);
    gradient.addColorStop(0, hexToRgba(accent, 0.28));
    gradient.addColorStop(1, hexToRgba(accent, 0.02));

    runs.forEach(function (points) {
      if (points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(points[0].x, bottom);
      for (let i = 0; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.lineTo(points[points.length - 1].x, bottom);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    });

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    runs.forEach(function (points) {
      if (!points.length) return;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    });

    state.chartLayout = {
      margin: margin,
      plotW: plotW,
      plotH: plotH,
      minD: minD,
      maxD: maxD,
      xOf: xOf,
      yOf: yOf,
      mode: mode,
      hover: null
    };

    // 悬停十字线与数值
    if (typeof hoverIndex === 'number' && hoverIndex >= 0 && hoverIndex < samples.length) {
      const sample = samples[hoverIndex];
      const value = valueOf(sample);
      const x = xOf(sample.d);
      ctx.save();
      ctx.strokeStyle = 'rgba(14,165,233,0.45)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, margin.t);
      ctx.lineTo(x + 0.5, bottom);
      ctx.stroke();
      ctx.restore();
      if (value !== null) {
        const y = yOf(value);
        state.chartLayout.hover = {
          x: x, y: y, d: sample.d, v: value, t: sample.t, idx: hoverIndex
        };
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = accent;
        ctx.stroke();
        updateChartTooltip(state.chartLayout.hover);
      } else {
        hideChartTooltip();
      }
    } else {
      hideChartTooltip();
    }
  }

  function scheduleChartRender(index) {
    state.chartHover = typeof index === 'number' && index >= 0 ? index : null;
    if (chartRaf) return;
    chartRaf = window.requestAnimationFrame(function () {
      chartRaf = 0;
      renderChart(state.chartHover);
    });
  }

  function nearestSampleIndex(samples, distance) {
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].d < distance) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(samples[lo - 1].d - distance) < Math.abs(samples[lo].d - distance)) {
      return lo - 1;
    }
    return lo;
  }

  function onChartMouseMove(ev) {
    if (!dom.chartCanvas || dom.chartPanel.hidden) return;
    const series = state.chartSeries;
    const layout = state.chartLayout;
    if (!series || !series.samples.length || !layout) return;
    const rect = dom.chartCanvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    if (x < layout.margin.l - 6 || x > layout.margin.l + layout.plotW + 6) {
      scheduleChartRender(null);
      return;
    }
    const fraction = clamp((x - layout.margin.l) / layout.plotW, 0, 1);
    const distance = layout.minD + fraction * (layout.maxD - layout.minD);
    scheduleChartRender(nearestSampleIndex(series.samples, distance));
  }

  function onChartMouseLeave() {
    scheduleChartRender(null);
  }

  function setChartMode(mode) {
    state.chartMode = mode === 'speed' ? 'speed' : 'ele';
    updateChartTabs();
    hideChartTooltip();
    renderChart(null);
  }

  function toggleChart(forceHide) {
    if (!dom.chartPanel) return;
    const shouldHide = typeof forceHide === 'boolean' ? forceHide : !dom.chartPanel.hidden;
    dom.chartPanel.hidden = shouldHide;
    if (shouldHide) {
      hideChartTooltip();
    }
    if (dom.btnToggleChart) dom.btnToggleChart.textContent = shouldHide ? '展开剖面' : '收起剖面';
    if (!shouldHide) {
      window.requestAnimationFrame(function () {
        renderChart(state.chartHover);
      });
    }
  }

  /* ------------------------------------------------------------------
   * 文件导入
   * ------------------------------------------------------------------ */

  async function importLoop(files, options) {
    const settings = options || {};
    let imported = 0;
    let failed = 0;
    const createdTracks = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setProgress('解析中 ' + (i + 1) + '/' + files.length + '：' + file.name);
      try {
        const data = await parseFiles([file], 'auto');
        const tracks = Array.isArray(data.tracks) ? data.tracks : [];
        const errors = Array.isArray(data.errors) ? data.errors : [];
        if (!tracks.length) {
          failed += 1;
          const message = (errors[0] && errors[0].error) || '未识别到轨迹点';
          toast('「' + file.name + '」导入失败：' + message, 'error', 6500);
          continue;
        }
        const created = addTracksFromParse(tracks, file);
        for (let k = 0; k < created.length; k++) createdTracks.push(created[k]);
        imported += tracks.length;
        errors.forEach(function (err) {
          toast('「' + (err.filename || file.name) + '」：' + (err.error || '解析失败'), 'error', 6500);
        });
      } catch (err) {
        failed += 1;
        toast('「' + file.name + '」导入失败：' + friendlyError(err), 'error', 6500);
      }
    }
    if (imported) {
      invalidateMerge();
      renderTracks();
      redrawMap();
      updateExportHint();
      updateDockExportVisibility();
      fitToVisibleTracks(true);
      if (!settings.quiet) {
        toast('已导入 ' + imported + ' 条轨迹' + (failed ? '，' + failed + ' 个文件失败' : ''), 'success', 3200);
        maybeShowWgs84Hint();
      }
      if (!settings.skipLibrary && state.autoSave && createdTracks.length) {
        saveTracksToLibrary(createdTracks, { auto: true });
      }
    }
  }

  async function handleFiles(fileList) {
    const files = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (!file || !file.name) continue;
      if (file.size === 0) {
        toast('「' + file.name + '」是空文件，已跳过', 'error');
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        toast('「' + file.name + '」超过 32MB 限制，已跳过', 'error');
        continue;
      }
      files.push(file);
    }
    if (!files.length) return;
    if (state.busy.upload) {
      toast('正在导入，请稍候…', 'info');
      return;
    }
    setUploadBusy(true);
    try {
      await importLoop(files);
    } catch (err) {
      toast('导入失败：' + friendlyError(err), 'error', 6500);
    } finally {
      setUploadBusy(false);
    }
  }

  function fetchAsFile(sample) {
    if (!sample || !sample.url) return Promise.reject(new Error('示例缺少下载地址'));
    return fetch(sample.url, { cache: 'no-store' }).then(function (resp) {
      if (!resp.ok) throw new Error('下载失败（HTTP ' + resp.status + '）');
      return resp.blob();
    }).then(function (blob) {
      let name = sample.name;
      if (!name) {
        try {
          name = decodeURIComponent((sample.url.split('/').pop() || 'sample'));
        } catch (e) {
          name = 'sample';
        }
      }
      return new File([blob], name, { type: blob.type || 'application/octet-stream' });
    });
  }

  async function ensureSamples() {
    if (state.samplesLoaded) return state.samples;
    try {
      const data = await apiJson('/api/samples');
      state.samples = Array.isArray(data.files) ? data.files : [];
      state.samplesLoaded = true;
    } catch (err) {
      state.samples = [];
      toast('示例列表加载失败：' + friendlyError(err), 'error', 5000);
    }
    renderSamples();
    return state.samples;
  }

  async function onSampleListButtonClick() {
    const willOpen = dom.samplesBox.hidden;
    dom.samplesBox.hidden = !willOpen;
    if (!willOpen) return;
    const samples = await ensureSamples();
    if (!samples.length) toast('暂无示例数据，请先上传自己的轨迹文件', 'info');
  }

  async function importSample(sample, chip) {
    if (state.busy.upload) {
      toast('正在导入，请稍候…', 'info');
      return;
    }
    setUploadBusy(true);
    setProgress('正在下载示例：' + (sample.name || ''));
    try {
      const file = await fetchAsFile(sample);
      await importLoop([file]);
    } catch (err) {
      toast('示例导入失败：' + friendlyError(err), 'error', 6500);
    } finally {
      setUploadBusy(false);
      if (chip) chip.disabled = false;
    }
  }

  async function importAllSamples() {
    if (state.busy.upload) {
      toast('正在导入，请稍候…', 'info');
      return;
    }
    setUploadBusy(true);
    try {
      setProgress('正在加载示例列表…');
      const samples = await ensureSamples();
      if (!samples.length) {
        toast('暂无示例数据，请上传自己的轨迹文件', 'info');
        return;
      }
      const files = [];
      for (let i = 0; i < samples.length; i++) {
        setProgress('正在下载示例 ' + (i + 1) + '/' + samples.length + '：' + (samples[i].name || ''));
        try {
          files.push(await fetchAsFile(samples[i]));
        } catch (err) {
          toast('示例「' + samples[i].name + '」下载失败：' + friendlyError(err), 'error', 5000);
        }
      }
      if (files.length) await importLoop(files);
    } catch (err) {
      toast('加载示例失败：' + friendlyError(err), 'error', 6000);
    } finally {
      setUploadBusy(false);
    }
  }

  /* ------------------------------------------------------------------
   * 演示模式（?demo=1 自动执行 / 「示例数据」按钮手动执行）
   * ------------------------------------------------------------------ */

  function isDemoRequested() {
    try {
      const params = new URLSearchParams(window.location.search);
      const value = params.get('demo');
      if (value === null) return false;
      const normalized = String(value).toLowerCase();
      return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'off';
    } catch (e) {
      return false;
    }
  }

  /** ?panel=open / ?panel=1：窄屏下自动展开侧栏抽屉（用于分享与截图） */
  function isPanelRequested() {
    try {
      const params = new URLSearchParams(window.location.search);
      const value = params.get('panel');
      if (value === null) return false;
      const normalized = String(value).toLowerCase();
      return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'off';
    } catch (e) {
      return false;
    }
  }

  /** 从示例列表中挑选百度、高德、GPX、KML 四类；不足时用其它示例补齐 */
  function pickDemoSamples(samples) {
    const list = Array.isArray(samples) ? samples : [];
    const used = {};
    const picked = [];
    DEMO_SAMPLE_KEYS.forEach(function (keys) {
      for (let i = 0; i < list.length; i++) {
        if (used[i]) continue;
        const sample = list[i];
        if (!sample) continue;
        const haystack = ((sample.format || '') + ' ' + (sample.name || '') + ' ' + (sample.url || '')).toLowerCase();
        let matched = false;
        for (let k = 0; k < keys.length; k++) {
          if (haystack.indexOf(keys[k]) >= 0) {
            matched = true;
            break;
          }
        }
        if (!matched) continue;
        used[i] = true;
        picked.push(sample);
        break;
      }
    });
    for (let i = 0; i < list.length && picked.length < DEMO_MAX_SAMPLES; i++) {
      if (!used[i] && list[i]) {
        used[i] = true;
        picked.push(list[i]);
      }
    }
    return picked;
  }

  function showDemoOverlay(text) {
    if (!dom.demoOverlay) return;
    dom.demoOverlay.hidden = false;
    updateDemoOverlay(text || '正在准备示例数据…');
  }

  function updateDemoOverlay(text) {
    if (dom.demoOverlayText) dom.demoOverlayText.textContent = text || '';
  }

  function hideDemoOverlay() {
    if (dom.demoOverlay) dom.demoOverlay.hidden = true;
  }

  async function runDemo(options) {
    const settings = options || {};
    if (state.demoRunning) return;
    if (state.busy.upload || state.busy.merge) {
      toast('请等待当前操作完成后再试', 'info');
      return;
    }
    state.demoRunning = true;
    showDemoOverlay('正在加载示例列表…');
    let importedAny = false;
    try {
      setUploadBusy(true);
      setProgress('演示模式：加载示例列表…');
      const samples = await ensureSamples();
      const picked = pickDemoSamples(samples);
      if (!picked.length) throw new Error('没有可用的示例文件');
      const files = [];
      for (let i = 0; i < picked.length; i++) {
        const sample = picked[i];
        updateDemoOverlay('正在下载示例 ' + (i + 1) + '/' + picked.length + '：' + (sample.name || ''));
        setProgress('演示模式：下载 ' + (i + 1) + '/' + picked.length + '…');
        try {
          files.push(await fetchAsFile(sample));
        } catch (err) {
          toast('示例「' + (sample.name || '') + '」下载失败：' + friendlyError(err), 'error', 5000);
        }
      }
      if (!files.length) throw new Error('示例文件下载失败');
      updateDemoOverlay('正在解析示例轨迹…');
      setProgress('演示模式：解析轨迹…');
      await importLoop(files, { quiet: true, skipLibrary: true });
      importedAny = visibleTracksWithPoints().length > 0;
      if (!importedAny) throw new Error('示例轨迹解析失败');
    } catch (err) {
      toast('演示模式加载失败：' + friendlyError(err), 'error', 7000);
    } finally {
      setUploadBusy(false);
    }
    if (importedAny) {
      try {
        updateDemoOverlay('正在自动合并示例轨迹…');
        setProgress('演示模式：自动合并…');
        applyDefaultMergeInputs();
        const merged = await performMerge(null, { demo: true, quietSuccess: true });
        if (merged && !settings.silentSuccess) {
          toast('演示模式：已加载示例轨迹并自动合并', 'success', 4800);
        }
      } catch (err) {
        toast('演示模式合并失败：' + friendlyError(err), 'error', 7000);
      } finally {
        hideDemoOverlay();
        state.demoRunning = false;
      }
    } else {
      hideDemoOverlay();
      state.demoRunning = false;
    }
    updateDockExportVisibility();
    // 带 ?panel=open 时，窄屏在演示完成后再展开抽屉（避免演示过程遮住 loading）
    if (state.panelRequested) {
      openSidebar();
    }
  }

  /* ------------------------------------------------------------------
   * 轨迹操作
   * ------------------------------------------------------------------ */

  function toggleTrackVisibility(uid) {
    const track = findTrack(uid);
    if (!track) return;
    track.visible = !track.visible;
    if (!track.visible && state.focusedUid === uid) state.focusedUid = null;
    invalidateMerge();
    renderTracks();
    redrawMap();
    updateExportHint();
  }

  function deleteTrack(uid) {
    const track = findTrack(uid);
    if (!track) return;
    state.tracks = state.tracks.filter(function (item) { return item.uid !== uid; });
    if (state.focusedUid === uid) state.focusedUid = null;
    invalidateMerge();
    renderTracks();
    redrawMap();
    updateExportHint();
    toast('已删除轨迹「' + trackTitle(track) + '」', 'info', 2600);
  }

  async function reparseTrack(uid, crsMode) {
    const track = findTrack(uid);
    if (!track) return;
    if (!track.file || typeof track.file.name !== 'string') {
      toast('缺少原始文件，无法重新解析；请重新上传该文件', 'error');
      renderTracks();
      return;
    }
    const gid = track.gid;
    const groupTracks = state.tracks.filter(function (item) { return item.gid === gid; });
    groupTracks.forEach(function (item) { item.reparsing = true; });
    renderTracks();
    try {
      const data = await parseFiles([track.file], crsMode || 'auto');
      const parsed = Array.isArray(data.tracks) ? data.tracks : [];
      if (!parsed.length) {
        const errors = Array.isArray(data.errors) ? data.errors : [];
        throw new Error((errors[0] && errors[0].error) || '未返回轨迹数据');
      }
      replaceGroupTracks(gid, parsed);
      invalidateMerge();
      renderTracks();
      redrawMap();
      updateExportHint();
      const label = (!crsMode || crsMode === 'auto') ? '自动识别' : (CRS_LABELS[crsMode] || crsMode);
      toast('已按「' + label + '」重新解析：' + (trackTitle({ data: parsed[0] }) || track.file.name), 'success', 3200);
    } catch (err) {
      groupTracks.forEach(function (item) { item.reparsing = false; });
      renderTracks();
      toast('重新解析失败：' + friendlyError(err), 'error', 6500);
    }
  }

  /* ------------------------------------------------------------------
   * 合并 / 导出 / 重置
   * ------------------------------------------------------------------ */

  async function performMerge(mergeOptions, config) {
    const settings = config || {};
    if (!settings.demo && state.busy.upload) {
      toast('正在导入，请稍候…', 'info');
      return false;
    }
    if (state.busy.merge) return false;
    const visible = visibleTracksWithPoints();
    if (!visible.length) {
      toast(state.tracks.length ? '所有轨迹都被隐藏了，请先显示至少一条轨迹' : '请先上传或导入示例轨迹', 'error');
      return false;
    }
    const hiddenCount = state.tracks.length - visible.length;
    const options = mergeOptions || readMergeOptions();
    const payload = {
      tracks: visible.map(function (track) {
        return { id: track.data.id, name: trackTitle(track), points: track.data.points };
      }),
      options: options
    };
    let body = '';
    try {
      body = JSON.stringify(payload);
    } catch (err) {
      toast('轨迹数据过大，无法合并', 'error');
      return false;
    }
    setMergeBusy(true);
    try {
      const data = await apiJson('/api/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      });
      const mergedTracks = Array.isArray(data.tracks) ? data.tracks : [];
      state.merged = { tracks: mergedTracks, stats: data.stats || null, options: options };
      state.focusedUid = null;
      state.chartHover = null;
      state.chartSeries = buildChartSeries();
      state.chartMode = state.chartSeries.hasEle ? 'ele' : (state.chartSeries.hasSpeed ? 'speed' : 'ele');
      updateChartTabs();
      if (dom.chartPanel) dom.chartPanel.hidden = false;
      if (dom.btnToggleChart) {
        dom.btnToggleChart.hidden = false;
        dom.btnToggleChart.textContent = '收起剖面';
      }
      if (dom.mergedBadge) dom.mergedBadge.hidden = false;
      if (dom.btnSaveMergedToLibrary) dom.btnSaveMergedToLibrary.hidden = mergedTracks.length === 0;
      if (dom.dockHint) dom.dockHint.textContent = '更新于 ' + fmtClock();
      if (dom.chartSub) dom.chartSub.textContent = chartSubText();
      renderStats(state.merged.stats);
      renderTracks();
      redrawMap();
      updateExportHint();
      window.requestAnimationFrame(function () {
        renderChart(null);
      });
      fitToMerged();
      const stats = state.merged.stats || {};
      const message = '合并完成：' + mergedTracks.length + ' 条轨迹 · ' + fmtKm(stats.distance_m) +
        (hiddenCount ? '（已跳过 ' + hiddenCount + ' 条隐藏轨迹）' : '');
      if (!settings.quietSuccess) toast(message, 'success', 3400);
      updateDockExportVisibility();
      return true;
    } catch (err) {
      toast('合并失败：' + friendlyError(err), 'error', 7000);
      return false;
    } finally {
      setMergeBusy(false);
    }
  }

  async function doMerge() {
    await performMerge(null, {});
  }

  async function doExport() {
    if (state.busy.export) return;
    const tracks = currentExportTracks();
    if (!tracks.length) {
      toast('没有可导出的轨迹，请先上传或合并轨迹', 'error');
      return;
    }
    const format = dom.expFormat.value || 'gpx';
    const crs = dom.expCrs.value || 'WGS84';
    const filename = safeFilename(dom.expFilename.value || '合并轨迹');
    const payload = { format: format, crs: crs, filename: filename, tracks: tracks };
    let body = '';
    try {
      body = JSON.stringify(payload);
    } catch (err) {
      toast('导出数据过大', 'error');
      return;
    }
    setExportBusy(true);
    try {
      const resp = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      });
      if (!resp.ok) {
        let message = '导出失败（HTTP ' + resp.status + '）';
        try {
          const data = await resp.json();
          if (data && data.error) message = data.error;
        } catch (e) {
          /* ignore */
        }
        throw new Error(message);
      }
      const disposition = resp.headers.get('Content-Disposition');
      let name = filenameFromContentDisposition(disposition);
      if (!name) name = filename + exportExt(format);
      const blob = await resp.blob();
      if (!blob.size) throw new Error('导出文件为空');
      downloadBlob(blob, name);
      toast('已开始下载：' + name, 'success', 3800);
    } catch (err) {
      toast('导出失败：' + friendlyError(err), 'error', 7000);
    } finally {
      setExportBusy(false);
    }
  }

  function resetAll() {
    if (state.busy.upload || state.busy.merge) return;
    if (!state.tracks.length && !state.merged) {
      toast('当前没有可重置的数据', 'info');
      return;
    }
    if (!window.confirm('确定要清空所有轨迹、合并结果与统计吗？')) return;
    state.tracks = [];
    state.merged = null;
    state.chartSeries = null;
    state.chartLayout = null;
    state.chartHover = null;
    state.focusedUid = null;
    state.colorCursor = 0;
    if (dom.chartPanel) dom.chartPanel.hidden = true;
    if (dom.btnToggleChart) dom.btnToggleChart.hidden = true;
    if (dom.mergedBadge) dom.mergedBadge.hidden = true;
    if (dom.btnSaveMergedToLibrary) dom.btnSaveMergedToLibrary.hidden = true;
    if (dom.dockHint) dom.dockHint.textContent = '合并后自动更新';
    if (dom.chartSub) dom.chartSub.textContent = '';
    if (dom.expFilename) dom.expFilename.value = '合并轨迹';
    if (dom.samplesBox) dom.samplesBox.hidden = true;
    hideChartTooltip();
    renderTracks();
    renderStats(null);
    redrawMap();
    updateExportHint();
    updateChartTabs();
    centerDefaultView();
    toast('已重置', 'success', 2600);
  }

  /* ------------------------------------------------------------------
   * 格式化列表 / 导出选项
   * ------------------------------------------------------------------ */

  function applyFormats(data) {
    state.formats = data && data.formats ? data : FALLBACK_FORMATS;
    const formats = state.formats.formats || [];
    const exts = [];
    formats.forEach(function (item) {
      if (!Array.isArray(item.ext)) return;
      item.ext.forEach(function (ext) {
        if (ext && exts.indexOf(ext) < 0) exts.push(ext);
      });
    });
    if (dom.fileInput) {
      dom.fileInput.accept = exts.length ? exts.join(',') : '.gpx,.kml,.json,.csv,.txt';
    }
    if (dom.uploadHint) {
      const labels = formats.map(function (item) { return item.label; }).filter(Boolean);
      if (labels.length) {
        dom.uploadHint.textContent = '支持 ' + labels.join(' / ') + '（可多选）';
      }
    }

    const exportFormats = (state.formats.export_formats && state.formats.export_formats.length)
      ? state.formats.export_formats
      : FALLBACK_FORMATS.export_formats;
    if (dom.expFormat) {
      const previous = dom.expFormat.value;
      clear(dom.expFormat);
      exportFormats.forEach(function (item) {
        const option = el('option', null, item.label + (item.ext ? '（' + item.ext + '）' : ''));
        option.value = item.id;
        dom.expFormat.appendChild(option);
      });
      if (previous && exportFormats.some(function (item) { return item.id === previous; })) {
        dom.expFormat.value = previous;
      }
    }

    const crsList = (state.formats.crs && state.formats.crs.length)
      ? state.formats.crs
      : FALLBACK_FORMATS.crs;
    if (dom.expCrs) {
      const previous = dom.expCrs.value;
      clear(dom.expCrs);
      crsList.forEach(function (item) {
        const option = el('option', null, CRS_LABELS[item.id] || item.label || item.id);
        option.value = item.id;
        dom.expCrs.appendChild(option);
      });
      const exists = crsList.some(function (item) { return item.id === previous; });
      dom.expCrs.value = exists && previous ? previous : 'WGS84';
    }
    updateDockExportVisibility();
  }

  async function loadFormats() {
    try {
      const data = await apiJson('/api/formats');
      applyFormats(data);
    } catch (err) {
      console.warn('加载格式列表失败，使用内置默认值', err);
      applyFormats(FALLBACK_FORMATS);
      toast('无法读取格式列表，已使用内置默认值', 'info', 4000);
    }
  }

  /* ==================================================================
   * v2：页签 / 可拖拽面板 / 多地图公共
   * ================================================================== */

  function pageFromHash() {
    const raw = String(window.location.hash || '').replace(/^#/, '').toLowerCase();
    return PAGE_NAMES.indexOf(raw) >= 0 ? raw : null;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return fmtNum(bytes / 1024, 1) + ' KB';
    return fmtNum(bytes / (1024 * 1024), 1) + ' MB';
  }

  function loadPanelPrefs() {
    let width = NaN;
    let height = NaN;
    try {
      width = parseFloat(window.localStorage.getItem('mtm.sidebarWidth'));
    } catch (e) {
      width = NaN;
    }
    try {
      height = parseFloat(window.localStorage.getItem('mtm.dockHeight'));
    } catch (e) {
      height = NaN;
    }
    try {
      const auto = window.localStorage.getItem('mtm.autoLibrary');
      if (auto !== null) state.autoSave = auto !== '0';
    } catch (e) {
      /* ignore */
    }
    if (dom.optAutoSave) dom.optAutoSave.checked = state.autoSave;
    if (Number.isFinite(width)) {
      applySidebarWidth(clamp(width, SIDEBAR_MIN, SIDEBAR_MAX), false);
    }
    if (Number.isFinite(height)) {
      applyDockHeight(clamp(height, DOCK_MIN, DOCK_MAX), false);
    }
  }

  function applySidebarWidth(width, persist) {
    state.sidebarWidth = width;
    document.documentElement.style.setProperty('--sidebar-w', width + 'px');
    if (persist) {
      try {
        window.localStorage.setItem('mtm.sidebarWidth', String(Math.round(width)));
      } catch (e) {
        /* ignore */
      }
    }
  }

  function applyDockHeight(height, persist) {
    state.dockHeight = height;
    if (height === null || height === undefined) {
      document.documentElement.style.removeProperty('--dock-h');
      if (persist) {
        try {
          window.localStorage.removeItem('mtm.dockHeight');
        } catch (e) {
          /* ignore */
        }
      }
      return;
    }
    document.documentElement.style.setProperty('--dock-h', Math.round(height) + 'px');
    if (persist) {
      try {
        window.localStorage.setItem('mtm.dockHeight', String(Math.round(height)));
      } catch (e) {
        /* ignore */
      }
    }
  }

  function resetSidebarWidth() {
    applySidebarWidth(SIDEBAR_DEFAULT, false);
    try {
      window.localStorage.removeItem('mtm.sidebarWidth');
    } catch (e) {
      /* ignore */
    }
    invalidateAllMaps();
  }

  function resetDockHeight() {
    applyDockHeight(null, false);
    try {
      window.localStorage.removeItem('mtm.dockHeight');
    } catch (e) {
      /* ignore */
    }
    invalidateAllMaps();
    if (dom.chartPanel && !dom.chartPanel.hidden) scheduleChartRender(state.chartHover);
  }

  function invalidateAllMaps() {
    [map, overviewMap, milestoneMap].forEach(function (item) {
      if (!item) return;
      try {
        item.invalidateSize();
      } catch (e) {
        /* ignore */
      }
    });
  }

  function initResizers() {
    const handles = document.querySelectorAll('[data-resizer]');
    for (let i = 0; i < handles.length; i++) {
      (function (handle) {
        let drag = null;
        handle.addEventListener('pointerdown', function (ev) {
          if (isMobile() || ev.button !== 0) return;
          const page = handle.closest('.page');
          if (!page) return;
          const type = handle.dataset.resizer;
          const target = type === 'sidebar' ? page.querySelector('.sidebar') : page.querySelector('.dock');
          if (!target) return;
          try {
            handle.setPointerCapture(ev.pointerId);
          } catch (e) {
            /* ignore */
          }
          drag = {
            type: type,
            startX: ev.clientX,
            startY: ev.clientY,
            startSize: type === 'sidebar'
              ? target.getBoundingClientRect().width
              : target.getBoundingClientRect().height
          };
          handle.classList.add('is-dragging');
          document.body.classList.add('is-resizing');
          document.body.style.cursor = type === 'sidebar' ? 'col-resize' : 'row-resize';
        });
        handle.addEventListener('pointermove', function (ev) {
          if (!drag) return;
          ev.preventDefault();
          if (drag.type === 'sidebar') {
            const width = clamp(drag.startSize + (ev.clientX - drag.startX), SIDEBAR_MIN, SIDEBAR_MAX);
            applySidebarWidth(width, false);
          } else {
            const height = clamp(drag.startSize + (drag.startY - ev.clientY), DOCK_MIN, DOCK_MAX);
            applyDockHeight(height, false);
          }
        });
        function finishDrag() {
          if (!drag) return;
          const type = drag.type;
          drag = null;
          handle.classList.remove('is-dragging');
          document.body.classList.remove('is-resizing');
          document.body.style.cursor = '';
          if (type === 'sidebar' && Number.isFinite(state.sidebarWidth)) {
            applySidebarWidth(state.sidebarWidth, true);
          } else if (type === 'dock' && Number.isFinite(state.dockHeight)) {
            applyDockHeight(state.dockHeight, true);
          }
          invalidateAllMaps();
          if (dom.chartPanel && !dom.chartPanel.hidden) scheduleChartRender(state.chartHover);
        }
        handle.addEventListener('pointerup', finishDrag);
        handle.addEventListener('pointercancel', finishDrag);
        handle.addEventListener('lostpointercapture', finishDrag);
        handle.addEventListener('dblclick', function (ev) {
          ev.preventDefault();
          if (isMobile()) return;
          if (handle.dataset.resizer === 'sidebar') resetSidebarWidth();
          else resetDockHeight();
        });
      })(handles[i]);
    }
  }

  function attachCoordReadout(mapObj, node) {
    if (!mapObj || !node) return;
    let nodes = null;
    mapObj.on('mousemove', function (ev) {
      const crs = state.displayCrs;
      const wgs = displayToWgs(ev.latlng.lng, ev.latlng.lat, crs);
      if (!nodes) {
        clear(node);
        const label1 = el('span', 'crd-label', 'WGS-84 ');
        const value1 = document.createTextNode('—');
        const sep = el('span', 'crd-sep', '·');
        const label2 = el('span', 'crd-label', (CRS_LABELS[crs] || crs) + ' ');
        const value2 = document.createTextNode('—');
        node.appendChild(label1);
        node.appendChild(value1);
        node.appendChild(sep);
        node.appendChild(label2);
        node.appendChild(value2);
        nodes = { value1: value1, label2: label2, value2: value2 };
      }
      nodes.label2.textContent = (CRS_LABELS[crs] || crs) + ' ';
      nodes.value1.textContent = fmtCoord(wgs[1]) + ', ' + fmtCoord(wgs[0]);
      nodes.value2.textContent = fmtCoord(ev.latlng.lat) + ', ' + fmtCoord(ev.latlng.lng);
    });
    mapObj.on('mouseout', function () {
      if (!dom || !node) return;
      nodes = null;
      node.textContent = '移动鼠标查看坐标';
    });
  }

  function showPage(name, options) {
    const opts = options || {};
    if (PAGE_NAMES.indexOf(name) < 0) name = 'overview';
    state.page = name;
    const pages = document.querySelectorAll('.page');
    for (let i = 0; i < pages.length; i++) {
      pages[i].hidden = pages[i].dataset.page !== name;
    }
    const tabs = document.querySelectorAll('.main-tab');
    for (let i = 0; i < tabs.length; i++) {
      const active = tabs[i].dataset.page === name;
      tabs[i].classList.toggle('is-active', active);
      tabs[i].setAttribute('aria-selected', String(active));
    }
    if (opts.updateHash !== false) {
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search + '#' + name);
      } catch (e) {
        /* ignore */
      }
    }
    if (dom.sidebarToggle) dom.sidebarToggle.hidden = name === 'sync';
    closeSidebar();
    if (name === 'overview') ensureOverviewPage();
    if (name === 'milestones') ensureMilestonesPage();
    if (name === 'sync') ensureSyncPage();
    window.setTimeout(function () {
      if (name === 'overview' && overviewMap) {
        overviewMap.invalidateSize();
        renderOverviewMap();
        ensureOverviewFitted(false);
        // 页面刚显示时布局可能尚未稳定，再补两次，确保不会停留在亚洲/世界视野
        window.setTimeout(function () {
          if (state.page !== 'overview' || !overviewMap) return;
          overviewMap.invalidateSize();
          ensureOverviewFitted(false);
        }, 320);
      }
      if (name === 'import' && map) map.invalidateSize();
      if (name === 'milestones' && milestoneMap) {
        milestoneMap.invalidateSize();
        if (milestoneGeoLyr) fitMilestoneToChina();
        else if (state.milestones.loaded) loadMilestoneGeoJSON(false);
        // 页面刚显示时布局可能尚未稳定，再补一次，确保不会停留在世界视野
        window.setTimeout(function () {
          if (state.page === 'milestones' && milestoneMap && milestoneGeoLyr) {
            fitMilestoneToChina();
          }
        }, 360);
      }
    }, 60);
  }

  function initTabs() {
    if (!dom.mainTabs) return;
    dom.mainTabs.addEventListener('click', function (ev) {
      const button = ev.target.closest('.main-tab');
      if (!button) return;
      showPage(button.dataset.page);
    });
    window.addEventListener('hashchange', function () {
      const target = pageFromHash();
      if (target && target !== state.page) showPage(target, { updateHash: false });
    });
  }

  /* ------------------------------ 轨迹库总览 ------------------------------ */

  const LIB_COLORS = COLORS;

  function libraryColor(track, index) {
    if (track && track.color) return track.color;
    return LIB_COLORS[index % LIB_COLORS.length];
  }

  function isLibraryVisible(id) {
    return state.library.visibility[id] !== false;
  }

  function libraryYear(track) {
    if (!track || !Number.isFinite(track.time_start)) return '';
    const d = new Date(track.time_start * 1000);
    if (isNaN(d.getTime())) return '';
    return String(d.getFullYear());
  }

  function libraryDateText(track) {
    if (Number.isFinite(track && track.time_start)) {
      const d = new Date(track.time_start * 1000);
      if (!isNaN(d.getTime())) {
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      }
    }
    if (Number.isFinite(track && track.created_at)) {
      const c = new Date(track.created_at * 1000);
      if (!isNaN(c.getTime())) {
        return '入库 ' + c.getFullYear() + '-' + pad2(c.getMonth() + 1) + '-' + pad2(c.getDate());
      }
    }
    return '无时间信息';
  }

  function filteredLibraryTracks() {
    const lib = state.library;
    const q = (lib.filters.q || '').trim().toLowerCase();
    const source = lib.filters.source;
    const year = lib.filters.year;
    return lib.tracks.filter(function (track) {
      if (q) {
        const hay = ((track.name || '') + ' ' + (track.filename || '') + ' ' + (track.source_label || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      if (source && source !== 'all' && (track.source_label || '').indexOf(source) < 0) return false;
      if (year && year !== 'all' && libraryYear(track) !== year) return false;
      return true;
    });
  }

  function loadLibrary(options) {
    const opts = options || {};
    const lib = state.library;
    if (lib.loading) return Promise.resolve();
    lib.loading = true;
    lib.stale = false;
    if (dom.libSummary) dom.libSummary.textContent = '正在加载轨迹库…';
    if (dom.btnLibraryRefresh) dom.btnLibraryRefresh.disabled = true;
    return apiJson('/api/library').then(function (data) {
      lib.tracks = Array.isArray(data.tracks) ? data.tracks : [];
      lib.stats = data.stats || null;
      lib.updatedAt = data.updated_at || 0;
      lib.loaded = true;
      lib.geometry = {};
      lib.loadingIds = {};
      lib.queue = [];
      lib.activeRequests = 0;
      if (lib.selectedId && !lib.tracks.some(function (t) { return t.id === lib.selectedId; })) {
        lib.selectedId = null;
      }
      renderLibraryFilters();
      renderLibrary();
      renderOverviewStats();
      renderOverviewDetail();
      queueGeometryForFiltered();
      if (opts.fit !== false) {
        lib.fitted = false;
        ensureOverviewFitted(true);
      } else {
        ensureOverviewFitted(false);
      }
    }).catch(function (err) {
      toast('轨迹库加载失败：' + friendlyError(err), 'error', 6500);
      if (dom.libSummary) dom.libSummary.textContent = lib.loaded ? '刷新失败，显示上次结果' : '轨迹库加载失败，请点「刷新」重试';
    }).finally(function () {
      lib.loading = false;
      if (dom.btnLibraryRefresh) dom.btnLibraryRefresh.disabled = false;
    });
  }

  function markLibraryStale() {
    state.library.stale = true;
    if (state.page === 'overview' && overviewMap) {
      loadLibrary({ fit: false });
    }
  }

  function queueGeometryForFiltered() {
    filteredLibraryTracks().forEach(function (track) {
      if (isLibraryVisible(track.id)) ensureLibraryGeometry(track.id);
    });
  }

  function ensureLibraryGeometry(id) {
    const lib = state.library;
    if (!id || lib.geometry[id] || lib.loadingIds[id]) return;
    lib.loadingIds[id] = true;
    lib.queue.push(id);
    pumpGeometryQueue();
  }

  function pumpGeometryQueue() {
    const lib = state.library;
    while (lib.activeRequests < 4 && lib.queue.length) {
      const id = lib.queue.shift();
      if (lib.geometry[id]) {
        delete lib.loadingIds[id];
        continue;
      }
      lib.activeRequests += 1;
      (function (trackId) {
        apiJson('/api/library/' + encodeURIComponent(trackId)).then(function (data) {
          if (data && data.track) lib.geometry[trackId] = data.track;
          delete lib.loadingIds[trackId];
          lib.activeRequests = Math.max(0, lib.activeRequests - 1);
          if (lib.selectedId === trackId) {
            renderOverviewDetail();
            if (lib.pendingFit === trackId) {
              lib.pendingFit = null;
              fitLibraryTrack(trackId);
            }
          }
          if (state.page === 'overview') {
            renderOverviewMap();
            ensureOverviewFitted(false);
          }
          pumpGeometryQueue();
        }).catch(function (err) {
          delete lib.loadingIds[trackId];
          lib.activeRequests = Math.max(0, lib.activeRequests - 1);
          console.warn('轨迹几何加载失败', trackId, err);
          pumpGeometryQueue();
        });
      })(id);
    }
  }

  function libraryDisplayCoords(geo) {
    if (!geo || !Array.isArray(geo.points)) return [];
    const crs = state.displayCrs;
    if (geo._display && geo._display.crs === crs) return geo._display.coords;
    const coords = [];
    for (let i = 0; i < geo.points.length; i++) {
      const p = geo.points[i];
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      coords.push(wgsToDisplay(p[0], p[1], crs));
    }
    geo._display = { crs: crs, coords: coords };
    return coords;
  }

  function initOverviewMap() {
    if (overviewMap || !dom.overviewMap) return;
    overviewMap = L.map(dom.overviewMap, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
      minZoom: 2,
      maxZoom: 19,
      worldCopyJump: true
    });
    const cfg = currentBasemapConfig() || BASEMAPS['gaode-vector'];
    overviewMap.setView([DEFAULT_CENTER_WGS[1], DEFAULT_CENTER_WGS[0]], DEFAULT_ZOOM, { animate: false });
    L.control.zoom({ position: 'topright' }).addTo(overviewMap);
    L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 130 }).addTo(overviewMap);
    overviewTile = makeTileLayer(cfg).addTo(overviewMap);
    overviewLayer = L.layerGroup().addTo(overviewMap);
    attachCoordReadout(overviewMap, dom.overviewCoordReadout);
    window.requestAnimationFrame(function () {
      if (overviewMap) overviewMap.invalidateSize();
      if (state.library.tracks.length) ensureOverviewFitted(false);
    });
  }

  function ensureOverviewPage() {
    if (!overviewMap) initOverviewMap();
    renderOverviewStats();
    renderLibrary();
    if (!state.library.loaded) {
      loadLibrary({ fit: true });
    } else if (!state.library.loading) {
      // 每次进入总览都刷新一次列表，确保扫码 / 同步上传的新轨迹能及时出现
      loadLibrary({ fit: false });
    } else {
      queueGeometryForFiltered();
      renderOverviewMap();
    }
  }

  function renderLibraryFilters() {
    const lib = state.library;
    if (dom.libSourceFilter) {
      const previous = dom.libSourceFilter.value || 'all';
      const labels = [];
      lib.tracks.forEach(function (track) {
        const label = track.source_label || track.source_format || '其它';
        if (labels.indexOf(label) < 0) labels.push(label);
      });
      clear(dom.libSourceFilter);
      const all = el('option', null, '全部来源');
      all.value = 'all';
      dom.libSourceFilter.appendChild(all);
      labels.sort().forEach(function (label) {
        const option = el('option', null, label);
        option.value = label;
        dom.libSourceFilter.appendChild(option);
      });
      dom.libSourceFilter.value = labels.indexOf(previous) >= 0 ? previous : 'all';
      lib.filters.source = dom.libSourceFilter.value;
    }
    if (dom.libYearFilter) {
      const previous = dom.libYearFilter.value || 'all';
      const years = [];
      lib.tracks.forEach(function (track) {
        const year = libraryYear(track);
        if (year && years.indexOf(year) < 0) years.push(year);
      });
      years.sort(function (a, b) { return Number(b) - Number(a); });
      clear(dom.libYearFilter);
      const all = el('option', null, '全部年份');
      all.value = 'all';
      dom.libYearFilter.appendChild(all);
      years.forEach(function (year) {
        const option = el('option', null, year + ' 年');
        option.value = year;
        dom.libYearFilter.appendChild(option);
      });
      dom.libYearFilter.value = years.indexOf(previous) >= 0 ? previous : 'all';
      lib.filters.year = dom.libYearFilter.value;
    }
  }

  function renderLibrary() {
    if (!dom.libList) return;
    const lib = state.library;
    const tracks = filteredLibraryTracks();
    clear(dom.libList);
    if (!lib.tracks.length) {
      if (dom.libEmpty) dom.libEmpty.hidden = false;
      if (dom.libSummary) dom.libSummary.textContent = lib.loaded ? '轨迹库为空' : '正在加载轨迹库…';
      updateOverviewEmpty();
      return;
    }
    if (dom.libEmpty) dom.libEmpty.hidden = true;
    if (!tracks.length) {
      dom.libList.appendChild(el('div', 'lib-loading', '没有符合筛选条件的轨迹'));
    }
    const stats = lib.stats || {};
    const visibleCount = tracks.filter(function (t) { return isLibraryVisible(t.id); }).length;
    if (dom.libSummary) {
      dom.libSummary.textContent = '共 ' + fmtInt(lib.tracks.length) + ' 条 · 当前显示 ' + fmtInt(visibleCount) +
        ' 条 · 总里程 ' + fmtKm(stats.distance_m) + (lib.updatedAt ? ' · 更新于 ' + fmtClock() : '');
    }
    tracks.forEach(function (track, index) {
      const item = el('div', 'lib-item');
      item.dataset.id = track.id;
      if (lib.selectedId === track.id) item.classList.add('is-selected');
      if (!isLibraryVisible(track.id)) item.classList.add('is-hidden-track');
      const dot = el('span', 'track-dot');
      dot.style.background = libraryColor(track, index);
      const main = el('div', 'lib-main');
      const nameRow = el('div', 'lib-name-row');
      const name = el('div', 'lib-name', track.name || track.filename || '未命名轨迹');
      name.title = (track.name || '') + (track.filename ? '（' + track.filename + '）' : '');
      nameRow.appendChild(name);
      nameRow.appendChild(el('span', 'source-badge', track.source_label || String(track.source_format || '轨迹').toUpperCase()));
      const meta = el('div', 'lib-meta');
      meta.textContent = fmtKm(track.distance_m) + ' · ' + fmtInt(track.point_count) + ' 点 · ' + libraryDateText(track);
      main.appendChild(nameRow);
      main.appendChild(meta);
      const actions = el('div', 'lib-actions');
      const eye = el('button', 'icon-btn');
      eye.type = 'button';
      eye.dataset.action = 'visible';
      eye.title = isLibraryVisible(track.id) ? '隐藏轨迹' : '显示轨迹';
      eye.setAttribute('aria-label', eye.title);
      eye.setAttribute('aria-pressed', String(isLibraryVisible(track.id)));
      eye.innerHTML = isLibraryVisible(track.id) ? ICONS.eye : ICONS.eyeOff;
      const locate = el('button', 'icon-btn');
      locate.type = 'button';
      locate.dataset.action = 'locate';
      locate.title = '定位到该轨迹';
      locate.setAttribute('aria-label', '定位到该轨迹');
      locate.innerHTML = ICONS.locate;
      const remove = el('button', 'icon-btn');
      remove.type = 'button';
      remove.dataset.action = 'delete';
      remove.title = '从轨迹库删除';
      remove.setAttribute('aria-label', '从轨迹库删除');
      remove.innerHTML = ICONS.trash;
      actions.appendChild(eye);
      actions.appendChild(locate);
      actions.appendChild(remove);
      item.appendChild(dot);
      item.appendChild(main);
      item.appendChild(actions);
      dom.libList.appendChild(item);
    });
    updateOverviewEmpty();
    updateOverviewLegend();
  }

  function renderOverviewStats() {
    if (!dom.overviewStats) return;
    const stats = state.library.stats;
    clear(dom.overviewStats);
    if (!stats) {
      dom.overviewStats.appendChild(statCard('轨迹数', '—', '条'));
      dom.overviewStats.appendChild(statCard('点数', '—', '点'));
      dom.overviewStats.appendChild(statCard('总里程', '—', 'km'));
      dom.overviewStats.appendChild(statCard('来源数', '—', '个'));
      dom.overviewStats.appendChild(statCard('时间范围', '—', '', { wide: true }));
      if (dom.overviewDockHint) dom.overviewDockHint.textContent = '加载中…';
      return;
    }
    dom.overviewStats.appendChild(statCard('轨迹数', fmtInt(stats.track_count), '条'));
    dom.overviewStats.appendChild(statCard('点数', fmtInt(stats.point_count), '点'));
    dom.overviewStats.appendChild(statCard('总里程', fmtNum(stats.distance_m / 1000, 2), 'km'));
    dom.overviewStats.appendChild(statCard('来源数', fmtInt(stats.source_count), '个'));
    dom.overviewStats.appendChild(statCard('时间范围', fmtTimeRangeCompact(stats.time_start, stats.time_end), '', {
      wide: true,
      title: '开始 ~ 结束（本地时间）：' + fmtTimeRange(stats.time_start, stats.time_end)
    }));
    if (dom.overviewDockHint) {
      dom.overviewDockHint.textContent = state.library.updatedAt ? '更新于 ' + fmtClock() : '轨迹库';
    }
  }

  function renderOverviewDetail() {
    if (!dom.overviewDetail) return;
    const lib = state.library;
    const summary = lib.tracks.find(function (t) { return t.id === lib.selectedId; });
    if (!summary) {
      dom.overviewDetail.hidden = true;
      clear(dom.overviewDetail);
      return;
    }
    clear(dom.overviewDetail);
    const title = el('span', 'detail-title', '选中：' + (summary.name || summary.filename || '未命名轨迹'));
    dom.overviewDetail.appendChild(title);
    const geo = lib.geometry[summary.id];
    const kvs = [
      ['来源', summary.source_label || summary.source_format || '—'],
      ['点数', fmtInt(summary.point_count) + ' 点'],
      ['里程', fmtKm(summary.distance_m)],
      ['时长', fmtDuration(summary.duration_s)],
      ['日期', libraryDateText(summary)]
    ];
    if (geo && Array.isArray(geo.points)) {
      kvs.push(['坐标段', fmtInt(Array.isArray(geo.segments) ? geo.segments.length : 1) + ' 段']);
    }
    kvs.forEach(function (pair) {
      const kv = el('span', 'detail-kv');
      kv.appendChild(el('span', null, pair[0]));
      kv.appendChild(el('strong', null, pair[1]));
      dom.overviewDetail.appendChild(kv);
    });
    dom.overviewDetail.hidden = false;
  }

  function renderOverviewMap() {
    if (!overviewMap || !overviewLayer) return;
    overviewLayer.clearLayers();
    const tracks = filteredLibraryTracks();
    let visible = 0;
    tracks.forEach(function (track, index) {
      if (!isLibraryVisible(track.id)) return;
      const geo = state.library.geometry[track.id];
      if (!geo) {
        ensureLibraryGeometry(track.id);
        return;
      }
      const coords = libraryDisplayCoords(geo);
      if (coords.length < 2) return;
      const selected = state.library.selectedId === track.id;
      const latlngs = [];
      for (let i = 0; i < coords.length; i++) latlngs.push([coords[i][1], coords[i][0]]);
      const color = libraryColor(track, index);
      const line = L.polyline(latlngs, {
        color: color,
        weight: selected ? 6 : 4,
        opacity: selected ? 1 : 0.9,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(overviewLayer);
      line.on('click', function () {
        selectLibraryTrack(track.id, true);
      });
      if (selected) {
        addCircle(overviewLayer, latlngs[0], color, 6);
        addCircle(overviewLayer, latlngs[latlngs.length - 1], color, 6);
      }
      visible += 1;
    });
    updateOverviewLegend();
    updateOverviewEmpty();
    if (dom.overviewDockHint && state.library.tracks.length) {
      dom.overviewDockHint.textContent = visible + ' / ' + state.library.tracks.length + ' 条已绘制';
    }
  }

  function updateOverviewLegend() {
    if (!dom.overviewLegend) return;
    const tracks = filteredLibraryTracks().filter(function (t) { return isLibraryVisible(t.id); });
    clear(dom.overviewLegend);
    if (!tracks.length) {
      dom.overviewLegend.hidden = true;
      return;
    }
    tracks.slice(0, 30).forEach(function (track, index) {
      const row = el('div', 'legend-item');
      const dot = el('span', 'legend-dot');
      dot.style.background = libraryColor(track, index);
      const name = el('span', 'legend-name', track.name || track.filename || '未命名轨迹');
      name.title = name.textContent;
      row.appendChild(dot);
      row.appendChild(name);
      dom.overviewLegend.appendChild(row);
    });
    dom.overviewLegend.hidden = false;
  }

  function updateOverviewEmpty() {
    if (!dom.overviewMapEmpty) return;
    const empty = !state.library.tracks.length;
    dom.overviewMapEmpty.hidden = !empty;
  }

  function overviewMapReadyForFit() {
    if (!overviewMap) return false;
    try {
      const size = overviewMap.getSize();
      return !!(size && size.x > 40 && size.y > 40);
    } catch (e) {
      return false;
    }
  }

  /**
   * 稳健地把总览地图缩放到轨迹范围：
   * - 容器尺寸为 0（页面隐藏/刚切换）时延迟重试，绝不把 fitted 置 true；
   * - fitted 只在真正 fitBounds 成功后置 true；
   * - 进入总览页/库加载/首个几何加载完成都会尝试。
   */
  function ensureOverviewFitted(force) {
    const lib = state.library;
    if (!overviewMap || !lib.tracks.length) return;
    if (!force && lib.fitted) return;
    attemptOverviewFit(force, 0);
  }

  function attemptOverviewFit(force, attempt) {
    const lib = state.library;
    if (!overviewMap || !lib.tracks.length) return;
    if (!force && lib.fitted) return;
    if (!overviewMapReadyForFit()) {
      // 容器尺寸为 0（页面隐藏/刚切换）时独立重试，避免多个调用共用计数提前耗尽
      if (attempt < 14) {
        window.setTimeout(function () {
          attemptOverviewFit(force, attempt + 1);
        }, 160);
      }
      return;
    }
    fitOverviewToLibrary();
  }

  function fitOverviewToLibrary() {
    if (!overviewMap || !overviewMapReadyForFit()) return;
    const lib = state.library;
    if (!lib.tracks.length) {
      const center = wgsToDisplay(DEFAULT_CENTER_WGS[0], DEFAULT_CENTER_WGS[1], state.displayCrs);
      overviewMap.setView([center[1], center[0]], DEFAULT_ZOOM, { animate: false });
      lib.fitted = false;
      return;
    }
    const stats = lib.stats;
    if (stats && Array.isArray(stats.bbox) && stats.bbox.length === 4 &&
      stats.bbox.every(function (v) { return Number.isFinite(v); })) {
      const a = wgsToDisplay(stats.bbox[0], stats.bbox[1], state.displayCrs);
      const b = wgsToDisplay(stats.bbox[2], stats.bbox[3], state.displayCrs);
      const bounds = L.latLngBounds([a[1], a[0]], [b[1], b[0]]);
      if (bounds.isValid()) {
        overviewMap.fitBounds(bounds, { padding: [48, 48], maxZoom: 16, animate: false });
        lib.fitted = true;
        return;
      }
    }
    const latlngs = [];
    lib.tracks.forEach(function (track) {
      const geo = lib.geometry[track.id];
      if (!geo || !isLibraryVisible(track.id)) return;
      libraryDisplayCoords(geo).forEach(function (p) { latlngs.push([p[1], p[0]]); });
    });
    if (latlngs.length) {
      overviewMap.fitBounds(L.latLngBounds(latlngs), { padding: [48, 48], maxZoom: 16, animate: false });
      lib.fitted = true;
    }
  }

  function fitLibraryTrack(id) {
    if (!overviewMap) return;
    const geo = state.library.geometry[id];
    if (!geo) {
      state.library.pendingFit = id;
      return;
    }
    const coords = libraryDisplayCoords(geo);
    if (!coords.length) return;
    const latlngs = coords.map(function (p) { return [p[1], p[0]]; });
    if (latlngs.length === 1) {
      overviewMap.setView(latlngs[0], 15, { animate: true });
    } else {
      overviewMap.fitBounds(L.latLngBounds(latlngs), { padding: [56, 56], maxZoom: 16, animate: true });
    }
  }

  function selectLibraryTrack(id, fit) {
    const lib = state.library;
    lib.selectedId = id;
    renderLibrary();
    renderOverviewDetail();
    renderOverviewMap();
    if (fit !== false) {
      const geo = lib.geometry[id];
      if (geo) fitLibraryTrack(id);
      else {
        lib.pendingFit = id;
        ensureLibraryGeometry(id);
      }
    }
  }

  function deleteLibraryTrack(id) {
    const summary = state.library.tracks.find(function (t) { return t.id === id; });
    const label = summary ? (summary.name || summary.filename) : id;
    if (!window.confirm('确定从轨迹库删除「' + label + '」吗？')) return;
    apiJson('/api/library/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
      delete state.library.geometry[id];
      delete state.library.visibility[id];
      if (state.library.selectedId === id) state.library.selectedId = null;
      toast('已删除轨迹「' + label + '」', 'success', 2800);
      loadLibrary({ fit: false });
    }).catch(function (err) {
      toast('删除失败：' + friendlyError(err), 'error', 6000);
    });
  }

  function clearLibrary() {
    if (!window.confirm('确定清空整个轨迹库吗？该操作会删除 NAS 上 data/library/ 的全部轨迹，且不可撤销。')) return;
    apiJson('/api/library', { method: 'DELETE' }).then(function (data) {
      const count = (data && data.deleted) || 0;
      state.library.tracks = [];
      state.library.geometry = {};
      state.library.selectedId = null;
      state.library.stale = false;
      toast('已清空轨迹库（' + count + ' 条）', 'success', 3000);
      loadLibrary({ fit: true });
    }).catch(function (err) {
      toast('清空失败：' + friendlyError(err), 'error', 6000);
    });
  }

  function bindLibraryEvents() {
    if (dom.btnLibraryRefresh) {
      dom.btnLibraryRefresh.addEventListener('click', function () { loadLibrary({ fit: true }); });
    }
    if (dom.btnLibraryClear) {
      dom.btnLibraryClear.addEventListener('click', clearLibrary);
    }
    if (dom.btnOverviewFit) {
      dom.btnOverviewFit.addEventListener('click', function () {
        fitOverviewToLibrary();
      });
    }
    if (dom.libSearch) {
      dom.libSearch.addEventListener('input', debounce(function () {
        state.library.filters.q = dom.libSearch.value;
        renderLibrary();
        renderOverviewMap();
        queueGeometryForFiltered();
      }, 200));
    }
    if (dom.libSourceFilter) {
      dom.libSourceFilter.addEventListener('change', function () {
        state.library.filters.source = dom.libSourceFilter.value;
        renderLibrary();
        renderOverviewMap();
        queueGeometryForFiltered();
      });
    }
    if (dom.libYearFilter) {
      dom.libYearFilter.addEventListener('change', function () {
        state.library.filters.year = dom.libYearFilter.value;
        renderLibrary();
        renderOverviewMap();
        queueGeometryForFiltered();
      });
    }
    if (dom.libList) {
      dom.libList.addEventListener('click', function (ev) {
        const item = ev.target.closest('.lib-item');
        if (!item) return;
        const id = item.dataset.id;
        const action = ev.target.closest('[data-action]');
        if (action) {
          const name = action.dataset.action;
          if (name === 'visible') {
            ev.stopPropagation();
            state.library.visibility[id] = !isLibraryVisible(id);
            renderLibrary();
            renderOverviewMap();
            return;
          }
          if (name === 'locate') {
            ev.stopPropagation();
            selectLibraryTrack(id, true);
            return;
          }
          if (name === 'delete') {
            ev.stopPropagation();
            deleteLibraryTrack(id);
            return;
          }
        }
        selectLibraryTrack(id, true);
      });
      dom.libList.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const item = ev.target.closest ? ev.target.closest('.lib-item') : null;
        if (!item) return;
        ev.preventDefault();
        selectLibraryTrack(item.dataset.id, true);
      });
    }
    [
      ['btnGoImport', 'import'], ['btnEmptyGoImport', 'import'], ['btnGoSync', 'sync'],
      ['btnEmptyGoSync', 'sync'], ['btnOverviewEmptyImport', 'import'],
      ['btnOverviewEmptySync', 'sync'], ['btnMilestoneGoImport', 'import'],
      ['btnMilestoneEmptyImport', 'import']
    ].forEach(function (pair) {
      const node = dom[pair[0]];
      if (node) node.addEventListener('click', function () { showPage(pair[1]); });
    });
  }

  /* ------------------------------ 轨迹库保存 ------------------------------ */

  function trackToLibraryPayload(track) {
    if (!track) return null;
    const data = track.data || {};
    const points = Array.isArray(track.points) ? track.points : data.points;
    if (!Array.isArray(points) || !points.length) return null;
    return {
      name: track.name || data.name || data.filename || trackTitle(track),
      points: points,
      segments: Array.isArray(track.segments) && track.segments.length ? track.segments : [0],
      source: {
        format: data.format || track.format || 'gpx',
        format_label: data.format_label || track.format_label || '轨迹',
        source_crs: data.source_crs || track.source_crs || 'WGS84',
        filename: data.filename || track.filename || ''
      }
    };
  }

  async function addToLibrary(payloadTracks, options) {
    const settings = options || {};
    const tracks = payloadTracks.filter(Boolean);
    if (!tracks.length) {
      if (!settings.auto) toast('没有可存入轨迹库的轨迹', 'info');
      return;
    }
    if (dom.btnSaveTracksToLibrary) dom.btnSaveTracksToLibrary.disabled = true;
    if (dom.btnSaveMergedToLibrary) dom.btnSaveMergedToLibrary.disabled = true;
    let body = '';
    try {
      body = JSON.stringify({ tracks: tracks });
    } catch (e) {
      toast('轨迹数据过大，无法存入轨迹库', 'error');
      return;
    }
    try {
      const data = await apiJson('/api/library/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      });
      const added = Array.isArray(data.added) ? data.added.length : 0;
      const duplicates = Array.isArray(data.duplicates) ? data.duplicates.length : 0;
      const errors = Array.isArray(data.errors) ? data.errors : [];
      let message = '';
      if (added) message = '已存入轨迹库 ' + added + ' 条';
      if (duplicates) message += (message ? '，' : '') + duplicates + ' 条重复已跳过';
      if (message) toast(message, 'success', 3600);
      else if (!errors.length) toast('轨迹已存在，无需重复存入', 'info');
      errors.forEach(function (item) {
        toast('存入失败：' + (item.name || '') + (item.error ? '（' + item.error + '）' : ''), 'error', 6000);
      });
      if (added || duplicates) markLibraryStale();
    } catch (err) {
      toast('存入轨迹库失败：' + friendlyError(err), 'error', 6500);
    } finally {
      if (dom.btnSaveTracksToLibrary) dom.btnSaveTracksToLibrary.disabled = false;
      if (dom.btnSaveMergedToLibrary) dom.btnSaveMergedToLibrary.disabled = false;
    }
  }

  function saveTracksToLibrary(trackObjects, options) {
    if (!Array.isArray(trackObjects) || !trackObjects.length) {
      toast('还没有轨迹可存入轨迹库', 'info');
      return Promise.resolve();
    }
    return addToLibrary(trackObjects.map(trackToLibraryPayload), options);
  }

  function saveMergedToLibrary() {
    const mergedTracks = (state.merged && state.merged.tracks) || [];
    if (!mergedTracks.length) {
      toast('还没有合并结果可存入轨迹库', 'info');
      return;
    }
    const payload = mergedTracks.map(function (track) {
      return {
        name: track.name || '合并轨迹',
        points: Array.isArray(track.points) ? track.points : [],
        segments: Array.isArray(track.segments) && track.segments.length ? track.segments : [0],
        source: {
          format: 'merged',
          format_label: '合并结果',
          source_crs: 'WGS84',
          filename: '合并轨迹'
        }
      };
    });
    addToLibrary(payload, {});
  }

  /* ------------------------------ 里程碑 ------------------------------ */

  const MS_CHEVRON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

  function initMilestoneMap() {
    if (milestoneMap || !dom.milestoneMap) return;
    milestoneMap = L.map(dom.milestoneMap, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
      minZoom: 2,
      maxZoom: 19,
      worldCopyJump: true
    });
    milestoneMap.setView([DEFAULT_CENTER_WGS[1], DEFAULT_CENTER_WGS[0]], DEFAULT_ZOOM, { animate: false });
    L.control.zoom({ position: 'topright' }).addTo(milestoneMap);
    L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 130 }).addTo(milestoneMap);
    const cfg = currentBasemapConfig() || BASEMAPS['gaode-vector'];
    milestoneTile = makeTileLayer(cfg).addTo(milestoneMap);
    attachCoordReadout(milestoneMap, dom.milestoneCoordReadout);
    window.requestAnimationFrame(function () {
      if (milestoneMap) milestoneMap.invalidateSize();
    });
  }

  function milestoneGeoRequestCrs() {
    return state.displayCrs === 'GCJ02' ? 'GCJ02' : 'WGS84';
  }

  function ensureMilestonesPage() {
    if (!milestoneMap) initMilestoneMap();
    if (!state.milestones.loading) loadMilestones(false);
  }

  function loadMilestones(force) {
    if (state.milestones.loading) return;
    state.milestones.loading = true;
    if (dom.btnMilestoneRefresh) dom.btnMilestoneRefresh.disabled = true;
    if (!state.milestones.data && dom.milestoneCards) {
      clear(dom.milestoneCards);
      const loading = el('div', 'ms-loading');
      loading.appendChild(el('span', 'spinner'));
      loading.appendChild(el('span', null, '正在计算里程碑…'));
      dom.milestoneCards.appendChild(loading);
    }
    apiJson('/api/milestones').then(function (data) {
      state.milestones.data = data;
      state.milestones.loaded = true;
      renderMilestones();
      if (milestoneMap) loadMilestoneGeoJSON(true);
    }).catch(function (err) {
      toast('里程碑加载失败：' + friendlyError(err), 'error', 6500);
      if (!state.milestones.data && dom.milestoneCards) {
        clear(dom.milestoneCards);
        dom.milestoneCards.appendChild(el('div', 'ms-loading', '里程碑加载失败，请点「刷新」重试'));
      }
    }).finally(function () {
      state.milestones.loading = false;
      if (dom.btnMilestoneRefresh) dom.btnMilestoneRefresh.disabled = false;
    });
  }

  function renderMilestones() {
    renderMilestoneCards();
    renderMilestoneList();
    updateMilestoneMapState();
  }

  function renderMilestoneCards() {
    if (!dom.milestoneCards) return;
    const data = state.milestones.data;
    clear(dom.milestoneCards);
    if (!data || !data.counts) {
      dom.milestoneCards.appendChild(el('div', 'ms-loading', '暂无里程碑数据'));
      return;
    }
    const levels = [
      ['country', '国家'],
      ['province', '省份'],
      ['city', '城市'],
      ['district', '区县']
    ];
    levels.forEach(function (pair) {
      const item = data.counts[pair[0]] || { visited: 0, total: 0 };
      const visited = Number.isFinite(item.visited) ? item.visited : 0;
      const total = Number.isFinite(item.total) ? item.total : 0;
      const pct = total > 0 ? Math.round((visited / total) * 100) : 0;
      const card = el('div', 'ms-card' + (visited > 0 ? ' is-visited' : ''));
      card.appendChild(el('span', 'ms-card-label', pair[1]));
      const value = el('span', 'ms-card-value');
      value.textContent = visited + ' / ' + total;
      const small = el('small', null, '（' + pct + '%）');
      value.appendChild(small);
      card.appendChild(value);
      const bar = el('div', 'ms-progress');
      const fill = el('i');
      fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
      bar.appendChild(fill);
      card.appendChild(bar);
      dom.milestoneCards.appendChild(card);
    });
    if (dom.milestoneHint) {
      const parts = [];
      if (Number.isFinite(data.updated_at)) parts.push('轨迹库更新：' + fmtDateTime(data.updated_at));
      if (Number.isFinite(data.computed_at)) parts.push('计算于 ' + fmtDateTime(data.computed_at));
      dom.milestoneHint.textContent = parts.join(' · ');
    }
  }

  function milestoneCountText(level, node) {
    if (level === 'province') {
      const cities = Array.isArray(node.cities) ? node.cities : [];
      const visited = cities.filter(function (c) { return c.visited; }).length;
      return visited + '/' + cities.length + ' 市';
    }
    if (level === 'city') {
      const districts = Array.isArray(node.districts) ? node.districts : [];
      const visited = districts.filter(function (d) { return d.visited; }).length;
      return visited + '/' + districts.length + ' 区';
    }
    return '';
  }

  function buildMilestoneRow(level, node) {
    const expandedMap = level === 'province' ? state.milestones.expanded.provinces : state.milestones.expanded.cities;
    const children = level === 'province'
      ? (Array.isArray(node.cities) ? node.cities : [])
      : level === 'city'
        ? (Array.isArray(node.districts) ? node.districts : [])
        : [];
    const hasChildren = level !== 'district' && children.length > 0;
    const expanded = !!expandedMap[node.adcode];
    const row = el('div', 'ms-row' + (node.visited ? ' is-visited' : '') + (expanded ? ' is-expanded' : ''));
    row.dataset.adcode = String(node.adcode);
    row.dataset.level = level;
    if (hasChildren) {
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
    }
    const toggle = el('span', 'ms-toggle');
    if (hasChildren) toggle.innerHTML = MS_CHEVRON;
    row.appendChild(toggle);
    const name = el('span', 'ms-name', node.name || String(node.adcode));
    name.title = node.name || '';
    row.appendChild(name);
    const count = milestoneCountText(level, node);
    if (count) row.appendChild(el('span', 'ms-count', count));
    row.appendChild(el('span', 'visited-badge ' + (node.visited ? 'is-on' : 'is-off'), node.visited ? '已点亮' : '未点亮'));
    if (hasChildren) {
      row.addEventListener('click', function () {
        expandedMap[node.adcode] = !expandedMap[node.adcode];
        renderMilestoneList();
      });
      row.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        row.click();
      });
    }
    return row;
  }

  function renderMilestoneList() {
    if (!dom.milestoneList) return;
    const data = state.milestones.data;
    const only = state.milestones.onlyVisited;
    clear(dom.milestoneList);
    if (!data || !Array.isArray(data.provinces)) {
      dom.milestoneList.appendChild(el('div', 'lib-loading', '暂无数据'));
      if (dom.milestoneEmpty) dom.milestoneEmpty.hidden = true;
      return;
    }
    const provinces = data.provinces.filter(function (p) { return !only || p.visited; });
    provinces.forEach(function (province) {
      dom.milestoneList.appendChild(buildMilestoneRow('province', province));
      if (state.milestones.expanded.provinces[province.adcode]) {
        const childrenWrap = el('div', 'ms-children');
        const cities = (province.cities || []).filter(function (c) { return !only || c.visited; });
        cities.forEach(function (city) {
          childrenWrap.appendChild(buildMilestoneRow('city', city));
          if (state.milestones.expanded.cities[city.adcode]) {
            const districtWrap = el('div', 'ms-children');
            (city.districts || []).filter(function (d) { return !only || d.visited; }).forEach(function (district) {
              districtWrap.appendChild(buildMilestoneRow('district', district));
            });
            childrenWrap.appendChild(districtWrap);
          }
        });
        dom.milestoneList.appendChild(childrenWrap);
      }
    });
    if (!provinces.length) {
      dom.milestoneList.appendChild(el('div', 'lib-loading', only ? '还没有已点亮的省份' : '暂无省级数据'));
    }
    const counts = data.counts || {};
    const visitedProvinces = counts.province ? counts.province.visited : 0;
    if (dom.milestoneEmpty) dom.milestoneEmpty.hidden = visitedProvinces > 0 || !state.milestones.loaded;
  }

  function updateMilestoneMapState() {
    const data = state.milestones.data;
    const counts = (data && data.counts) || {};
    const visited = counts.province ? counts.province.visited : 0;
    if (dom.milestoneMapEmpty) dom.milestoneMapEmpty.hidden = !(state.milestones.loaded && visited === 0);
    if (dom.milestoneCrsTag) dom.milestoneCrsTag.textContent = CRS_LABELS[state.displayCrs] || state.displayCrs;
    if (dom.milestoneLegend && milestoneGeoLyr) {
      clear(dom.milestoneLegend);
      [
        ['已点亮', '#0ea5e9'],
        ['未点亮', '#e2e8f0']
      ].forEach(function (pair) {
        const row = el('div', 'legend-item');
        const dot = el('span', 'legend-dot');
        dot.style.background = pair[1];
        row.appendChild(dot);
        row.appendChild(el('span', 'legend-name', pair[0]));
        dom.milestoneLegend.appendChild(row);
      });
      dom.milestoneLegend.hidden = false;
    }
  }

  function focusMilestoneProvince(adcode) {
    const data = state.milestones.data;
    if (!data || !Array.isArray(data.provinces)) return;
    const province = data.provinces.find(function (p) { return String(p.adcode) === String(adcode); });
    if (!province) return;
    state.milestones.expanded.provinces[province.adcode] = true;
    renderMilestoneList();
    const row = dom.milestoneList && dom.milestoneList.querySelector('[data-adcode="' + province.adcode + '"]');
    if (row && row.scrollIntoView) {
      try {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (e) {
        row.scrollIntoView();
      }
    }
  }

  function loadMilestoneGeoJSON(force) {
    if (!milestoneMap) return;
    const requestCrs = milestoneGeoRequestCrs();
    if (!force && state.milestones.geoCrs === requestCrs && milestoneGeoLyr) return;
    if (dom.milestoneMapEmpty) dom.milestoneMapEmpty.hidden = true;
    apiJson('/api/milestones/geojson?crs=' + requestCrs).then(function (data) {
      if (milestoneGeoLyr) {
        try {
          milestoneMap.removeLayer(milestoneGeoLyr);
        } catch (e) {
          /* ignore */
        }
        milestoneGeoLyr = null;
      }
      milestoneGeoLyr = L.geoJSON(data, {
        style: function (feature) {
          const visited = feature && feature.properties && feature.properties.visited;
          return visited
            ? { color: '#0369a1', weight: 1.6, fillColor: '#0ea5e9', fillOpacity: 0.42 }
            : { color: '#94a3b8', weight: 1.3, fillColor: '#e2e8f0', fillOpacity: 0.5 };
        },
        onEachFeature: function (feature, layer) {
          const props = (feature && feature.properties) || {};
          const visited = !!props.visited;
          layer.bindTooltip((props.name || '') + ' · ' + (visited ? '已点亮' : '未点亮'), { sticky: true });
          layer.on('click', function () {
            focusMilestoneProvince(props.adcode);
            try {
              const bounds = layer.getBounds();
              if (bounds && bounds.isValid()) {
                milestoneMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 7, animate: true });
              }
            } catch (e) {
              /* ignore */
            }
          });
        }
      }).addTo(milestoneMap);
      state.milestones.geoCrs = requestCrs;
      if (!state.milestones.fitted) {
        state.milestones.fitted = true;
        window.setTimeout(function () {
          if (state.page === 'milestones') fitMilestoneToChina();
        }, 100);
      }
      updateMilestoneMapState();
    }).catch(function (err) {
      toast('里程碑地图加载失败：' + friendlyError(err), 'error', 6000);
    });
  }

  /** 把里程碑地图视野固定到中国范围（34 个省级 feature 的 bounds，异常时用中国外接矩形） */
  function fitMilestoneToChina() {
    if (!milestoneMap) return;
    let bounds = null;
    if (milestoneGeoLyr) {
      try {
        bounds = milestoneGeoLyr.getBounds();
      } catch (e) {
        bounds = null;
      }
    }
    const fallback = L.latLngBounds(L.latLng(18.0, 73.0), L.latLng(54.0, 135.0));
    if (!bounds || !bounds.isValid()) {
      bounds = fallback;
    } else {
      const spanLat = bounds.getNorth() - bounds.getSouth();
      const spanLng = bounds.getEast() - bounds.getWest();
      if (!(spanLat > 5 && spanLat < 46 && spanLng > 5 && spanLng < 76)) {
        bounds = fallback;
      }
    }
    try {
      milestoneMap.invalidateSize();
    } catch (e) {
      /* ignore */
    }
    milestoneMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 6, animate: false });
    state.milestones.fitted = true;
  }

  function bindMilestoneEvents() {
    if (dom.btnMilestoneRefresh) {
      dom.btnMilestoneRefresh.addEventListener('click', function () { loadMilestones(true); });
    }
    if (dom.milestoneOnlyVisited) {
      dom.milestoneOnlyVisited.addEventListener('change', function () {
        state.milestones.onlyVisited = !!dom.milestoneOnlyVisited.checked;
        renderMilestoneList();
      });
    }
  }

  /* ------------------------------ 同步中心 ------------------------------ */

  function absoluteMobileUrl(path) {
    const raw = String(path || '');
    if (/^https?:\/\//i.test(raw)) return raw;
    return window.location.origin + (raw.charAt(0) === '/' ? '' : '/') + raw;
  }

  function ensureSyncPage() {
    if (!state.sync.statusLoading) loadSyncStatus();
    loadSyncRecent();
    if (!state.sync.token || (state.sync.expiresAt && state.sync.expiresAt * 1000 <= Date.now())) {
      loadSyncToken();
    } else {
      renderSyncQR();
      startSyncCountdown();
    }
  }

  function loadSyncRecent() {
    if (!dom.syncRecentList) return;
    clear(dom.syncRecentList);
    const loading = el('div', 'loading-inline');
    loading.appendChild(el('span', 'spinner'));
    loading.appendChild(el('span', null, '正在读取轨迹库…'));
    dom.syncRecentList.appendChild(loading);
    apiJson('/api/library').then(function (data) {
      if (!dom.syncRecentList) return;
      clear(dom.syncRecentList);
      const tracks = (Array.isArray(data.tracks) ? data.tracks : [])
        .slice()
        .sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); })
        .slice(0, 8);
      if (!tracks.length) {
        dom.syncRecentList.appendChild(el('div', 'sync-recent-empty', '轨迹库为空：扫码上传或扫描同步文件夹后，这里会显示最近入库的轨迹。'));
        return;
      }
      tracks.forEach(function (track, index) {
        const item = el('div', 'sync-recent-item');
        const dot = el('span', 'track-dot');
        dot.style.background = libraryColor(track, index);
        const main = el('div', 'sync-recent-main');
        const name = el('div', 'sync-recent-name', track.name || track.filename || '未命名轨迹');
        name.title = name.textContent;
        const meta = el('div', 'sync-recent-meta',
          (track.source_label || track.source_format || '轨迹') + ' · ' +
          fmtKm(track.distance_m) + ' · ' + libraryDateText(track));
        main.appendChild(name);
        main.appendChild(meta);
        item.appendChild(dot);
        item.appendChild(main);
        dom.syncRecentList.appendChild(item);
      });
    }).catch(function (err) {
      if (!dom.syncRecentList) return;
      clear(dom.syncRecentList);
      dom.syncRecentList.appendChild(el('div', 'sync-recent-empty', '轨迹库读取失败：' + friendlyError(err)));
    });
  }

  function loadSyncToken() {
    if (state.sync.loadingToken) return;
    state.sync.loadingToken = true;
    if (dom.btnSyncRefreshToken) dom.btnSyncRefreshToken.disabled = true;
    if (dom.syncQrBox) {
      clear(dom.syncQrBox);
      const loading = el('div', 'ms-loading');
      loading.appendChild(el('span', 'spinner'));
      loading.appendChild(el('span', null, '正在生成二维码…'));
      dom.syncQrBox.appendChild(loading);
    }
    apiJson('/api/sync/token').then(function (data) {
      state.sync.token = data.token || null;
      state.sync.expiresAt = Number(data.expires_at) || 0;
      const mobilePath = data.mobile_path || ('/mobile.html?token=' + encodeURIComponent(data.token || ''));
      state.sync.mobileUrl = absoluteMobileUrl(mobilePath);
      renderSyncQR();
      startSyncCountdown();
    }).catch(function (err) {
      if (dom.syncQrBox) {
        clear(dom.syncQrBox);
        dom.syncQrBox.appendChild(el('div', 'inbox-empty', '二维码加载失败，请点「刷新二维码」'));
      }
      toast('获取同步令牌失败：' + friendlyError(err), 'error', 6000);
    }).finally(function () {
      state.sync.loadingToken = false;
      if (dom.btnSyncRefreshToken) dom.btnSyncRefreshToken.disabled = false;
    });
  }

  function renderSyncQR() {
    if (!dom.syncQrBox) return;
    clear(dom.syncQrBox);
    const url = state.sync.mobileUrl;
    if (dom.syncQrUrl) dom.syncQrUrl.textContent = url || '—';
    if (dom.syncMobileLink) {
      if (url) {
        dom.syncMobileLink.href = url;
        dom.syncMobileLink.hidden = false;
      } else {
        dom.syncMobileLink.hidden = true;
      }
    }
    if (!url) {
      dom.syncQrBox.appendChild(el('div', 'inbox-empty', '尚未生成二维码'));
      return;
    }
    if (typeof window.QRCode === 'function') {
      try {
        new window.QRCode(dom.syncQrBox, {
          text: url,
          width: 168,
          height: 168,
          colorDark: '#0f172a',
          colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel ? window.QRCode.CorrectLevel.M : 1
        });
      } catch (e) {
        dom.syncQrBox.appendChild(el('div', 'inbox-empty', '二维码生成失败，可复制下方链接'));
      }
    } else {
      dom.syncQrBox.appendChild(el('div', 'inbox-empty', '二维码库未加载，请复制下方链接打开'));
    }
  }

  function startSyncCountdown() {
    if (state.sync.timer) clearInterval(state.sync.timer);
    updateSyncCountdown();
    state.sync.timer = window.setInterval(updateSyncCountdown, 1000);
  }

  function updateSyncCountdown() {
    if (!dom.syncCountdown) return;
    if (!state.sync.expiresAt) {
      dom.syncCountdown.textContent = '--:--';
      return;
    }
    const left = state.sync.expiresAt - Date.now() / 1000;
    if (left <= 0) {
      dom.syncCountdown.textContent = '已过期';
      dom.syncCountdown.classList.add('is-expired');
      if (dom.btnSyncRefreshToken) dom.btnSyncRefreshToken.textContent = '重新生成二维码';
      return;
    }
    dom.syncCountdown.classList.remove('is-expired');
    if (dom.btnSyncRefreshToken) dom.btnSyncRefreshToken.textContent = '刷新二维码';
    const minutes = Math.floor(left / 60);
    const seconds = Math.floor(left % 60);
    dom.syncCountdown.textContent = minutes + ':' + pad2(seconds);
  }

  function loadSyncStatus() {
    if (state.sync.statusLoading) return;
    state.sync.statusLoading = true;
    if (dom.btnSyncRefreshStatus) dom.btnSyncRefreshStatus.disabled = true;
    if (dom.syncInboxList && !state.sync.status) {
      clear(dom.syncInboxList);
      const loading = el('div', 'loading-inline');
      loading.appendChild(el('span', 'spinner'));
      loading.appendChild(el('span', null, '正在读取同步文件夹…'));
      dom.syncInboxList.appendChild(loading);
    }
    apiJson('/api/sync/status').then(function (data) {
      state.sync.status = data;
      renderSyncStatus();
    }).catch(function (err) {
      toast('同步状态加载失败：' + friendlyError(err), 'error', 6000);
      if (dom.syncInboxList && !state.sync.status) {
        clear(dom.syncInboxList);
        dom.syncInboxList.appendChild(el('div', 'inbox-empty', '同步文件夹读取失败'));
      }
    }).finally(function () {
      state.sync.statusLoading = false;
      if (dom.btnSyncRefreshStatus) dom.btnSyncRefreshStatus.disabled = false;
    });
  }

  function renderSyncStatus() {
    const data = state.sync.status;
    if (!data) return;
    if (dom.syncInboxPath) {
      dom.syncInboxPath.textContent = '/app/data/inbox';
      if (data.inbox_path) dom.syncInboxPath.title = '实际路径：' + data.inbox_path;
    }
    if (dom.syncCounts) {
      clear(dom.syncCounts);
      [
        ['待处理', data.pending || 0],
        ['已入库', data.processed || 0],
        ['失败', data.failed || 0]
      ].forEach(function (pair) {
        const chip = el('span', 'count-chip');
        chip.appendChild(document.createTextNode(pair[0] + ' '));
        chip.appendChild(el('strong', null, String(pair[1])));
        dom.syncCounts.appendChild(chip);
      });
    }
    if (dom.syncInboxList) {
      clear(dom.syncInboxList);
      const files = Array.isArray(data.inbox) ? data.inbox : [];
      if (!files.length) {
        dom.syncInboxList.appendChild(el('div', 'inbox-empty', '同步文件夹为空：把导出的轨迹文件放进来，或手机扫码上传。'));
      } else {
        files.forEach(function (file) {
          const row = el('div', 'inbox-item');
          const name = el('span', 'inbox-name', file.name || '未知文件');
          name.title = file.name || '';
          row.appendChild(name);
          row.appendChild(el('span', 'inbox-size', formatBytes(file.size)));
          dom.syncInboxList.appendChild(row);
        });
      }
    }
  }

  function scanSyncFolder() {
    if (state.sync.scanning) return;
    state.sync.scanning = true;
    if (dom.btnSyncScan) {
      dom.btnSyncScan.disabled = true;
      dom.btnSyncScan.textContent = '扫描中…';
    }
    apiJson('/api/sync/scan', { method: 'POST' }).then(function (data) {
      const imported = data.imported || 0;
      const duplicates = data.duplicates || 0;
      const errors = Array.isArray(data.errors) ? data.errors : [];
      if (imported) {
        toast('扫描完成：入库 ' + imported + ' 条' + (duplicates ? '，' + duplicates + ' 条重复' : ''), 'success', 4200);
      } else if (duplicates) {
        toast('扫描完成：' + duplicates + ' 条轨迹已在库中', 'info', 3800);
      } else if (!errors.length) {
        toast('同步文件夹里没有可导入的文件', 'info', 3600);
      }
      errors.forEach(function (item) {
        toast('「' + (item.filename || '文件') + '」：' + (item.error || '解析失败'), 'error', 6500);
      });
      if (imported) markLibraryStale();
      loadSyncStatus();
      loadSyncRecent();
    }).catch(function (err) {
      toast('扫描失败：' + friendlyError(err), 'error', 6500);
    }).finally(function () {
      state.sync.scanning = false;
      if (dom.btnSyncScan) {
        dom.btnSyncScan.disabled = false;
        dom.btnSyncScan.textContent = '扫描并入库';
      }
    });
  }

  function bindSyncEvents() {
    if (dom.btnSyncRefreshToken) {
      dom.btnSyncRefreshToken.addEventListener('click', loadSyncToken);
    }
    if (dom.btnSyncRefreshStatus) {
      dom.btnSyncRefreshStatus.addEventListener('click', loadSyncStatus);
    }
    if (dom.btnSyncScan) {
      dom.btnSyncScan.addEventListener('click', scanSyncFolder);
    }
    if (dom.btnSyncRecentRefresh) {
      dom.btnSyncRecentRefresh.addEventListener('click', loadSyncRecent);
    }
  }

  /* ------------------------------ v2 事件总入口 ------------------------------ */

  function bindV2UI() {
    bindLibraryEvents();
    bindMilestoneEvents();
    bindSyncEvents();

    document.querySelectorAll('.sidebar-close').forEach(function (btn) {
      btn.addEventListener('click', closeSidebar);
    });
    if (dom.customTileBackdrop) {
      dom.customTileBackdrop.addEventListener('click', closeCustomTilePanel);
    }
    if (dom.optAutoSave) {
      dom.optAutoSave.addEventListener('change', function () {
        state.autoSave = !!dom.optAutoSave.checked;
        try {
          window.localStorage.setItem('mtm.autoLibrary', state.autoSave ? '1' : '0');
        } catch (e) {
          /* ignore */
        }
        toast(state.autoSave ? '已开启：解析后自动存入轨迹库' : '已关闭自动存入轨迹库', 'info', 2600);
      });
    }
    if (dom.btnSaveTracksToLibrary) {
      dom.btnSaveTracksToLibrary.addEventListener('click', function () {
        saveTracksToLibrary(state.tracks, {});
      });
    }
    if (dom.btnSaveMergedToLibrary) {
      dom.btnSaveMergedToLibrary.addEventListener('click', saveMergedToLibrary);
    }

    // 从手机上传页 / 其他标签页回到本页时，刷新总览轨迹库
    window.addEventListener('focus', function () {
      if (state.page === 'overview' && state.library.loaded && !state.library.loading) {
        state.library.stale = true;
        loadLibrary({ fit: false });
      }
    });
  }


  function openSidebar() {
    if (!isMobile()) return;
    document.body.classList.add('sidebar-open');
    if (dom.sidebarBackdrop) dom.sidebarBackdrop.hidden = false;
    if (dom.sidebarToggle) dom.sidebarToggle.setAttribute('aria-expanded', 'true');
    setTimeout(function () {
      invalidateAllMaps();
    }, 280);
  }

  function closeSidebar() {
    document.body.classList.remove('sidebar-open');
    if (dom.sidebarBackdrop) dom.sidebarBackdrop.hidden = true;
    if (dom.sidebarToggle) dom.sidebarToggle.setAttribute('aria-expanded', 'false');
    setTimeout(function () {
      invalidateAllMaps();
    }, 280);
  }

  function syncDesktopSidebar() {
    if (!isMobile()) {
      document.body.classList.remove('sidebar-open');
      if (dom.sidebarBackdrop) dom.sidebarBackdrop.hidden = true;
      if (dom.sidebarToggle) dom.sidebarToggle.setAttribute('aria-expanded', 'false');
    }
  }

  /* ------------------------------------------------------------------
   * 事件绑定
   * ------------------------------------------------------------------ */

  function bindUI() {
    if (dom.fileInput) {
      dom.fileInput.addEventListener('change', function () {
        const files = Array.prototype.slice.call(dom.fileInput.files || []);
        dom.fileInput.value = '';
        if (files.length) handleFiles(files);
      });
    }

    if (dom.uploadZone) {
      dom.uploadZone.addEventListener('click', function () {
        if (!state.busy.upload && dom.fileInput) dom.fileInput.click();
      });
      dom.uploadZone.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          if (!state.busy.upload && dom.fileInput) dom.fileInput.click();
        }
      });
      ['dragenter', 'dragover'].forEach(function (name) {
        dom.uploadZone.addEventListener(name, function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          dom.uploadZone.classList.add('is-dragover');
        });
      });
      ['dragleave', 'dragend'].forEach(function (name) {
        dom.uploadZone.addEventListener(name, function (ev) {
          ev.preventDefault();
          dom.uploadZone.classList.remove('is-dragover');
        });
      });
      dom.uploadZone.addEventListener('drop', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        dom.uploadZone.classList.remove('is-dragover');
        const transfer = ev.dataTransfer;
        if (transfer && transfer.files && transfer.files.length) {
          handleFiles(Array.prototype.slice.call(transfer.files));
        }
      });
    }

    document.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    document.addEventListener('drop', function (ev) { ev.preventDefault(); });

    if (dom.btnSamples) {
      dom.btnSamples.addEventListener('click', function () { runDemo(); });
    }
    if (dom.btnSampleList) {
      dom.btnSampleList.addEventListener('click', onSampleListButtonClick);
    }
    if (dom.btnEmptySamples) {
      dom.btnEmptySamples.addEventListener('click', function () { runDemo(); });
    }

    if (dom.trackList) {
      dom.trackList.addEventListener('click', function (ev) {
        const card = ev.target.closest('.track-card');
        if (!card) return;
        const uid = card.dataset.uid;
        const actionNode = ev.target.closest('[data-action]');
        if (actionNode) {
          const action = actionNode.dataset.action;
          if (action === 'toggle-visible') {
            ev.stopPropagation();
            toggleTrackVisibility(uid);
            return;
          }
          if (action === 'delete') {
            ev.stopPropagation();
            deleteTrack(uid);
            return;
          }
        }
        if (ev.target.closest('select')) return;
        focusTrack(uid);
      });
      dom.trackList.addEventListener('change', function (ev) {
        const select = ev.target.closest('select.track-crs');
        if (!select) return;
        const card = ev.target.closest('.track-card');
        if (!card) return;
        reparseTrack(card.dataset.uid, select.value);
      });
      dom.trackList.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        if (ev.target && ev.target.classList && ev.target.classList.contains('track-card')) {
          ev.preventDefault();
          focusTrack(ev.target.dataset.uid);
        }
      });
    }

    if (dom.optMode) {
      dom.optMode.addEventListener('change', syncMergeOptionState);
    }
    if (dom.btnAdvanced) {
      dom.btnAdvanced.addEventListener('click', function () { toggleAdvanced(); });
    }
    [dom.optGap, dom.optDedupe, dom.optSimplify, dom.optMaxSpeed].forEach(function (node) {
      if (node) node.addEventListener('input', updateAdvancedSummary);
    });
    if (dom.btnMerge) {
      dom.btnMerge.addEventListener('click', doMerge);
    }
    if (dom.btnReset) {
      dom.btnReset.addEventListener('click', resetAll);
    }
    if (dom.btnExport) {
      dom.btnExport.addEventListener('click', doExport);
    }

    const basemapBars = document.querySelectorAll('.basemap-bar');
    for (let b = 0; b < basemapBars.length; b++) {
      (function (bar) {
        bar.addEventListener('click', function (ev) {
          const button = ev.target.closest('.base-btn');
          if (!button) return;
          const key = button.dataset.basemap;
          if (key === 'custom') {
            openCustomTilePanel();
            return;
          }
          setBasemap(key);
        });
      })(basemapBars[b]);
    }
    if (dom.btnTileApply) dom.btnTileApply.addEventListener('click', applyCustomTile);
    if (dom.btnTileCancel) dom.btnTileCancel.addEventListener('click', closeCustomTilePanel);
    if (dom.btnTileClose) dom.btnTileClose.addEventListener('click', closeCustomTilePanel);

    if (dom.chartTabs) {
      dom.chartTabs.addEventListener('click', function (ev) {
        const button = ev.target.closest('button[data-chart-mode]');
        if (!button || button.disabled) return;
        setChartMode(button.dataset.chartMode);
      });
    }
    if (dom.btnToggleChart) {
      dom.btnToggleChart.addEventListener('click', function () {
        toggleChart();
      });
    }
    if (dom.btnDockExport) {
      dom.btnDockExport.addEventListener('click', function () {
        doExport();
      });
    }
    if (dom.chartCanvas) {
      dom.chartCanvas.addEventListener('mousemove', onChartMouseMove);
      dom.chartCanvas.addEventListener('mouseleave', onChartMouseLeave);
    }

    if (dom.sidebarToggle) {
      dom.sidebarToggle.addEventListener('click', function () {
        if (document.body.classList.contains('sidebar-open')) closeSidebar();
        else openSidebar();
      });
    }
    if (dom.sidebarBackdrop) dom.sidebarBackdrop.addEventListener('click', closeSidebar);

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (dom.customTilePanel && !dom.customTilePanel.hidden) {
        closeCustomTilePanel();
        return;
      }
      if (document.body.classList.contains('sidebar-open')) closeSidebar();
    });

    window.addEventListener('resize', debounce(function () {
      syncDesktopSidebar();
      invalidateAllMaps();
      if (dom.chartPanel && !dom.chartPanel.hidden) scheduleChartRender(state.chartHover);
    }, 180));

    if (typeof ResizeObserver === 'function' && dom.chartWrap) {
      const observer = new ResizeObserver(function () {
        if (dom.chartPanel && !dom.chartPanel.hidden) scheduleChartRender(state.chartHover);
      });
      observer.observe(dom.chartWrap);
    }

    window.addEventListener('beforeunload', function () {
      if (healthTimer) clearInterval(healthTimer);
    });
  }

  /* ------------------------------------------------------------------
   * 初始化
   * ------------------------------------------------------------------ */

  function cacheDom() {
    const ids = [
      'sidebarToggle', 'sidebarClose', 'sidebarBackdrop', 'sidebar', 'sidebarMobileHead',
      'mainTabs', 'shell',
      'uploadZone', 'fileInput', 'uploadHint', 'uploadProgress', 'uploadProgressText',
      'btnSamples', 'btnSampleList', 'samplesBox', 'samplesCount', 'samplesList',
      'trackList', 'trackCount', 'trackEmpty',
      'optMode', 'optSortTime', 'optJoinTracks', 'optGap', 'optDedupe', 'optSimplify', 'optMaxSpeed',
      'optAutoSave', 'btnAdvanced', 'advancedBody', 'advancedSummary',
      'btnMerge', 'btnMergeText', 'btnReset',
      'btnSaveTracksToLibrary', 'btnSaveMergedToLibrary',
      'exportPanel', 'expFormat', 'expCrs', 'expFilename', 'btnExport', 'btnExportText', 'exportHint',
      'map', 'mapEmpty', 'basemapBar', 'mapCrsTag',
      'customTilePanel', 'customTileBackdrop', 'tileUrl', 'tileCrs',
      'btnTileApply', 'btnTileCancel', 'btnTileClose',
      'legend', 'coordReadout',
      'dock', 'dockHint', 'mergedBadge', 'btnDockExport', 'btnToggleChart',
      'statsStrip', 'chartPanel', 'chartTabs', 'chartSub', 'chartWrap', 'chartCanvas',
      'chartEmpty', 'chartTip',
      'btnEmptySamples', 'toastStack', 'demoOverlay', 'demoOverlayText',
      'healthPill', 'healthDot', 'healthText', 'versionBadge',
      'overviewSidebar', 'overviewMap', 'overviewLegend', 'overviewMapEmpty',
      'overviewCoordReadout', 'overviewDock', 'overviewDockHint', 'overviewStats', 'overviewDetail',
      'libSearch', 'libSourceFilter', 'libYearFilter', 'libSummary', 'libList', 'libEmpty',
      'btnLibraryRefresh', 'btnLibraryClear', 'btnOverviewFit',
      'btnGoImport', 'btnGoSync', 'btnEmptyGoImport', 'btnEmptyGoSync',
      'btnOverviewEmptyImport', 'btnOverviewEmptySync',
      'milestoneSidebar', 'milestoneCards', 'milestoneHint', 'milestoneList', 'milestoneEmpty',
      'btnMilestoneRefresh', 'milestoneOnlyVisited', 'milestoneMap', 'milestoneMapEmpty',
      'milestoneLegend', 'milestoneCrsTag', 'milestoneCoordReadout',
      'btnMilestoneGoImport', 'btnMilestoneEmptyImport',
      'syncQrBox', 'syncQrUrl', 'syncCountdown', 'syncMobileLink',
      'btnSyncRefreshToken', 'btnSyncRefreshStatus', 'syncInboxPath', 'syncCounts',
      'syncInboxList', 'btnSyncScan', 'syncRecentList', 'btnSyncRecentRefresh'
    ];
    ids.forEach(function (id) {
      dom[id] = $(id);
    });
  }

  function showFatal(message) {
    const mapNode = dom.map || $('map');
    if (mapNode) {
      clear(mapNode);
      mapNode.appendChild(el('div', 'fatal', message));
    }
    if (dom.mapEmpty) dom.mapEmpty.hidden = true;
  }

  function init() {
    cacheDom();
    if (!window.L) {
      showFatal('地图组件（Leaflet）加载失败，请确认 web/vendor/ 目录文件完整。');
      return;
    }
    L = window.L;
    if (!window.CRS) {
      state.crsMissing = true;
      console.warn('window.CRS 未加载：web/crs.js 缺失，所有坐标按原始 WGS-84 显示。');
      setTimeout(function () {
        toast('坐标转换库 crs.js 未加载，地图将按原始 WGS-84 坐标显示', 'error', 7000);
      }, 700);
    }
    loadPanelPrefs();
    initTabs();
    initResizers();
    initMap();
    initOverviewMap();
    applyFormats(FALLBACK_FORMATS);
    bindUI();
    bindV2UI();
    syncMergeOptionState();
    updateAdvancedSummary();
    renderTracks();
    renderStats(null);
    updateLegend();
    updateMapEmpty();
    updateExportHint();
    updateDockExportVisibility();
    redrawMap();
    updateBasemapUI();
    updateMapCrsTags();
    refreshHealth();
    healthTimer = window.setInterval(refreshHealth, HEALTH_INTERVAL_MS);
    state.panelRequested = isPanelRequested();
    const demoRequested = isDemoRequested();
    loadFormats();
    const initialPage = demoRequested ? 'import' : (pageFromHash() || 'overview');
    showPage(initialPage, { updateHash: false });
    if (demoRequested) {
      window.setTimeout(function () {
        runDemo({ silentSuccess: true });
      }, 350);
    } else if (state.panelRequested) {
      window.setTimeout(function () {
        openSidebar();
      }, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
