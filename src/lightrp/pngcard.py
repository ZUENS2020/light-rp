from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path


PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _read_chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    if not data.startswith(PNG_SIG):
        raise ValueError("not a PNG file")
    offset = len(PNG_SIG)
    chunks: list[tuple[bytes, bytes]] = []
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        tag = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        offset = offset + 12 + length
        chunks.append((tag, payload))
        if tag == b"IEND":
            break
    return chunks


def decode_png_text(path: Path) -> dict[str, str]:
    data = path.read_bytes()
    out: dict[str, str] = {}
    for tag, payload in _read_chunks(data):
        if tag == b"tEXt":
            key, _, rest = payload.partition(b"\x00")
            out[key.decode("latin-1")] = rest.decode("latin-1", errors="replace")
        elif tag == b"zTXt":
            key, _, rest = payload.partition(b"\x00")
            if not rest:
                continue
            method, compressed = rest[0], rest[1:]
            if method != 0:
                continue
            out[key.decode("latin-1")] = zlib.decompress(compressed).decode("utf-8", errors="replace")
        elif tag == b"iTXt":
            key, _, rest = payload.partition(b"\x00")
            if len(rest) < 2:
                continue
            compressed_flag, _comp_method = rest[0], rest[1]
            rest = rest[2:]
            _, _, rest = rest.partition(b"\x00")  # lang
            _, _, text = rest.partition(b"\x00")  # translated key
            if compressed_flag:
                text = zlib.decompress(text)
            out[key.decode("utf-8", errors="replace")] = text.decode("utf-8", errors="replace")
    return out


def png_card_json(path: Path) -> dict:
    texts = decode_png_text(path)
    raw = texts.get("ccv3") or texts.get("chara")
    if not raw:
        raise ValueError(f"PNG has no chara/ccv3 text chunk: {path}")
    import base64

    decoded = base64.b64decode(raw)
    obj = json.loads(decoded.decode("utf-8"))
    if not isinstance(obj, dict):
        raise ValueError("character card JSON must be an object")
    return obj


def write_png_with_text(path: Path, texts: dict[str, str]) -> None:
    """Minimal 1x1 PNG with tEXt chunks (for tests)."""

    def chunk(tag: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(tag + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    raw = b"\x00\xff\x00\x00"
    parts = [PNG_SIG, chunk(b"IHDR", ihdr)]
    for key, value in texts.items():
        payload = key.encode("latin-1") + b"\x00" + value.encode("latin-1")
        parts.append(chunk(b"tEXt", payload))
    parts.append(chunk(b"IDAT", zlib.compress(raw)))
    parts.append(chunk(b"IEND", b""))
    path.write_bytes(b"".join(parts))
