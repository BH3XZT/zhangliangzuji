"""HTTP 服务器：静态资源 + JSON API（仅标准库）。"""

from __future__ import annotations

import json
import os
import signal
import socket
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import api, multipart
from .parsers import ParseError

BASE_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = BASE_DIR / "web"
SAMPLES_DIR = BASE_DIR / "samples"

MAX_REQUEST_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 32 * 1024 * 1024

_MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".gpx": "application/gpx+xml",
    ".kml": "application/vnd.google-earth.kml+xml",
    ".tcx": "application/vnd.garmin.tcx+xml",
    ".csv": "text/csv; charset=utf-8",
    ".geojson": "application/geo+json",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "MapTrackMerger/1.1"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # ---------- 基础工具 ----------

    def log_message(self, fmt, *args):  # noqa: A003
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    def _common_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Content-Type-Options", "nosniff")

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self._common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_text(self, status: int, text: str, content_type: str = "text/plain; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(status)
        self._common_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_bytes(self, status: int, body: bytes, content_type: str, extra_headers=None):
        self.send_response(status)
        self._common_headers()
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _read_body(self, max_bytes: int) -> bytes:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            self.close_connection = True
            raise api.ApiError("请求缺少 Content-Length", 411)
        try:
            length = int(length_header)
        except (TypeError, ValueError):
            self.close_connection = True
            raise api.ApiError("Content-Length 无效", 400)
        if length < 0 or length > max_bytes:
            self.close_connection = True
            raise api.ApiError(f"请求体过大（上限 {max_bytes // (1024 * 1024)} MB）", 413)
        data = self.rfile.read(length)
        if len(data) < length:
            raise api.ApiError("请求体读取不完整", 400)
        return data

    def _read_json(self) -> dict:
        body = self._read_body(MAX_REQUEST_BYTES)
        if not body:
            return {}
        return json.loads(body.decode("utf-8-sig"))

    @staticmethod
    def _safe_join(root: Path, relative: str) -> Path | None:
        relative = unquote(relative or "").replace("\\", "/")
        parts = []
        for part in relative.split("/"):
            if part in ("", "."):
                continue
            if part == "..":
                return None
            parts.append(part)
        if not parts:
            return None
        target = (root.joinpath(*parts)).resolve()
        try:
            target.relative_to(root.resolve())
        except ValueError:
            return None
        return target

    def _serve_file(self, path: Path, cache_seconds: int = 0):
        if not path.is_file():
            self._send_text(404, "文件不存在")
            return
        try:
            body = path.read_bytes()
        except OSError:
            self._send_text(500, "读取文件失败")
            return
        content_type = _MIME.get(path.suffix.lower(), "application/octet-stream")
        cache = f"public, max-age={cache_seconds}" if cache_seconds > 0 else "no-cache"
        self._send_bytes(
            200,
            body,
            content_type,
            {
                "Cache-Control": cache,
            },
        )

    # ---------- GET ----------

    def do_GET(self):  # noqa: N802
        try:
            path = unquote(urlparse(self.path).path)
            if path in ("/", "/index.html"):
                self._serve_file(WEB_DIR / "index.html", 0)
                return
            if path in ("/mobile", "/mobile.html"):
                self._serve_file(WEB_DIR / "mobile.html", 0)
                return
            if path in ("/guide", "/guide.html"):
                self._serve_file(WEB_DIR / "guide.html", 0)
                return
            if path.startswith("/static/"):
                target = self._safe_join(WEB_DIR, path[len("/static/") :])
                if target is None:
                    self._send_text(404, "文件不存在")
                    return
                cache = 86400 if "vendor" in target.parts else 0
                self._serve_file(target, cache)
                return
            if path.startswith("/samples/"):
                target = self._safe_join(SAMPLES_DIR, path[len("/samples/") :])
                if target is None:
                    self._send_text(404, "文件不存在")
                    return
                self._serve_file(target, 300)
                return
            if path == "/api/health":
                self._send_json(200, api.health_payload())
                return
            if path == "/api/formats":
                self._send_json(200, api.formats_payload())
                return
            if path == "/api/samples":
                self._send_json(200, api.samples_payload(SAMPLES_DIR))
                return
            if path == "/api/library":
                self._send_json(200, api.library_payload())
                return
            if path.startswith("/api/library/"):
                track_id = path[len("/api/library/") :].strip("/")
                if track_id and "/" not in track_id:
                    self._send_json(200, api.library_track_payload(track_id))
                    return
            if path == "/api/sync/status":
                self._send_json(200, api.sync_status_payload())
                return
            if path == "/api/sync/token":
                self._send_json(200, api.sync_token_payload())
                return
            if path == "/api/milestones":
                self._send_json(200, api.milestones_payload())
                return
            if path == "/api/milestones/geojson":
                query = parse_qs(urlparse(self.path).query)
                crs_name = (query.get("crs") or ["GCJ02"])[0]
                self._send_json(200, api.milestones_geojson_payload(crs_name))
                return
            if path == "/favicon.ico":
                self._send_bytes(204, b"", "image/x-icon")
                return
            if path.startswith("/api/"):
                self._send_json(404, {"ok": False, "error": "接口不存在"})
                return
            self._send_text(404, "页面不存在")
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            try:
                self._send_json(500, {"ok": False, "error": "服务器内部错误"})
            except Exception:  # noqa: BLE001
                self.close_connection = True

    # ---------- POST ----------

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path == "/api/parse":
                self._handle_parse()
                return
            if path == "/api/merge":
                self._handle_merge()
                return
            if path == "/api/export":
                self._handle_export()
                return
            if path == "/api/library/add":
                payload = self._read_json()
                self._send_json(200, api.library_add_payload(payload))
                return
            if path == "/api/sync/scan":
                self._send_json(200, api.sync_scan_payload())
                return
            if path == "/api/sync/upload":
                self._handle_sync_upload()
                return
            if path.startswith("/api/"):
                self._send_json(404, {"ok": False, "error": "接口不存在"})
                return
            self._send_text(404, "页面不存在")
        except api.ApiError as exc:
            self._send_json(exc.status, {"ok": False, "error": exc.message})
        except ParseError as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})
        except json.JSONDecodeError as exc:
            self._send_json(400, {"ok": False, "error": f"JSON 请求体格式错误：{exc}"})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            try:
                self._send_json(500, {"ok": False, "error": "服务器内部错误，请查看容器日志"})
            except Exception:  # noqa: BLE001
                self.close_connection = True

    def _handle_sync_upload(self):
        query = parse_qs(urlparse(self.path).query)
        token = (query.get("token") or [""])[0]
        import_flag = (query.get("import") or ["1"])[0].strip().lower() not in ("0", "false", "no", "off")
        content_type = self.headers.get("Content-Type", "")
        body = self._read_body(MAX_REQUEST_BYTES)
        files, fields = multipart.parse_multipart(body, content_type, MAX_FILE_BYTES)
        if not token:
            token = fields.get("token", "")
        self._send_json(200, api.sync_upload_payload(files, token, import_flag))

    def do_PATCH(self):  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/library/"):
                track_id = path[len("/api/library/") :].strip("/")
                if track_id and "/" not in track_id:
                    payload = self._read_json()
                    self._send_json(200, api.library_update_payload(track_id, payload))
                    return
            self._send_json(404, {"ok": False, "error": "接口不存在"})
        except api.ApiError as exc:
            self._send_json(exc.status, {"ok": False, "error": exc.message})
        except json.JSONDecodeError as exc:
            self._send_json(400, {"ok": False, "error": f"JSON 请求体格式错误：{exc}"})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            try:
                self._send_json(500, {"ok": False, "error": "服务器内部错误，请查看容器日志"})
            except Exception:  # noqa: BLE001
                self.close_connection = True

    def do_DELETE(self):  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path == "/api/library":
                self._send_json(200, api.library_clear_payload())
                return
            if path.startswith("/api/library/"):
                track_id = path[len("/api/library/") :].strip("/")
                if track_id and "/" not in track_id:
                    self._send_json(200, api.library_delete_payload(track_id))
                    return
            self._send_json(404, {"ok": False, "error": "接口不存在"})
        except api.ApiError as exc:
            self._send_json(exc.status, {"ok": False, "error": exc.message})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            try:
                self._send_json(500, {"ok": False, "error": "服务器内部错误，请查看容器日志"})
            except Exception:  # noqa: BLE001
                self.close_connection = True

    def _handle_parse(self):
        content_type = self.headers.get("Content-Type", "")
        body = self._read_body(MAX_REQUEST_BYTES)
        files, fields = multipart.parse_multipart(body, content_type, MAX_FILE_BYTES)
        crs = fields.get("crs", "auto")
        result = api.parse_upload(files, crs)
        self._send_json(200, result)

    def _handle_merge(self):
        body = self._read_body(MAX_REQUEST_BYTES)
        payload = json.loads(body.decode("utf-8-sig"))
        result = api.merge_payload(payload)
        self._send_json(200, result)

    def _handle_export(self):
        body = self._read_body(MAX_REQUEST_BYTES)
        payload = json.loads(body.decode("utf-8-sig"))
        result = api.export_payload(payload)
        filename = result["filename"]
        ascii_fallback = "track" + os.path.splitext(filename)[1]
        disposition = (
            f"attachment; filename=\"{ascii_fallback}\"; "
            f"filename*=UTF-8''{quote(filename)}"
        )
        self._send_bytes(
            200,
            result["data"],
            result["mime"],
            {
                "Content-Disposition": disposition,
                "Cache-Control": "no-store",
            },
        )

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._common_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()


