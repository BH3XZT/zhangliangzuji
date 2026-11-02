/* ============================================================
 * 地图轨迹合并工具 — 手机扫码上传页逻辑
 * 独立页面：读取 URL token，多文件 POST /api/sync/upload
 * ============================================================ */
(function () {
  'use strict';

  const ACCEPT_EXTS = '.gpx,.kml,.kmz,.tcx,.geojson,.json,.csv,.tsv,.nmea,.log,.fit';
  const MAX_FILE_BYTES = 32 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

  const dom = {};
  const state = {
    token: '',
    files: [],
    uploading: false,
    toastTimer: 0
  };

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

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function clockText() {
    const d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function toast(message, type, timeout) {
    const node = dom.toast;
    if (!node) return;
    node.className = 'm-toast is-show' + (type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : '');
    node.textContent = message;
    node.hidden = false;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () {
      node.classList.remove('is-show');
      window.setTimeout(function () {
        if (!node.classList.contains('is-show')) node.hidden = true;
      }, 220);
    }, timeout || 4200);
  }

  function setTokenStatus(ok, message) {
    const node = dom.tokenStatus;
    if (!node) return;
    node.textContent = message;
    node.className = 'm-status ' + (ok ? 'is-ok' : 'is-error');
  }

  function readToken() {
    try {
      const params = new URLSearchParams(window.location.search);
      return (params.get('token') || '').trim();
    } catch (e) {
      return '';
    }
  }

  function cacheDom() {
    ['tokenStatus', 'fileInput', 'dropZone', 'fileList', 'fileCount', 'btnUpload', 'progressWrap',
      'progressBar', 'progressText', 'resultCard', 'resultBody', 'resultTime', 'btnAgain', 'toast'
    ].forEach(function (id) {
      dom[id] = $(id);
    });
  }

  function addFiles(fileList) {
    if (!fileList || !fileList.length) return;
    let rejected = 0;
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (!file || !file.name) continue;
      if (file.size === 0) {
        toast('「' + file.name + '」是空文件，已跳过', 'error');
        rejected += 1;
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        toast('「' + file.name + '」超过 32MB 限制，已跳过', 'error');
        rejected += 1;
        continue;
      }
      let duplicated = false;
      for (let k = 0; k < state.files.length; k++) {
        const exists = state.files[k];
        if (exists.name === file.name && exists.size === file.size && exists.lastModified === file.lastModified) {
          duplicated = true;
          break;
        }
      }
      if (duplicated) continue;
      state.files.push(file);
    }
    if (state.files.length > 60) {
      state.files = state.files.slice(0, 60);
      toast('一次最多上传 60 个文件', 'error');
    }
    if (rejected) {
      toast('部分文件被跳过（超过大小限制或为空）', 'error');
    }
    renderFiles();
  }

  function removeFile(index) {
    if (state.uploading) return;
    state.files.splice(index, 1);
    renderFiles();
  }

  function renderFiles() {
    if (!dom.fileList) return;
    clear(dom.fileList);
    state.files.forEach(function (file, index) {
      const row = el('div', 'm-file');
      const name = el('span', 'm-file-name', file.name);
      name.title = file.name;
      row.appendChild(name);
      row.appendChild(el('span', 'm-file-size', formatSize(file.size)));
      const remove = el('button', 'm-file-remove', '✕');
      remove.type = 'button';
      remove.setAttribute('aria-label', '移除 ' + file.name);
      remove.addEventListener('click', function () {
        removeFile(index);
      });
      row.appendChild(remove);
      dom.fileList.appendChild(row);
    });
    if (dom.fileCount) {
      const total = state.files.reduce(function (sum, file) { return sum + file.size; }, 0);
      dom.fileCount.textContent = state.files.length + ' 个文件 · ' + formatSize(total);
    }
    updateUploadButton();
  }

  function updateUploadButton() {
    if (!dom.btnUpload) return;
    const blocked = !state.token || state.uploading || !state.files.length;
    dom.btnUpload.disabled = blocked;
    if (state.uploading) {
      dom.btnUpload.textContent = '正在上传…';
    } else if (!state.token) {
      dom.btnUpload.textContent = '令牌缺失，无法上传';
    } else {
      dom.btnUpload.textContent = '开始上传（' + state.files.length + '）';
    }
  }

  function setBusy(busy) {
    state.uploading = busy;
    if (dom.dropZone) dom.dropZone.classList.toggle('is-busy', busy);
    if (dom.fileInput) dom.fileInput.disabled = busy;
    updateUploadButton();
  }

  function showProgress(percent, text) {
    if (!dom.progressWrap) return;
    dom.progressWrap.hidden = false;
    if (dom.progressBar) dom.progressBar.style.width = Math.max(0, Math.min(100, percent)) + '%';
    if (dom.progressText) dom.progressText.textContent = text;
  }

  function hideProgress() {
    if (dom.progressWrap) dom.progressWrap.hidden = true;
  }

  function resultChip(text, type) {
    return el('span', 'm-chip' + (type ? ' is-' + type : ''), text);
  }

  function showResult(data, fallbackError) {
    if (!dom.resultCard || !dom.resultBody) return;
    dom.resultCard.hidden = false;
    if (dom.resultTime) dom.resultTime.textContent = clockText();
    clear(dom.resultBody);
    if (fallbackError) {
      const box = el('div', 'm-error-item', fallbackError);
      dom.resultBody.appendChild(box);
      dom.resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const imported = Number(data.imported) || 0;
    const duplicates = Number(data.duplicates) || 0;
    const saved = Array.isArray(data.saved) ? data.saved.length : 0;
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    const errors = Array.isArray(data.errors) ? data.errors : [];
    const summary = el('div', 'm-result-summary');
    if (imported > 0) summary.appendChild(resultChip('已入库 ' + imported + ' 条', 'success'));
    else summary.appendChild(resultChip('没有新的轨迹入库', 'warn'));
    if (duplicates > 0) summary.appendChild(resultChip('重复 ' + duplicates + ' 条', 'warn'));
    if (saved > 0) summary.appendChild(resultChip('已保存 ' + saved + ' 个文件'));
    if (errors.length) summary.appendChild(resultChip('失败 ' + errors.length + ' 个', 'error'));
    dom.resultBody.appendChild(summary);
    tracks.forEach(function (track) {
      const name = track && (track.name || track.filename || track.source_label);
      if (!name) return;
      dom.resultBody.appendChild(el('div', 'm-result-name', name));
    });
    if (errors.length) {
      dom.resultBody.appendChild(el('p', 'm-error-title', '解析失败的文件：'));
      errors.forEach(function (item) {
        dom.resultBody.appendChild(el('div', 'm-error-item',
          (item.filename || '文件') + '：' + (item.error || '无法识别或解析失败')));
      });
    }
    dom.resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function upload() {
    if (state.uploading) return;
    if (!state.token) {
      setTokenStatus(false, '缺少上传令牌，请回到电脑端「同步」页重新扫码。');
      updateUploadButton();
      toast('缺少上传令牌，无法上传', 'error');
      return;
    }
    if (!state.files.length) {
      toast('请先选择轨迹文件', 'error');
      return;
    }
    const total = state.files.reduce(function (sum, file) { return sum + file.size; }, 0);
    if (total > MAX_TOTAL_BYTES) {
      toast('文件总大小超过 64MB，请分批上传', 'error');
      return;
    }
    const form = new FormData();
    state.files.forEach(function (file) {
      form.append('files', file, file.name);
    });
    setBusy(true);
    if (dom.resultCard) dom.resultCard.hidden = true;
    showProgress(2, '正在上传…');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/sync/upload?token=' + encodeURIComponent(state.token) + '&import=1', true);
    xhr.upload.onprogress = function (ev) {
      if (!ev.lengthComputable) return;
      const percent = Math.round((ev.loaded / ev.total) * 100);
      showProgress(Math.max(2, percent), percent >= 100 ? '上传完成，正在解析入库…' : '上传中 ' + percent + '%');
    };
    xhr.onload = function () {
      setBusy(false);
      let data = null;
      try {
        data = JSON.parse(xhr.responseText || 'null');
      } catch (e) {
        data = null;
      }
      if (xhr.status === 403) {
        setTokenStatus(false, '令牌无效或已过期，请回到电脑端「同步」页刷新二维码后重新扫码。');
        hideProgress();
        showResult(null, '上传被拒绝：令牌无效或已过期，请让电脑端刷新二维码后重试。');
        toast('令牌无效或已过期', 'error', 6000);
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300 || !data || data.ok === false) {
        hideProgress();
        const message = data && data.error ? data.error : '上传失败（HTTP ' + xhr.status + '）';
        showResult(null, message);
        toast('上传失败：' + message, 'error', 6500);
        return;
      }
      hideProgress();
      const imported = Number(data.imported) || 0;
      const duplicates = Number(data.duplicates) || 0;
      if (imported > 0) {
        toast('成功入库 ' + imported + ' 条轨迹', 'success', 4800);
      } else if (duplicates > 0) {
        toast('这些轨迹已经在库中（重复 ' + duplicates + ' 条）', 'info', 4800);
      } else {
        toast('上传完成，结果见下方', 'info', 4200);
      }
      showResult(data, null);
      state.files = [];
      renderFiles();
      hideProgress();
    };
    xhr.onerror = function () {
      setBusy(false);
      hideProgress();
      showResult(null, '网络错误：无法连接 NAS，请确认手机和 NAS / 电脑在同一局域网。');
      toast('网络错误，请检查局域网连接', 'error', 6500);
    };
    xhr.ontimeout = function () {
      setBusy(false);
      hideProgress();
      showResult(null, '上传超时，请检查网络后重试。');
      toast('上传超时', 'error', 6000);
    };
    xhr.send(form);
  }

  function init() {
    cacheDom();
    state.token = readToken();
    if (dom.fileInput) dom.fileInput.accept = ACCEPT_EXTS;
    if (!state.token) {
      setTokenStatus(false, '缺少上传令牌。请回到电脑端「同步」页刷新二维码后重新扫码。');
      toast('缺少上传令牌，无法上传', 'error', 6500);
    } else {
      setTokenStatus(true, '上传令牌已就绪，选择轨迹文件后开始上传。');
    }
    if (dom.fileInput) {
      dom.fileInput.addEventListener('change', function () {
        const files = Array.prototype.slice.call(dom.fileInput.files || []);
        dom.fileInput.value = '';
        addFiles(files);
      });
    }
    if (dom.dropZone) {
      ['dragenter', 'dragover'].forEach(function (name) {
        dom.dropZone.addEventListener(name, function (ev) {
          ev.preventDefault();
          dom.dropZone.classList.add('is-dragover');
        });
      });
      ['dragleave', 'dragend'].forEach(function (name) {
        dom.dropZone.addEventListener(name, function (ev) {
          ev.preventDefault();
          dom.dropZone.classList.remove('is-dragover');
        });
      });
      dom.dropZone.addEventListener('drop', function (ev) {
        ev.preventDefault();
        dom.dropZone.classList.remove('is-dragover');
        if (ev.dataTransfer && ev.dataTransfer.files) {
          addFiles(Array.prototype.slice.call(ev.dataTransfer.files));
        }
      });
    }
    if (dom.btnUpload) dom.btnUpload.addEventListener('click', upload);
    if (dom.btnAgain) {
      dom.btnAgain.addEventListener('click', function () {
        if (dom.resultCard) dom.resultCard.hidden = true;
        hideProgress();
        renderFiles();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
    document.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    document.addEventListener('drop', function (ev) { ev.preventDefault(); });
    renderFiles();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
