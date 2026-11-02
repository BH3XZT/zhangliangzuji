"""multipart/form-data 表单解析（仅标准库）。"""

from __future__ import annotations

import os
from email import policy
from email.parser import BytesParser

from .parsers.common import ParseError


def parse_multipart(body: bytes, content_type: str, max_file_bytes: int = 32 * 1024 * 1024):
    """返回 (files, fields)。

    files: [{"filename": str, "content": bytes, "content_type": str}, ...]
    fields: {name: str}
    """
    if not content_type or "multipart/form-data" not in content_type.lower():
        raise ParseError("请求必须使用 multipart/form-data 上传")
    raw = (
        b"Content-Type: "
        + content_type.encode("latin-1", "replace")
        + b"\r\nMIME-Version: 1.0\r\n\r\n"
        + body
    )
    try:
        message = BytesParser(policy=policy.HTTP).parsebytes(raw)
    except Exception as exc:  # noqa: BLE001
        raise ParseError(f"表单数据解析失败：{exc}") from exc
    if not message.is_multipart():
        raise ParseError("无效的表单数据（不是 multipart）")

    files = []
    fields: dict[str, str] = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if filename is not None:
            filename = os.path.basename(str(filename).replace("\\", "/")).strip()
            if not filename:
                continue
            if len(payload) > max_file_bytes:
                raise ParseError(
                    f"文件「{filename}」超过 {max_file_bytes // (1024 * 1024)} MB 限制"
                )
            files.append(
                {
                    "filename": filename,
                    "content": payload,
                    "content_type": part.get_content_type(),
                }
            )
        elif name:
            try:
                fields[name] = payload.decode("utf-8", errors="replace").strip()
            except Exception:  # noqa: BLE001
                fields[name] = ""
    return files, fields