def main() -> int:
    host = os.environ.get("HOST", "0.0.0.0")
    try:
        port = int(os.environ.get("PORT", "8000"))
    except (TypeError, ValueError):
        port = 8000
    if not (WEB_DIR / "index.html").is_file():
        print(f"[警告] 未找到前端页面：{WEB_DIR / 'index.html'}")

    try:
        server = ThreadingHTTPServer((host, port), Handler)
    except OSError as exc:
        print(f"[错误] 无法监听 {host}:{port} —— {exc}")
        print("请检查端口是否被占用，或通过环境变量 PORT 指定其它端口。")
        return 1
    server.daemon_threads = True

    def _stop(signum, frame):  # noqa: ARG001
        print("\n正在关闭服务 ...")
        threading.Thread(target=server.shutdown, daemon=True).start()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _stop)
        except (ValueError, OSError):
            pass

    local_ip = "127.0.0.1"
    try:
        local_ip = socket.gethostbyname(socket.gethostname())
    except OSError:
        pass
    print("=" * 62)
    print("  地图轨迹合并工具  MapTrackMerger v" + api.VERSION)
    print(f"  本机访问:   http://127.0.0.1:{port}")
    print(f"  局域网访问: http://{local_ip}:{port}")
    print(f"  数据目录:   {BASE_DIR / 'data'}")
    print("=" * 62)
    sys.stdout.flush()

    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    print("服务已停止。")
    return 0
