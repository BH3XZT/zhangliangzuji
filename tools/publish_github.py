"""发布项目到 GitHub（Git Data API，无需本机安装 git）。

用法：
    set GITHUB_TOKEN=github_pat_xxx
    python tools/publish_github.py

只读取项目文件，不会把 token 写入任何文件。
"""

from __future__ import annotations

import base64
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

OWNER = "BH3XZT"
REPO = "zhangliangzuji"
BRANCH = "main"
API = "https://api.github.com"
PROJECT = Path(__file__).resolve().parent.parent

EXCLUDE_DIRS = {
    ".git", "__pycache__", ".geo_cache", "_shots", "_shots2", "_nas_tools",
    ".private", "dist", "node_modules", ".venv", "venv",
}
EXCLUDE_FILES = {
    ".env", "_test_stderr.log", "debug.log",
}
EXCLUDE_PATHS = {
    # 创建/修改 GitHub Actions workflow 文件需要额外的 Workflows 权限；
    # 当前 Fine-grained token 只有 Contents 权限，因此首次推送跳过该文件。
    ".github/workflows/tests.yml",
}
EXCLUDE_SUFFIXES = (".pyc", ".pyo", ".log", ".tmp")
# data 目录只保留 .gitkeep
KEEP_DATA_GITKEEP = True

CTX = ssl._create_unverified_context()
TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()


def api(method: str, path: str, payload=None):
    url = API + path
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Authorization": "Bearer " + TOKEN,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MapTrackMerger-publisher",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=60) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API {method} {path} -> {exc.code}: {body[:800]}") from exc


def collect_files() -> list[tuple[str, Path, str]]:
    items: list[tuple[str, Path, str]] = []
    for root, dirs, files in os.walk(PROJECT):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        rel_root = os.path.relpath(root, PROJECT)
        if rel_root == ".":
            rel_root = ""
        for name in files:
            rel = os.path.join(rel_root, name).replace("\\", "/")
            path = Path(root) / name
            if rel.startswith("data/"):
                if KEEP_DATA_GITKEEP and rel == "data/.gitkeep":
                    pass
                else:
                    continue
            if name in EXCLUDE_FILES or name.endswith(EXCLUDE_SUFFIXES):
                continue
            if rel in EXCLUDE_PATHS:
                continue
            mode = "100755" if name.endswith(".sh") else "100644"
            items.append((rel, path, mode))
    items.sort(key=lambda item: item[0])
    return items


def main() -> int:
    if not TOKEN:
        print("缺少环境变量 GITHUB_TOKEN", file=sys.stderr)
        return 2
    files = collect_files()
    total = sum(path.stat().st_size for _rel, path, _mode in files)
    print(f"待发布 {len(files)} 个文件，共 {total / 1024 / 1024:.2f} MB")
    for rel, _path, _mode in files[:10]:
        print("  ", rel)
    if len(files) > 10:
        print("   ...")

    status, repo = api("GET", f"/repos/{OWNER}/{REPO}")
    print("仓库：", repo.get("full_name"), "默认分支：", repo.get("default_branch"), "空仓库 size=", repo.get("size"))

    parent_sha = None
    try:
        status, ref = api("GET", f"/repos/{OWNER}/{REPO}/git/ref/heads/{BRANCH}")
        parent_sha = (ref.get("object") or {}).get("sha")
        print("已有 main 提交：", parent_sha, "（将以快进方式新增提交）")
    except RuntimeError as exc:
        if "404" not in str(exc):
            raise
        print("main 分支尚无提交，将创建初始提交")

    tree_entries = []
    for index, (rel, path, mode) in enumerate(files, 1):
        content = path.read_bytes()
        status, blob = api(
            "POST",
            f"/repos/{OWNER}/{REPO}/git/blobs",
            {"content": base64.b64encode(content).decode("ascii"), "encoding": "base64"},
        )
        tree_entries.append({"path": rel, "mode": mode, "type": "blob", "sha": blob["sha"]})
        print(f"  blob {index}/{len(files)} {rel} ({len(content)} bytes)")

    status, tree = api(
        "POST",
        f"/repos/{OWNER}/{REPO}/git/trees",
        {"tree": tree_entries},
    )
    print("tree:", tree.get("sha"), "entries:", len(tree.get("tree") or []))

    message = "Initial commit: 地图轨迹合并工具（Docker 项目）"
    commit_payload = {"message": message, "tree": tree["sha"], "parents": [parent_sha] if parent_sha else []}
    status, commit = api(
        "POST",
        f"/repos/{OWNER}/{REPO}/git/commits",
        commit_payload,
    )
    print("commit:", commit.get("sha"))

    if parent_sha:
        status, ref = api(
            "PATCH",
            f"/repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}",
            {"sha": commit["sha"], "force": False},
        )
        print("ref updated:", ref.get("ref"))
    else:
        status, ref = api(
            "POST",
            f"/repos/{OWNER}/{REPO}/git/refs",
            {"ref": f"refs/heads/{BRANCH}", "sha": commit["sha"]},
        )
        print("ref created:", ref.get("ref"))

    try:
        status, repo = api(
            "PATCH",
            f"/repos/{OWNER}/{REPO}",
            {
                "description": "地图轨迹合并工具（Docker 项目）：统一百度/高德/GPX/KML 轨迹，轨迹库总览、国省市区里程碑、扫码上传与一键部署",
                "homepage": "",
            },
        )
        print("仓库描述已更新：", repo.get("description"))
    except RuntimeError as exc:
        print("仓库描述更新失败（需要 Administration 权限，可忽略）：", str(exc)[:200])

    try:
        status, topics = api(
            "PUT",
            f"/repos/{OWNER}/{REPO}/topics",
            {"names": ["docker", "maps", "gpx", "kml", "track", "self-hosted", "leaflet", "python"]},
        )
        print("topics:", topics.get("names"))
    except RuntimeError as exc:
        print("topics 更新失败（可忽略）：", str(exc)[:200])

    status, contents = api("GET", f"/repos/{OWNER}/{REPO}/contents/README.md?ref={BRANCH}")
    print("README 已上线：", contents.get("html_url"))
    print("完成：https://github.com/" + OWNER + "/" + REPO)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
