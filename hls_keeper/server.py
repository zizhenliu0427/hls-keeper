from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import requests

from .archive import FanboxArchiveDownloader, parse_headers_json


APP_NAME = "HLS Keeper"
APP_VERSION = "0.1.0"
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_DIR = ROOT / "data"
DEFAULT_OUTPUT_DIR = ROOT / "outputs"
DEFAULT_ARCHIVE_DIR = ROOT / "archives"
DEFAULT_FFMPEG = r"C:\ffmpeg\bin\ffmpeg.exe"
DEFAULT_FFPROBE = r"C:\ffmpeg\bin\ffprobe.exe"

MEDIA_RE = re.compile(r"\.(?P<kind>m3u8|ts|key|vtt|srt|ttml|dfxp|ass|ssa)(?:[?#]|$)", re.I)
JK_SEGMENT_RE = re.compile(r"/v/(?P<product>[^/]+)/(?P<resolution>\d+x\d+)/(?P<name>[^/?#]+\.ts)(?:[?#]|$)", re.I)
JK_AUX_RE = re.compile(r"/v/(?P<product>[^/]+)/(?P<resolution>\d+x\d+)/(?P<name>[^/?#]+\.(?:m3u8|key|vtt|srt|ttml|dfxp|ass|ssa))(?:[?#]|$)", re.I)
NUMERIC_TS_RE = re.compile(r"(?P<prefix>.*?)(?P<num>\d+)(?P<suffix>\.ts)$", re.I)
NUMERIC_TS_ANY_RE = re.compile(r"(?P<prefix>.*?)(?P<num>\d+)(?P<suffix>\.ts)(?P<trailer>[?#].*)?$", re.I)
RESOLUTION_RE = re.compile(r"(?P<w>\d{3,5})x(?P<h>\d{3,5})")
SUBTITLE_KINDS = {"vtt", "srt", "ttml", "dfxp", "ass", "ssa"}
SUBTITLE_CONVERT_MODES = {"none", "zh-hans", "zh-hant", "en-us", "en-gb"}
SUBTITLE_CONVERT_SUFFIXES = {
    "zh-hans": ".zh-hans",
    "zh-hant": ".zh-hant",
    "en-us": ".en-us",
    "en-gb": ".en-gb",
}
SUBTITLE_FILE_SUFFIXES = {f".{kind}" for kind in SUBTITLE_KINDS}
JK_AVIDEO_SUBTITLE_KEY = "mYq3t6w9y$B&E)H@"
VTT_CUE_RE = re.compile(r"(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})")

ZH_T2S_PHRASES = {
    "繁體中文": "简体中文",
    "繁體": "繁体",
    "臺灣": "台湾",
    "香港": "香港",
    "軟體": "软件",
    "影片": "影片",
}
ZH_S2T_PHRASES = {value: key for key, value in ZH_T2S_PHRASES.items()}
ZH_T2S_CHARS = str.maketrans({
    "後": "后", "裏": "里", "裡": "里", "妳": "你", "們": "们", "這": "这", "那": "那",
    "個": "个", "會": "会", "來": "来", "時": "时", "過": "过", "還": "还", "沒": "没",
    "說": "说", "話": "话", "聽": "听", "見": "见", "讓": "让", "給": "给", "對": "对",
    "點": "点", "麼": "么", "嗎": "吗", "呢": "呢", "吧": "吧", "為": "为", "與": "与",
    "於": "于", "從": "从", "開": "开", "關": "关", "進": "进", "出": "出", "發": "发",
    "現": "现", "實": "实", "體": "体", "應": "应", "該": "该", "選": "选", "擇": "择",
    "畫": "画", "質": "质", "檔": "档", "網": "网", "頁": "页", "瀏": "浏", "覽": "览",
    "器": "器", "載": "载", "傳": "传", "轉": "转", "換": "换", "簡": "简", "異": "异",
    "常": "常", "錯": "错", "誤": "误", "請": "请", "認": "认", "證": "证", "權": "权",
    "態": "态", "訊": "讯", "號": "号", "線": "线", "樂": "乐", "愛": "爱", "氣": "气",
    "國": "国", "學": "学", "習": "习", "書": "书", "電": "电", "腦": "脑", "頭": "头",
    "長": "长", "門": "门", "間": "间", "問": "问", "題": "题", "處": "处", "理": "理",
    "標": "标", "題": "题", "顯": "显", "示": "示", "聲": "声", "音": "音", "雲": "云",
})
ZH_S2T_CHARS = str.maketrans({
    "后": "後", "里": "裡", "你": "你", "们": "們", "这": "這", "个": "個", "会": "會",
    "来": "來", "时": "時", "过": "過", "还": "還", "没": "沒", "说": "說", "话": "話",
    "听": "聽", "见": "見", "让": "讓", "给": "給", "对": "對", "点": "點", "么": "麼",
    "吗": "嗎", "为": "為", "与": "與", "于": "於", "从": "從", "开": "開", "关": "關",
    "进": "進", "发": "發", "现": "現", "实": "實", "体": "體", "应": "應", "该": "該",
    "选": "選", "择": "擇", "画": "畫", "质": "質", "档": "檔", "网": "網", "页": "頁",
    "浏": "瀏", "览": "覽", "载": "載", "传": "傳", "转": "轉", "换": "換", "简": "簡",
    "异": "異", "错": "錯", "误": "誤", "请": "請", "认": "認", "证": "證", "权": "權",
    "态": "態", "讯": "訊", "号": "號", "线": "線", "乐": "樂", "爱": "愛", "气": "氣",
    "国": "國", "学": "學", "习": "習", "书": "書", "电": "電", "脑": "腦", "头": "頭",
    "长": "長", "门": "門", "间": "間", "问": "問", "题": "題", "处": "處", "标": "標",
    "显": "顯", "声": "聲", "云": "雲",
})

EN_GB_TO_US = {
    "colour": "color", "colours": "colors", "favour": "favor", "favours": "favors",
    "favourite": "favorite", "favourites": "favorites", "honour": "honor", "honours": "honors",
    "behaviour": "behavior", "behaviours": "behaviors", "centre": "center", "centres": "centers",
    "theatre": "theater", "theatres": "theaters", "metre": "meter", "metres": "meters",
    "litre": "liter", "litres": "liters", "grey": "gray", "organise": "organize",
    "organised": "organized", "organising": "organizing", "realise": "realize",
    "realised": "realized", "realising": "realizing", "recognise": "recognize",
    "recognised": "recognized", "recognising": "recognizing", "analyse": "analyze",
    "analysed": "analyzed", "analysing": "analyzing", "defence": "defense",
    "licence": "license", "travelling": "traveling", "travelled": "traveled",
    "cancelled": "canceled", "cancelling": "canceling", "programme": "program",
}
EN_US_TO_GB = {value: key for key, value in EN_GB_TO_US.items()}


@dataclass(frozen=True)
class MediaRef:
    product: str
    resolution: str
    name: str
    kind: str
    url: str
    num: int | None
    width: int


def now() -> int:
    return int(time.time())


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def jwt_payload(token: str) -> dict[str, Any]:
    token = (token or "").strip()
    if token.lower().startswith("bearer "):
        token = token.split(None, 1)[1]
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    payload += "=" * (-len(payload) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
    except Exception:
        return {}


def safe_name(value: str) -> str:
    value = unquote(value).strip() or "unknown"
    return re.sub(r"[^A-Za-z0-9._=-]+", "_", value).strip("._") or "unknown"


def normalize_subtitle_convert_mode(value: str | None) -> str:
    mode = (value or "none").strip().lower()
    if mode not in SUBTITLE_CONVERT_MODES:
        raise RuntimeError(f"subtitle_convert_mode must be one of: {', '.join(sorted(SUBTITLE_CONVERT_MODES))}")
    return mode


def replace_phrases(text: str, phrases: dict[str, str]) -> str:
    for source, target in sorted(phrases.items(), key=lambda item: len(item[0]), reverse=True):
        text = text.replace(source, target)
    return text


def convert_with_opencc(text: str, config: str) -> str | None:
    try:
        from opencc import OpenCC  # type: ignore
    except Exception:
        return None
    try:
        return OpenCC(config).convert(text)
    except Exception:
        return None


def preserve_case(source: str, target: str) -> str:
    if source.isupper():
        return target.upper()
    if source[:1].isupper():
        return target[:1].upper() + target[1:]
    return target


def convert_english_spelling(text: str, replacements: dict[str, str]) -> str:
    if not replacements:
        return text
    pattern = re.compile(r"\b(" + "|".join(re.escape(word) for word in sorted(replacements, key=len, reverse=True)) + r")\b", re.I)

    def repl(match: re.Match[str]) -> str:
        source = match.group(0)
        target = replacements.get(source.lower(), source)
        return preserve_case(source, target)

    return pattern.sub(repl, text)


def apply_custom_subtitle_phrases(text: str, mode: str, phrases: dict[str, str] | None) -> str:
    if not phrases:
        return text
    if mode in {"en-us", "en-gb"}:
        return convert_english_spelling(text, phrases)
    return replace_phrases(text, phrases)


def convert_subtitle_text(text: str, mode: str, custom_phrases: dict[str, str] | None = None) -> str:
    mode = normalize_subtitle_convert_mode(mode)
    if mode == "none":
        return text
    if mode == "zh-hans":
        converted = convert_with_opencc(text, "t2s")
        if converted is not None:
            return apply_custom_subtitle_phrases(converted, mode, custom_phrases)
        converted = replace_phrases(text, ZH_T2S_PHRASES).translate(ZH_T2S_CHARS)
        return apply_custom_subtitle_phrases(converted, mode, custom_phrases)
    if mode == "zh-hant":
        converted = convert_with_opencc(text, "s2t")
        if converted is not None:
            return apply_custom_subtitle_phrases(converted, mode, custom_phrases)
        converted = replace_phrases(text, ZH_S2T_PHRASES).translate(ZH_S2T_CHARS)
        return apply_custom_subtitle_phrases(converted, mode, custom_phrases)
    if mode == "en-us":
        converted = convert_english_spelling(text, EN_GB_TO_US)
        return apply_custom_subtitle_phrases(converted, mode, custom_phrases)
    if mode == "en-gb":
        converted = convert_english_spelling(text, EN_US_TO_GB)
        return apply_custom_subtitle_phrases(converted, mode, custom_phrases)
    return text


def converted_subtitle_path(path: Path, mode: str) -> Path:
    suffix = SUBTITLE_CONVERT_SUFFIXES[mode]
    return path.with_name(f"{path.stem}{suffix}{path.suffix}")


def is_generated_subtitle(path: Path) -> bool:
    return any(path.stem.endswith(suffix) for suffix in SUBTITLE_CONVERT_SUFFIXES.values())


def parse_resolution(value: str) -> tuple[int, int]:
    match = RESOLUTION_RE.fullmatch(value)
    if not match:
        return 0, 0
    return int(match.group("w")), int(match.group("h"))


def subtitle_time_seconds(value: str) -> float:
    parts = value.split(":")
    if len(parts) == 2:
        minute, second = parts
        return int(minute) * 60 + float(second)
    hour, minute, second = parts
    return int(hour) * 3600 + int(minute) * 60 + float(second)


def media_ref_from_url(url: str) -> MediaRef | None:
    parsed = urlparse(url)
    path = parsed.path
    kind_match = MEDIA_RE.search(path)
    if not kind_match:
        return None
    kind = kind_match.group("kind").lower()

    if kind == "ts":
        match = JK_SEGMENT_RE.search(path)
        if match:
            product = safe_name(match.group("product"))
            resolution = safe_name(match.group("resolution"))
            name = safe_name(match.group("name"))
            num_match = NUMERIC_TS_RE.match(name)
            width, _ = parse_resolution(resolution)
            return MediaRef(product, resolution, name, kind, url, int(num_match.group("num")) if num_match else None, width)
    else:
        match = JK_AUX_RE.search(path)
        if match:
            product = safe_name(match.group("product"))
            resolution = safe_name(match.group("resolution"))
            name = safe_name(match.group("name"))
            width, _ = parse_resolution(resolution)
            return MediaRef(product, resolution, name, kind, url, None, width)

    parts = [safe_name(part) for part in path.strip("/").split("/") if part]
    name = parts[-1] if parts else safe_name(Path(path).name)
    resolution = next((part for part in reversed(parts[:-1]) if RESOLUTION_RE.fullmatch(part)), "unknown")
    product = "unknown"
    if resolution in parts:
        idx = parts.index(resolution)
        if idx > 0:
            product = parts[idx - 1]
    if product == "unknown":
        product = safe_name(parsed.netloc.split(":")[0])
    width, _ = parse_resolution(resolution)
    num_match = NUMERIC_TS_RE.match(name)
    return MediaRef(product, resolution, name, kind, url, int(num_match.group("num")) if num_match else None, width)


def headers_from_browser(raw_headers: list[dict[str, str]]) -> dict[str, str]:
    blocked = {
        "host",
        "connection",
        "content-length",
        "accept-encoding",
        "if-none-match",
        "if-modified-since",
    }
    headers: dict[str, str] = {}
    for item in raw_headers:
        name = item.get("name", "")
        value = item.get("value", "")
        if name and name.lower() not in blocked:
            headers[name] = value
    return headers


def redacted_headers(headers: dict[str, str]) -> dict[str, str]:
    secret_names = {"authorization", "cookie", "x-api-key", "x-token"}
    result: dict[str, str] = {}
    for key, value in headers.items():
        if key.lower() in secret_names:
            result[key] = "<redacted>"
        else:
            result[key] = value
    return result


def subtitle_path_preference(path_text: str) -> int:
    parts = {part.lower() for part in Path(path_text).parts}
    if "new folder" in parts:
        return 0
    if "subtitles" in parts and "api" in parts:
        return 2
    if "subtitles" in parts:
        return 1
    return 3


class CaptureStore:
    def __init__(
        self,
        data_dir: Path,
        output_dir: Path,
        archive_dir: Path,
        ffmpeg: str,
        workers: int,
        burst_ahead: int,
        backfill: int,
        min_segment_bytes: int,
        auto_retry_seconds: int,
    ):
        self.data_dir = data_dir
        self.output_dir = output_dir
        self.archive_dir = archive_dir
        self.ffmpeg = ffmpeg
        self.ffprobe = str(Path(ffmpeg).with_name("ffprobe.exe")) if ffmpeg.lower().endswith(".exe") else "ffprobe"
        self.workers = workers
        self.burst_ahead = burst_ahead
        self.backfill = backfill
        self.min_segment_bytes = min_segment_bytes
        self.auto_retry_seconds = auto_retry_seconds
        self.capture_dir = data_dir / "captures"
        self.state_path = data_dir / "state.json"
        self.subtitle_dictionary_path = data_dir / "subtitle_dictionary.json"
        self.event_log_path = data_dir / "events.jsonl"
        self.request_log_path = data_dir / "requests.jsonl"
        self.capture_dir.mkdir(parents=True, exist_ok=True)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.archive_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)

        self.session = requests.Session()
        self.executor = ThreadPoolExecutor(max_workers=workers)
        self.lock = threading.RLock()
        self.inflight: set[str] = set()
        self.state: dict[str, Any] = self.load_state()
        self.started = time.time()
        self.stop_event = threading.Event()
        if auto_retry_seconds > 0:
            threading.Thread(target=self.retry_loop, daemon=True).start()

    def opencc_available(self) -> bool:
        return convert_with_opencc("test", "s2t") is not None

    def subtitle_dictionary_for(self, mode: str) -> dict[str, str]:
        mode = normalize_subtitle_convert_mode(mode)
        if mode == "none" or not self.subtitle_dictionary_path.exists():
            return {}
        try:
            data = json.loads(self.subtitle_dictionary_path.read_text(encoding="utf-8"))
        except Exception as exc:
            self.log_event({"type": "subtitle-dictionary-error", "path": str(self.subtitle_dictionary_path), "error": str(exc)})
            return {}
        phrases = data.get(mode, {})
        if not isinstance(phrases, dict):
            return {}
        return {str(source): str(target) for source, target in phrases.items() if str(source)}

    def load_state(self) -> dict[str, Any]:
        if self.state_path.exists():
            try:
                return json.loads(self.state_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {
            "app": APP_NAME,
            "version": APP_VERSION,
            "counters": {"seen": 0, "saved": 0, "ignored": 0, "failed": 0, "bad_small": 0, "pings": 0},
            "streams": {},
            "jobs": {},
            "candidates": {},
            "archive_headers": {},
            "subtitle_hints": [],
            "last_ping": None,
            "created_at": now(),
        }

    def save_state(self) -> None:
        tmp = self.state_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.state_path)

    def log_event(self, event: dict[str, Any]) -> None:
        event["time"] = now()
        with self.event_log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")

    def stream_key(self, product: str, resolution: str) -> str:
        return f"{product}/{resolution}"

    def stream_dir(self, product: str, resolution: str) -> Path:
        return self.capture_dir / product / resolution

    def update_job(self, job_id: str, **updates: Any) -> None:
        with self.lock:
            jobs = self.state.setdefault("jobs", {})
            job = jobs.setdefault(job_id, {})
            job.update(updates)
            job["updated_at"] = now()
            self.save_state()

    def ensure_stream(self, ref: MediaRef) -> dict[str, Any]:
        key = self.stream_key(ref.product, ref.resolution)
        streams = self.state.setdefault("streams", {})
        stream = streams.setdefault(
            key,
            {
                "product": ref.product,
                "resolution": ref.resolution,
                "width": ref.width,
                "first_seen": now(),
                "last_seen": None,
                "last_url": None,
                "sample_url": None,
                "sample_headers": {},
                "playlist": None,
                "key": None,
                "segments_seen": 0,
                "segments_saved": 0,
                "subtitles": {},
                "failures": {},
                "bad_small": {},
                "last_segment": None,
            },
        )
        stream["last_seen"] = now()
        stream["last_url"] = ref.url
        if ref.kind == "ts":
            stream["sample_url"] = ref.url
        return stream

    def enqueue_payload(self, payload: dict[str, Any]) -> tuple[int, str]:
        url = payload.get("url", "")
        ref = media_ref_from_url(url)
        if not ref:
            with self.lock:
                self.state["counters"]["ignored"] += 1
                self.save_state()
            return 204, "ignored"

        headers = headers_from_browser(payload.get("requestHeaders", []))
        request_record = {
            "url": url,
            "headers": headers,
            "redacted_headers": redacted_headers(headers),
            "timeStamp": payload.get("timeStamp"),
            "received_at": now(),
        }
        with self.lock:
            self.state["counters"]["seen"] += 1
            stream = self.ensure_stream(ref)
            stream["sample_headers"] = headers
            if ref.kind == "m3u8":
                stream["playlist"] = ref.name
            if ref.kind == "key":
                stream["key"] = ref.name
            if ref.kind in SUBTITLE_KINDS:
                stream.setdefault("subtitles", {})[ref.name] = {"url": ref.url, "updated_at": now()}
            if ref.kind == "ts":
                stream["segments_seen"] += 1
                stream["last_segment"] = ref.name
            with self.request_log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(request_record, ensure_ascii=False) + "\n")
            self.save_state()

        if ref.kind == "ts" and ref.num is not None:
            self.queue_segment_range(ref, headers)
        else:
            self.queue_one(ref, headers)
        return 200, "queued"

    def queue_segment_range(self, ref: MediaRef, headers: dict[str, str]) -> None:
        first = max(0, (ref.num or 0) - self.backfill)
        last = (ref.num or 0) + self.burst_ahead
        for num in range(first, last + 1):
            name = replace_segment_number(ref.name, num)
            url = replace_segment_number(ref.url, num)
            item = MediaRef(ref.product, ref.resolution, name, ref.kind, url, num, ref.width)
            self.queue_one(item, headers)

    def queue_one(self, ref: MediaRef, headers: dict[str, str], reason: str = "capture") -> None:
        dest = self.stream_dir(ref.product, ref.resolution) / ref.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        key = self.stream_key(ref.product, ref.resolution) + "/" + ref.name
        with self.lock:
            if dest.exists() and dest.stat().st_size >= self.min_segment_bytes:
                return
            if key in self.inflight:
                return
            self.inflight.add(key)
        self.executor.submit(self.download_one, ref, headers, dest, key, reason)

    def download_one(self, ref: MediaRef, headers: dict[str, str], dest: Path, key: str, reason: str) -> None:
        suffix = ".part" if ref.kind != "ts" else ".ts.part"
        tmp = dest.with_suffix(suffix)
        try:
            response = self.session.get(ref.url, headers=headers, timeout=30)
            content = response.content
            if response.status_code != 200:
                raise RuntimeError(f"HTTP {response.status_code}, {len(content)} bytes")
            if ref.kind == "ts" and len(content) < self.min_segment_bytes:
                with self.lock:
                    self.state["counters"]["bad_small"] += 1
                    stream = self.ensure_stream(ref)
                    stream.setdefault("bad_small", {})[ref.name] = {
                        "bytes": len(content),
                        "reason": reason,
                        "updated_at": now(),
                    }
                    self.save_state()
                raise RuntimeError(f"too small to be a TS segment: {len(content)} bytes")
            if not content:
                raise RuntimeError("empty response")
            tmp.write_bytes(content)
            tmp.replace(dest)
            with self.lock:
                self.state["counters"]["saved"] += 1
                stream = self.ensure_stream(ref)
                if ref.kind == "ts":
                    stream["segments_saved"] += 1
                self.save_state()
            print(f"SAVED {key} {len(content)} bytes", flush=True)
            self.log_event({"type": "saved", "key": key, "bytes": len(content), "reason": reason})
        except Exception as exc:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
            with self.lock:
                self.state["counters"]["failed"] += 1
                stream = self.ensure_stream(ref)
                stream.setdefault("failures", {})[ref.name] = {
                    "error": str(exc),
                    "reason": reason,
                    "updated_at": now(),
                }
                self.save_state()
            print(f"FAILED {key}: {exc}", flush=True)
            self.log_event({"type": "failed", "key": key, "error": str(exc), "reason": reason})
        finally:
            with self.lock:
                self.inflight.discard(key)

    def record_ping(self, payload: dict[str, Any]) -> None:
        with self.lock:
            self.state["counters"]["pings"] += 1
            self.state["last_ping"] = {
                "reason": payload.get("reason", ""),
                "scriptVersion": payload.get("scriptVersion", ""),
                "url": payload.get("url", ""),
                "client_time": payload.get("time", ""),
                "server_time": now(),
            }
            self.save_state()

    def record_candidate(self, payload: dict[str, Any]) -> tuple[int, str]:
        url = payload.get("url", "")
        ref = media_ref_from_url(url)
        headers = headers_from_browser(payload.get("requestHeaders", []))
        tab_id = payload.get("tabId")
        if not ref and payload.get("kindHint") == "subtitle-hint":
            request_body = payload.get("requestBody") or {}
            hint_record = {
                "url": url,
                "method": payload.get("method") or "GET",
                "has_body": bool(request_body.get("rawBase64") or request_body.get("formData")),
                "raw_base64_length": len(request_body.get("rawBase64") or ""),
                "has_form": bool(request_body.get("formData")),
                "tab_id": tab_id,
                "updated_at": now(),
                "requestBody": request_body,
                "headers": headers,
            }
            with self.lock:
                all_hints = self.state.setdefault("subtitle_hints", [])
                all_hints.append(hint_record)
                del all_hints[:-100]
                candidates = self.state.setdefault("candidates", {})
                matching = [
                    item for item in candidates.values()
                    if (tab_id is None or item.get("tab_id") == tab_id) and now() - int(item.get("last_seen") or 0) < 900
                ]
                if not matching:
                    matching = list(candidates.values())
                if matching:
                    target = max(matching, key=lambda item: item.get("last_seen", 0))
                    candidate_key = self.stream_key(target.get("product", "unknown"), target.get("resolution", "unknown"))
                    item = candidates[candidate_key]
                else:
                    candidate_key = self.stream_key("subtitle_hints", "unknown")
                    item = candidates.setdefault(
                        candidate_key,
                        {
                            "product": "subtitle_hints",
                            "resolution": "unknown",
                            "width": 0,
                            "first_seen": now(),
                            "seen": 0,
                            "playlist_url": "",
                            "segment_url": "",
                            "key_url": "",
                            "subtitle_urls": {},
                            "subtitle_hints": {},
                            "subtitle_hint_details": {},
                            "sample_headers": {},
                        },
                    )
                item["seen"] = int(item.get("seen") or 0) + 1
                item["last_seen"] = now()
                item["last_url"] = url
                item["sample_headers"] = headers
                item["tab_id"] = tab_id
                hint_name = safe_name(urlparse(url).path.rsplit("/", 1)[-1] or f"hint_{now()}")
                item.setdefault("subtitle_hints", {})[hint_name] = url
                item.setdefault("subtitle_hint_details", {})[hint_name] = {
                    "url": url,
                    "method": payload.get("method") or "GET",
                    "requestBody": request_body,
                    "headers": headers,
                    "updated_at": now(),
                }
                self.save_state()
            return 200, "subtitle-hint"
        if not ref:
            return 204, "ignored"
        candidate_key = self.stream_key(ref.product, ref.resolution)
        with self.lock:
            candidates = self.state.setdefault("candidates", {})
            item = candidates.setdefault(
                candidate_key,
                {
                    "product": ref.product,
                    "resolution": ref.resolution,
                    "width": ref.width,
                    "first_seen": now(),
                    "seen": 0,
                    "playlist_url": "",
                    "segment_url": "",
                    "key_url": "",
                    "subtitle_urls": {},
                    "subtitle_hints": {},
                    "subtitle_hint_details": {},
                    "sample_headers": {},
                },
            )
            item["seen"] = int(item.get("seen") or 0) + 1
            item["last_seen"] = now()
            item["last_url"] = url
            item["sample_headers"] = headers
            item["tab_id"] = tab_id
            if ref.kind == "m3u8":
                item["playlist_url"] = url
                try:
                    playlist_text = self.fetch_text(url, headers)
                    variants = self.playlist_variants(url, playlist_text)
                    if variants:
                        item["variants"] = variants
                except Exception:
                    pass
            elif ref.kind == "ts":
                item["segment_url"] = url
            elif ref.kind == "key":
                item["key_url"] = url
            elif ref.kind in SUBTITLE_KINDS:
                item.setdefault("subtitle_urls", {})[ref.name] = url
            # Keep the most recent 200 candidates so discovery stays lightweight.
            if len(candidates) > 200:
                oldest = sorted(candidates.items(), key=lambda pair: pair[1].get("last_seen", 0))[:-200]
                for key, _ in oldest:
                    candidates.pop(key, None)
            self.save_state()
        return 200, "candidate"

    def retry_loop(self) -> None:
        while not self.stop_event.wait(self.auto_retry_seconds):
            self.retry_missing(limit_per_stream=50)

    def retry_missing(self, product: str | None = None, resolution: str | None = None, limit_per_stream: int = 200) -> dict[str, Any]:
        queued: list[str] = []
        with self.lock:
            streams = list(self.state.get("streams", {}).values())
        for stream in streams:
            if product and stream["product"] != product:
                continue
            if resolution and stream["resolution"] != resolution:
                continue
            sample_url = stream.get("sample_url")
            headers = stream.get("sample_headers") or {}
            if not sample_url or not headers:
                continue
            missing = self.stream_missing(stream["product"], stream["resolution"])[:limit_per_stream]
            for num in missing:
                name = replace_segment_number(Path(urlparse(sample_url).path).name, num)
                url = replace_segment_number(sample_url, num)
                ref = MediaRef(stream["product"], stream["resolution"], name, "ts", url, num, int(stream.get("width") or 0))
                self.queue_one(ref, headers, reason="retry-missing")
                queued.append(self.stream_key(ref.product, ref.resolution) + "/" + ref.name)
        return {"queued": len(queued), "items": queued[:100]}

    def stream_numbers(self, product: str, resolution: str) -> list[int]:
        folder = self.stream_dir(product, resolution)
        nums: list[int] = []
        if not folder.exists():
            return nums
        for file in folder.glob("*.ts"):
            match = NUMERIC_TS_RE.match(file.name)
            if match and file.stat().st_size >= self.min_segment_bytes:
                nums.append(int(match.group("num")))
        nums.sort()
        return nums

    def stream_missing(self, product: str, resolution: str) -> list[int]:
        nums = self.stream_numbers(product, resolution)
        if not nums:
            return []
        present = set(nums)
        return [num for num in range(nums[0], nums[-1] + 1) if num not in present]

    def collect_stream(self, product: str, resolution: str) -> dict[str, Any]:
        folder = self.stream_dir(product, resolution)
        nums = self.stream_numbers(product, resolution)
        total_bytes = sum(file.stat().st_size for file in folder.glob("*.ts")) if folder.exists() else 0
        contiguous = 0
        for num in nums:
            if num == contiguous:
                contiguous += 1
            elif num > contiguous:
                break
        missing = self.stream_missing(product, resolution)
        first = nums[0] if nums else None
        last = nums[-1] if nums else None
        age = None
        files = list(folder.glob("*.ts")) if folder.exists() else []
        if files:
            age = round(time.time() - max(file.stat().st_mtime for file in files), 1)
        return {
            "product": product,
            "resolution": resolution,
            "files": len(nums),
            "first": first,
            "last": last,
            "contiguous_from_start": contiguous,
            "missing_count": len(missing),
            "missing_first": missing[:30],
            "mb": round(total_bytes / 1024 / 1024, 2),
            "latest_age_seconds": age,
            "media_info": self.probe_stream_info(folder),
        }

    def probe_stream_info(self, folder: Path) -> dict[str, Any] | None:
        if not folder.exists():
            return None
        cache = folder / "media_info.json"
        sample = next((p for p in sorted(folder.glob("*.ts")) if p.stat().st_size >= self.min_segment_bytes), None)
        if not sample:
            return None
        try:
            if cache.exists() and cache.stat().st_mtime >= sample.stat().st_mtime:
                return json.loads(cache.read_text(encoding="utf-8"))
        except Exception:
            pass
        ffprobe = self.ffprobe if Path(self.ffprobe).exists() else (shutil.which("ffprobe") or self.ffprobe)
        cmd = [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,avg_frame_rate,r_frame_rate",
            "-of",
            "json",
            str(sample),
        ]
        try:
            run = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            if run.returncode != 0:
                return None
            data = json.loads(run.stdout)
            stream = (data.get("streams") or [{}])[0]
            fps = stream.get("avg_frame_rate") or stream.get("r_frame_rate") or ""
            info = {
                "codec": stream.get("codec_name", ""),
                "width": stream.get("width"),
                "height": stream.get("height"),
                "fps": fps,
                "sample": sample.name,
            }
            cache.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
            return info
        except Exception:
            return None

    def list_streams(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        with self.lock:
            raw_streams = list(self.state.get("streams", {}).values())
        seen_keys = set()
        for stream in raw_streams:
            key = self.stream_key(stream["product"], stream["resolution"])
            seen_keys.add(key)
            row = self.collect_stream(stream["product"], stream["resolution"])
            subtitle_outputs = self.stream_subtitle_outputs(stream)
            latest_subtitle = subtitle_outputs[-1] if subtitle_outputs else None
            row.update({
                "width": stream.get("width", 0),
                "last_seen": stream.get("last_seen"),
                "last_segment": stream.get("last_segment"),
                "bad_small_count": len(stream.get("bad_small", {})),
                "failure_count": len(stream.get("failures", {})),
                "subtitle_count": len(stream.get("subtitles", {})) + len(subtitle_outputs),
                "subtitle_outputs": subtitle_outputs[-5:],
                "latest_subtitle": latest_subtitle,
            })
            rows.append(row)
        if self.capture_dir.exists():
            for product_dir in self.capture_dir.iterdir():
                if not product_dir.is_dir():
                    continue
                for res_dir in product_dir.iterdir():
                    if not res_dir.is_dir():
                        continue
                    key = self.stream_key(product_dir.name, res_dir.name)
                    if key not in seen_keys:
                        rows.append(self.collect_stream(product_dir.name, res_dir.name))
        rows.sort(key=lambda row: (row["product"], -int(row.get("width") or 0), row["resolution"]))
        return rows

    def subtitle_file_metrics(self, path: Path) -> dict[str, Any]:
        metrics: dict[str, Any] = {
            "bytes": path.stat().st_size,
            "mtime": path.stat().st_mtime,
            "cue_count": 0,
            "first_seconds": 0.0,
            "last_seconds": 0.0,
            "duration_seconds": 0.0,
        }
        if path.suffix.lower() == ".vtt":
            text = path.read_text(encoding="utf-8", errors="replace")
            cues = VTT_CUE_RE.findall(text)
            if cues:
                starts = [subtitle_time_seconds(start) for start, _ in cues]
                ends = [subtitle_time_seconds(end) for _, end in cues]
                metrics.update({
                    "cue_count": len(cues),
                    "first_seconds": min(starts),
                    "last_seconds": max(ends),
                    "duration_seconds": max(ends) - min(starts),
                })
        return metrics

    def stream_subtitle_outputs(self, stream: dict[str, Any]) -> list[dict[str, Any]]:
        outputs_by_path: dict[str, dict[str, Any]] = {}

        def append_if_subtitle(path_text: str) -> None:
            if not path_text:
                return
            path = Path(path_text)
            if path.suffix.lower() in SUBTITLE_FILE_SUFFIXES and path.exists():
                metrics = self.subtitle_file_metrics(path)
                outputs_by_path[str(path.resolve())] = {"path": str(path), "name": path.name, **metrics}

        for item in stream.get("subtitle_tracks", []):
            append_if_subtitle(item.get("path") or "")
            conversion = item.get("conversion") or {}
            append_if_subtitle(conversion.get("output") or "")
        for item in stream.get("subtitle_conversions", []):
            append_if_subtitle(item.get("output") or "")
        product = stream.get("product") or ""
        resolution = stream.get("resolution") or ""
        stream_dir = self.stream_dir(product, resolution)
        if stream_dir.exists():
            for path in stream_dir.rglob("*"):
                if path.is_file() and path.suffix.lower() in SUBTITLE_FILE_SUFFIXES:
                    append_if_subtitle(str(path))
        outputs = list(outputs_by_path.values())
        outputs.sort(key=lambda item: (
            float(item.get("last_seconds") or 0),
            int(item.get("cue_count") or 0),
            int(item.get("bytes") or 0),
            subtitle_path_preference(str(item.get("path") or "")),
            float(item.get("mtime") or 0),
        ))
        return outputs

    def app_status(self) -> dict[str, Any]:
        with self.lock:
            counters = dict(self.state.get("counters", {}))
            last_ping = self.state.get("last_ping")
            jobs = dict(self.state.get("jobs", {}))
            candidates = dict(self.state.get("candidates", {}))
            archive_headers = dict(self.state.get("archive_headers", {}))
            subtitle_hints = list(self.state.get("subtitle_hints", []))
            inflight = len(self.inflight)
        rows = self.list_streams()
        total_mb = round(sum(row["mb"] for row in rows), 2)
        safe_candidates = []
        for item in sorted(candidates.values(), key=lambda candidate: candidate.get("last_seen", 0), reverse=True)[:100]:
            safe_item = dict(item)
            if "sample_headers" in safe_item:
                safe_item["sample_headers"] = redacted_headers(dict(safe_item.get("sample_headers") or {}))
            if "subtitle_hint_details" in safe_item:
                safe_details = {}
                for name, detail in dict(safe_item.get("subtitle_hint_details") or {}).items():
                    safe_detail = dict(detail)
                    if safe_detail.get("requestBody"):
                        safe_detail["requestBody"] = "<captured>"
                    if safe_detail.get("headers"):
                        safe_detail["headers"] = redacted_headers(dict(safe_detail.get("headers") or {}))
                    safe_details[name] = safe_detail
                safe_item["subtitle_hint_details"] = safe_details
            safe_candidates.append(safe_item)
        return {
            "app": APP_NAME,
            "version": APP_VERSION,
            "uptime_seconds": int(time.time() - self.started),
            "subtitle": {
                "opencc_available": self.opencc_available(),
                "dictionary_path": str(self.subtitle_dictionary_path),
            },
            "counters": counters,
            "inflight": inflight,
            "last_ping": last_ping,
            "total_mb": total_mb,
            "streams": rows,
            "jobs": sorted(jobs.values(), key=lambda job: job.get("created_at", 0), reverse=True)[:50],
            "candidates": safe_candidates,
            "archive_headers": {
                key: {
                    **{name: value for name, value in item.items() if name != "headers"},
                    "redacted_headers": redacted_headers(dict(item.get("headers") or {})),
                }
                for key, item in archive_headers.items()
            },
            "subtitle_hints": [
                {
                    "url": item.get("url"),
                    "method": item.get("method"),
                    "has_body": item.get("has_body"),
                    "raw_base64_length": item.get("raw_base64_length"),
                    "has_form": item.get("has_form"),
                    "tab_id": item.get("tab_id"),
                    "updated_at": item.get("updated_at"),
                    "headers": redacted_headers(dict(item.get("headers") or {})),
                }
                for item in subtitle_hints[-20:]
            ],
        }

    def best_headers_for(self, product: str, resolution: str) -> dict[str, str]:
        with self.lock:
            exact = self.state.get("streams", {}).get(self.stream_key(product, resolution), {})
            if exact.get("sample_headers"):
                return dict(exact["sample_headers"])
            for stream in self.state.get("streams", {}).values():
                if stream.get("product") == product and stream.get("sample_headers"):
                    return dict(stream["sample_headers"])
        return {}

    def record_archive_headers(self, payload: dict[str, Any]) -> tuple[int, str]:
        site = safe_name(str(payload.get("site") or "generic").lower())
        url = str(payload.get("url") or "")
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        creator_id = (query.get("creatorId") or [""])[0]
        headers = headers_from_browser(payload.get("requestHeaders", []))
        if not headers:
            return 204, "ignored"
        record = {
            "site": site,
            "url": url,
            "host": parsed.netloc,
            "path": parsed.path,
            "creator_id": creator_id,
            "headers": headers,
            "redacted_headers": redacted_headers(headers),
            "method": payload.get("method") or "GET",
            "initiator": payload.get("initiator") or "",
            "tab_id": payload.get("tabId"),
            "timeStamp": payload.get("timeStamp"),
            "updated_at": now(),
        }
        with self.lock:
            archive_headers = self.state.setdefault("archive_headers", {})
            archive_headers[site] = record
            if creator_id:
                archive_headers[f"{site}:{safe_name(creator_id)}"] = record
            self.save_state()
        return 200, "archive headers saved"

    def best_archive_headers(self, site: str, creator_id: str = "") -> dict[str, str]:
        site_key = safe_name(site.lower())
        creator_key = f"{site_key}:{safe_name(creator_id)}" if creator_id else ""
        with self.lock:
            archive_headers = self.state.get("archive_headers", {})
            if creator_key and archive_headers.get(creator_key, {}).get("headers"):
                return dict(archive_headers[creator_key]["headers"])
            if archive_headers.get(site_key, {}).get("headers"):
                return dict(archive_headers[site_key]["headers"])
        return {}

    def start_archive_fanbox(self, payload: dict[str, Any]) -> dict[str, Any]:
        creator_id = str(payload.get("creator_id") or payload.get("creatorId") or "").strip()
        if not creator_id:
            raise RuntimeError("creator_id is required")
        start_page = max(1, int(payload.get("start_page") or 1))
        end_page_raw = payload.get("end_page")
        end_page = int(end_page_raw) if str(end_page_raw or "").strip() else None
        if end_page is not None and end_page < start_page:
            raise RuntimeError("end_page must be greater than or equal to start_page")
        limit = max(1, min(int(payload.get("limit") or 10), 100))
        workers = max(1, min(int(payload.get("workers") or 4), 32))
        request_delay_ms = max(0, min(int(payload.get("request_delay_ms") or 100), 10000))
        zip_only = bool(payload.get("zip_only", True))
        manual_headers = dict(payload.get("headers") or {})
        manual_headers.update(parse_headers_json(payload.get("headers_json")))
        saved_headers = self.best_archive_headers("fanbox", creator_id) if payload.get("use_saved_headers", True) else {}
        headers = {**saved_headers, **manual_headers}
        output_dir_text = str(payload.get("output_dir") or "").strip()
        output_dir = Path(output_dir_text).expanduser() if output_dir_text else self.archive_dir / "fanbox" / safe_name(creator_id)

        job_seed = f"archive-fanbox|{creator_id}|{start_page}|{end_page}|{time.time_ns()}"
        job_id = f"job_{int(time.time())}_{abs(hash(job_seed)) % 1000000:06d}"
        job = {
            "id": job_id,
            "type": "archive-fanbox",
            "status": "queued",
            "product": f"fanbox/{creator_id}",
            "resolution": f"pages {start_page}-{end_page or 'end'}",
            "creator_id": creator_id,
            "start_page": start_page,
            "end_page": end_page,
            "output_dir": str(output_dir),
            "workers": workers,
            "request_delay_ms": request_delay_ms,
            "zip_only": zip_only,
            "use_saved_headers": bool(saved_headers),
            "manual_headers": bool(manual_headers),
            "created_at": now(),
            "updated_at": now(),
            "total": 0,
            "done": 0,
            "saved": 0,
            "skipped_existing": 0,
            "saved_bytes": 0,
            "failed": 0,
            "message": "",
        }
        with self.lock:
            self.state.setdefault("jobs", {})[job_id] = job
            self.save_state()
        threading.Thread(
            target=self.run_archive_fanbox,
            args=(job_id, creator_id, output_dir, headers, workers, request_delay_ms, zip_only, start_page, end_page, limit),
            daemon=True,
        ).start()
        return job

    def run_archive_fanbox(
        self,
        job_id: str,
        creator_id: str,
        output_dir: Path,
        headers: dict[str, str],
        workers: int,
        request_delay_ms: int,
        zip_only: bool,
        start_page: int,
        end_page: int | None,
        limit: int,
    ) -> None:
        try:
            self.update_job(job_id, status="starting", message="Starting FANBOX archive download")
            downloader = FanboxArchiveDownloader(
                output_root=output_dir,
                headers=headers,
                workers=workers,
                request_delay_ms=request_delay_ms,
                zip_only=zip_only,
                update=lambda **updates: self.update_job(job_id, **updates),
            )
            result = downloader.download_creator(
                creator_id=creator_id,
                start_page=start_page,
                end_page=end_page,
                limit=limit,
            )
            final_status = "complete" if int(result.get("failed") or 0) == 0 else "warning"
            self.update_job(
                job_id,
                status=final_status,
                **result,
                message=f"Archive download finished: saved {result.get('saved', 0)}, existing {result.get('skipped_existing', 0)}, failed {result.get('failed', 0)}",
            )
        except Exception as exc:
            self.update_job(job_id, status="failed", message=str(exc))

    def start_direct_download(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = payload.get("url", "").strip()
        if not url:
            raise RuntimeError("url is required")
        workers = max(1, min(int(payload.get("workers") or 8), 64))
        request_delay_ms = max(0, min(int(payload.get("request_delay_ms") or 0), 10000))
        preferred_resolution = (payload.get("preferred_resolution") or "").strip()
        quality_fallback = bool(payload.get("quality_fallback", True))
        subtitle_convert_mode = normalize_subtitle_convert_mode(payload.get("subtitle_convert_mode"))
        product = safe_name(payload.get("product") or "")
        resolution = safe_name(payload.get("resolution") or "")
        headers: dict[str, str] = {}

        headers_text = (payload.get("headers_json") or "").strip()
        if headers_text:
            loaded = json.loads(headers_text)
            if not isinstance(loaded, dict):
                raise RuntimeError("headers_json must be a JSON object")
            headers = {str(key): str(value) for key, value in loaded.items()}
        if isinstance(payload.get("headers"), dict):
            headers.update({str(key): str(value) for key, value in payload["headers"].items()})

        ref = media_ref_from_url(url)
        if ref:
            product = product or ref.product
            resolution = resolution or ref.resolution
        if payload.get("use_saved_headers", True) and product and resolution:
            headers = {**self.best_headers_for(product, resolution), **headers}

        job_seed = f"{url}|{preferred_resolution}|{time.time_ns()}"
        job_id = f"job_{int(time.time())}_{abs(hash(job_seed)) % 1000000:06d}"
        job = {
            "id": job_id,
            "type": "direct-download",
            "status": "queued",
            "url": url,
            "product": product or "unknown",
            "resolution": resolution or "unknown",
            "preferred_resolution": preferred_resolution,
            "quality_fallback": quality_fallback,
            "subtitle_convert_mode": subtitle_convert_mode,
            "workers": workers,
            "request_delay_ms": request_delay_ms,
            "created_at": now(),
            "updated_at": now(),
            "total": 0,
            "done": 0,
            "saved": 0,
            "saved_bytes": 0,
            "skipped_existing": 0,
            "failed": 0,
            "bad_small": 0,
            "speed_mbps": 0,
            "eta_seconds": None,
            "message": "",
        }
        with self.lock:
            self.state.setdefault("jobs", {})[job_id] = job
            self.save_state()
        threading.Thread(
            target=self.run_direct_download,
            args=(job_id, url, headers, product, resolution, preferred_resolution, quality_fallback, workers, request_delay_ms, subtitle_convert_mode),
            daemon=True,
        ).start()
        return job

    def start_candidate_download(
        self,
        product: str,
        resolution: str,
        workers: int = 8,
        request_delay_ms: int = 0,
        preferred_resolution: str = "",
        quality_fallback: bool = True,
        subtitle_convert_mode: str = "none",
    ) -> dict[str, Any]:
        key = self.stream_key(product, resolution)
        with self.lock:
            candidate = dict(self.state.get("candidates", {}).get(key) or {})
        if not candidate:
            raise RuntimeError(f"candidate not found: {key}")
        url = candidate.get("playlist_url") or ""
        if not url and candidate.get("segment_url"):
            parsed = urlparse(candidate["segment_url"])
            base = parsed.path.rsplit("/", 1)[0]
            url = parsed._replace(path=f"{base}/first.m3u8", query="").geturl()
        if not url:
            raise RuntimeError("candidate has no playlist or segment URL")
        return self.start_direct_download(
            {
                "url": url,
                "product": product,
                "resolution": resolution,
                "preferred_resolution": preferred_resolution or resolution,
                "quality_fallback": quality_fallback,
                "subtitle_convert_mode": subtitle_convert_mode,
                "workers": workers,
                "request_delay_ms": request_delay_ms,
                "headers": candidate.get("sample_headers") or {},
                "use_saved_headers": True,
            }
        )

    def headers_from_payload(self, payload: dict[str, Any], product: str, resolution: str) -> dict[str, str]:
        headers: dict[str, str] = {}
        headers_text = (payload.get("headers_json") or "").strip()
        if headers_text:
            loaded = json.loads(headers_text)
            if not isinstance(loaded, dict):
                raise RuntimeError("headers_json must be a JSON object")
            headers = {str(key): str(value) for key, value in loaded.items()}
        if isinstance(payload.get("headers"), dict):
            headers.update({str(key): str(value) for key, value in payload["headers"].items()})
        if payload.get("use_saved_headers", True) and product and resolution:
            headers = {**self.best_headers_for(product, resolution), **headers}
        return headers

    def derive_main_playlist_url(self, url: str) -> str:
        ref = media_ref_from_url(url)
        parsed = urlparse(url)
        if ref and ref.product != "unknown":
            marker = f"/v/{ref.product}/"
            if marker in parsed.path:
                return parsed._replace(path=f"/v/{ref.product}/main.m3u8", query="").geturl()
        if ref and ref.kind == "ts":
            base = parsed.path.rsplit("/", 2)[0]
            return parsed._replace(path=f"{base}/main.m3u8", query="").geturl()
        return url

    def subtitle_tracks_for_url(self, url: str, headers: dict[str, str], product: str, resolution: str) -> list[dict[str, str]]:
        suffix = Path(urlparse(url).path).suffix.lower()
        if suffix in SUBTITLE_FILE_SUFFIXES:
            return [{"name": "manual", "language": "und", "url": url}]
        text = self.fetch_text(url, headers)
        tracks = self.parse_subtitle_tracks(url, text)
        if tracks:
            return tracks
        subtitle_lines = [
            line.strip()
            for line in text.splitlines()
            if line.strip() and not line.strip().startswith("#") and Path(urlparse(line.strip()).path).suffix.lower() in SUBTITLE_FILE_SUFFIXES
        ]
        if subtitle_lines:
            return [{"name": "playlist", "language": "und", "url": url}]
        if "WEBVTT" in text[:10000].upper() or "-->" in text:
            return [{"name": "captions", "language": "und", "url": url}]
        return []

    def request_body_bytes(self, request_body: dict[str, Any]) -> bytes | None:
        raw = request_body.get("rawBase64")
        if raw:
            return base64.b64decode(str(raw))
        form_data = request_body.get("formData")
        if isinstance(form_data, dict):
            pairs = []
            for key, values in form_data.items():
                if isinstance(values, list):
                    for value in values:
                        pairs.append(f"{key}={value}")
                else:
                    pairs.append(f"{key}={values}")
            return "&".join(pairs).encode("utf-8")
        return None

    def split_base64_chunks(self, text: str) -> list[str]:
        compact = "".join(text.split())
        if not compact:
            return []
        # grpc-web-text may concatenate independently padded base64 chunks; a
        # whole-response decode fails when "=" padding appears before the end.
        chunks = re.findall(r"[A-Za-z0-9+/]+={0,2}", compact)
        if not chunks:
            return [compact]
        if len(chunks) == 1:
            return chunks
        decoded_len = 0
        try:
            for chunk in chunks:
                decoded_len += len(base64.b64decode(chunk, validate=False))
            if decoded_len:
                return chunks
        except Exception:
            pass
        return [compact]

    def parse_grpc_frames(self, data: bytes) -> tuple[bytes, list[dict[str, Any]]]:
        pos = 0
        payloads: list[bytes] = []
        frames: list[dict[str, Any]] = []
        while pos + 5 <= len(data):
            flag = data[pos]
            length = int.from_bytes(data[pos + 1:pos + 5], "big")
            end = pos + 5 + length
            if length < 0 or end > len(data):
                break
            payload = data[pos + 5:end]
            frame_type = "trailer" if flag & 0x80 else "data"
            frames.append({"flag": flag, "length": length, "type": frame_type})
            if frame_type == "data":
                payloads.append(payload)
            pos = end
        if payloads and pos == len(data):
            return b"".join(payloads), frames
        return data, frames

    def decode_grpc_web_text(self, text: str) -> bytes:
        chunks = self.split_base64_chunks(text)
        decoded = b"".join(base64.b64decode(chunk, validate=False) for chunk in chunks if chunk)
        payload, _frames = self.parse_grpc_frames(decoded)
        return payload

    def read_protobuf_varint(self, data: bytes, pos: int) -> tuple[int, int]:
        shift = 0
        value = 0
        while pos < len(data):
            byte = data[pos]
            pos += 1
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                return value, pos
            shift += 7
            if shift > 70:
                break
        raise RuntimeError("invalid protobuf varint")

    def protobuf_string_field(self, data: bytes, field_number: int) -> str | None:
        pos = 0
        while pos < len(data):
            key, pos = self.read_protobuf_varint(data, pos)
            wire_type = key & 0x07
            number = key >> 3
            if wire_type == 0:
                _value, pos = self.read_protobuf_varint(data, pos)
            elif wire_type == 1:
                pos += 8
            elif wire_type == 2:
                length, pos = self.read_protobuf_varint(data, pos)
                value = data[pos:pos + length]
                pos += length
                if number == field_number:
                    return value.decode("utf-8", errors="replace")
            elif wire_type == 5:
                pos += 4
            else:
                raise RuntimeError(f"unsupported protobuf wire type {wire_type}")
        return None

    def user_id_from_headers(self, headers: dict[str, str]) -> str | None:
        candidates: list[str] = []
        for key, value in headers.items():
            lower = key.lower()
            if lower == "authorization" and value:
                candidates.append(value)
            if lower == "cookie" and value:
                for part in value.split(";"):
                    name, _, cookie_value = part.strip().partition("=")
                    if name.lower() in {"authorization", "token", "access_token"} and cookie_value:
                        candidates.append(cookie_value)
        for token in candidates:
            payload = jwt_payload(token)
            for field in ("uid", "Identity", "identity", "id", "user_id"):
                value = payload.get(field)
                if value is not None and str(value).strip():
                    return str(value).strip()
        return None

    def decrypt_jk_avideo_subtitle(self, ciphertext: str, user_id: str | None) -> str:
        if not user_id:
            raise RuntimeError("subtitle decrypt needs user id from authorization token")
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            from cryptography.hazmat.backends import default_backend
        except Exception as exc:
            raise RuntimeError(f"cryptography package is required for encrypted subtitles: {exc}") from exc
        key = JK_AVIDEO_SUBTITLE_KEY.encode("utf-8")
        iv_text = str(user_id).zfill(len(JK_AVIDEO_SUBTITLE_KEY))
        iv = iv_text.encode("utf-8")[:16]
        encrypted = base64.b64decode(ciphertext)
        decryptor = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend()).decryptor()
        padded = decryptor.update(encrypted) + decryptor.finalize()
        if not padded:
            raise RuntimeError("subtitle decrypt returned empty data")
        pad_len = padded[-1]
        if pad_len < 1 or pad_len > 16:
            raise RuntimeError("invalid subtitle padding after decrypt")
        return padded[:-pad_len].decode("utf-8", errors="replace")

    def decode_jk_avideo_subtitle_payload(self, data: bytes, headers: dict[str, str]) -> str | None:
        ciphertext = self.protobuf_string_field(data, 1)
        if not ciphertext:
            return None
        if not re.fullmatch(r"[A-Za-z0-9+/=\s]+", ciphertext):
            return None
        user_id = self.user_id_from_headers(headers)
        return self.decrypt_jk_avideo_subtitle(ciphertext, user_id)

    def printable_strings_from_bytes(self, data: bytes, min_len: int = 4) -> list[str]:
        text = data.decode("utf-8", errors="ignore")
        strings = re.findall(r"[\x20-\x7E\u0080-\uFFFF]{" + str(min_len) + r",}", text)
        cleaned = []
        for item in strings:
            item = item.strip()
            if item and item not in cleaned:
                cleaned.append(item)
        return cleaned[:1000]

    def save_subtitle_api_response(
        self,
        product: str,
        resolution: str,
        url: str,
        headers: dict[str, str],
        method: str,
        request_body: dict[str, Any],
        subtitle_convert_mode: str,
    ) -> list[dict[str, Any]]:
        body = self.request_body_bytes(request_body)
        response = self.session.request(method.upper() or "GET", url, headers=headers, data=body, timeout=30)
        if response.status_code != 200 or not response.content:
            raise RuntimeError(f"subtitle API HTTP {response.status_code}, {len(response.content)} bytes")
        base_dir = self.stream_dir(product, resolution) / "subtitles" / "api"
        base_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        name = safe_name(Path(urlparse(url).path).name or "subtitle_api")
        raw_path = base_dir / f"{stamp}_{name}.response.bin"
        raw_path.write_bytes(response.content)

        saved: list[dict[str, Any]] = [{"language": "und", "name": name, "path": str(raw_path), "parts": 1, "kind": "api-response"}]
        content_type = response.headers.get("content-type", "")
        text = response.text
        decoded_bytes = b""
        if "grpc-web-text" in content_type:
            try:
                decoded_bytes = self.decode_grpc_web_text(text)
                decoded_path = base_dir / f"{stamp}_{name}.grpc.bin"
                decoded_path.write_bytes(decoded_bytes)
                saved.append({"language": "und", "name": f"{name}_grpc", "path": str(decoded_path), "parts": 1, "kind": "grpc-decoded"})
            except Exception as exc:
                saved.append({"language": "und", "name": f"{name}_grpc", "error": f"grpc decode failed: {exc}"})
        else:
            decoded_bytes = response.content

        decoded_text = decoded_bytes.decode("utf-8", errors="ignore") if decoded_bytes else text
        text_path = base_dir / f"{stamp}_{name}.strings.txt"
        strings = self.printable_strings_from_bytes(decoded_bytes or response.content)
        text_path.write_text("\n".join(strings) if strings else decoded_text, encoding="utf-8")
        saved.append({"language": "und", "name": f"{name}_strings", "path": str(text_path), "parts": 1, "kind": "strings"})

        vtt_text: str | None = None
        if "WEBVTT" in decoded_text[:10000].upper() or "-->" in decoded_text:
            vtt_text = decoded_text
        elif "AvideoSubtitle" in url and decoded_bytes:
            try:
                vtt_text = self.decode_jk_avideo_subtitle_payload(decoded_bytes, headers)
                if vtt_text:
                    decrypted_path = base_dir / f"{stamp}_{name}.decrypted.txt"
                    decrypted_path.write_text(vtt_text, encoding="utf-8")
                    saved.append({"language": "und", "name": f"{name}_decrypted", "path": str(decrypted_path), "parts": 1, "kind": "decrypted-text"})
            except Exception as exc:
                saved.append({"language": "und", "name": f"{name}_decrypt", "error": f"encrypted subtitle decode failed: {exc}"})

        if vtt_text and ("WEBVTT" in vtt_text[:10000].upper() or "-->" in vtt_text):
            vtt_path = base_dir / f"{stamp}_{name}.vtt"
            vtt_path.write_text(vtt_text, encoding="utf-8")
            metrics = self.subtitle_file_metrics(vtt_path)
            item: dict[str, Any] = {"language": "und", "name": name, "path": str(vtt_path), "parts": 1, "kind": "vtt", **metrics}
            if subtitle_convert_mode != "none":
                item["conversion"] = self.convert_subtitle_file(vtt_path, subtitle_convert_mode)
            saved.append(item)
        elif "AvideoSubtitle" in url:
            saved.append({"language": "und", "name": f"{name}_vtt", "error": "encrypted subtitle response did not decode to WebVTT"})

        with self.lock:
            stream = self.state.setdefault("streams", {}).get(self.stream_key(product, resolution))
            if stream:
                stream["subtitle_tracks"] = saved
                self.save_state()
        return saved

    def best_existing_subtitle_metrics(self, product: str, resolution: str) -> dict[str, Any] | None:
        stream_dir = self.stream_dir(product, resolution)
        if not stream_dir.exists():
            return None
        best: dict[str, Any] | None = None
        for path in stream_dir.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in SUBTITLE_FILE_SUFFIXES:
                continue
            metrics = self.subtitle_file_metrics(path)
            item = {"path": str(path), "name": path.name, **metrics}
            if best is None or (
                float(item.get("last_seconds") or 0),
                int(item.get("cue_count") or 0),
                int(item.get("bytes") or 0),
                subtitle_path_preference(str(item.get("path") or "")),
                float(item.get("mtime") or 0),
            ) > (
                float(best.get("last_seconds") or 0),
                int(best.get("cue_count") or 0),
                int(best.get("bytes") or 0),
                subtitle_path_preference(str(best.get("path") or "")),
                float(best.get("mtime") or 0),
            ):
                best = item
        return best

    def subtitle_is_shorter_than_best(self, product: str, resolution: str, saved: list[dict[str, Any]]) -> tuple[bool, str]:
        current_vtts = [item for item in saved if item.get("kind") == "vtt" and item.get("path")]
        if not current_vtts:
            return False, ""
        current = max(current_vtts, key=lambda item: (
            float(item.get("last_seconds") or 0),
            int(item.get("cue_count") or 0),
            int(item.get("bytes") or 0),
        ))
        best = self.best_existing_subtitle_metrics(product, resolution)
        if not best:
            return False, ""
        current_last = float(current.get("last_seconds") or 0)
        best_last = float(best.get("last_seconds") or 0)
        current_cues = int(current.get("cue_count") or 0)
        best_cues = int(best.get("cue_count") or 0)
        if best_last > max(current_last * 1.25, current_last + 300) or best_cues > max(current_cues * 2, current_cues + 50):
            return True, (
                f"Downloaded CC looks short ({round(current_last)}s/{current_cues} cues); "
                f"kept best existing {Path(str(best.get('path'))).name} ({round(best_last)}s/{best_cues} cues). "
                "Tip: refresh the video page, turn CC on, play a few seconds, then download CC again."
            )
        return False, ""

    def start_subtitle_download(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = payload.get("url", "").strip()
        if not url:
            raise RuntimeError("url is required")
        subtitle_convert_mode = normalize_subtitle_convert_mode(payload.get("subtitle_convert_mode"))
        product = safe_name(payload.get("product") or "")
        resolution = safe_name(payload.get("resolution") or "")
        ref = media_ref_from_url(url)
        if ref:
            product = product or ref.product
            resolution = resolution or ref.resolution
        headers = self.headers_from_payload(payload, product, resolution)
        method = payload.get("method") or "GET"
        request_body = payload.get("requestBody") or {}
        job_seed = f"subtitle|{url}|{time.time_ns()}"
        job_id = f"job_{int(time.time())}_{abs(hash(job_seed)) % 1000000:06d}"
        job = {
            "id": job_id,
            "type": "subtitle-download",
            "status": "queued",
            "url": url,
            "method": method,
            "product": product or "unknown",
            "resolution": resolution or "unknown",
            "subtitle_convert_mode": subtitle_convert_mode,
            "workers": 1,
            "request_delay_ms": 0,
            "created_at": now(),
            "updated_at": now(),
            "total": 0,
            "done": 0,
            "saved": 0,
            "saved_bytes": 0,
            "failed": 0,
            "bad_small": 0,
            "speed_mbps": 0,
            "eta_seconds": None,
            "message": "",
        }
        with self.lock:
            self.state.setdefault("jobs", {})[job_id] = job
            self.save_state()
        threading.Thread(
            target=self.run_subtitle_download,
            args=(job_id, url, headers, product, resolution, subtitle_convert_mode, method, request_body),
            daemon=True,
        ).start()
        return job

    def start_candidate_subtitle_download(self, product: str, resolution: str, subtitle_convert_mode: str = "none") -> dict[str, Any]:
        key = self.stream_key(product, resolution)
        with self.lock:
            candidate = dict(self.state.get("candidates", {}).get(key) or {})
        if not candidate:
            raise RuntimeError(f"candidate not found: {key}")
        subtitle_urls = list((candidate.get("subtitle_urls") or {}).values())
        hint_headers: dict[str, str] = {}
        if subtitle_urls:
            url = subtitle_urls[0]
            method = "GET"
            request_body = {}
        elif candidate.get("subtitle_hints"):
            details = list((candidate.get("subtitle_hint_details") or {}).values())
            if not details:
                tab_id = candidate.get("tab_id")
                with self.lock:
                    global_hints = list(self.state.get("subtitle_hints", []))
                details = [
                    item for item in global_hints
                    if (tab_id is None or item.get("tab_id") == tab_id) and item.get("url") in set((candidate.get("subtitle_hints") or {}).values())
                ] or [
                    item for item in global_hints
                    if item.get("url") in set((candidate.get("subtitle_hints") or {}).values())
                ]
            if details:
                detail = details[-1]
                url = detail.get("url") or list((candidate.get("subtitle_hints") or {}).values())[-1]
                method = detail.get("method") or "GET"
                request_body = detail.get("requestBody") or {}
                hint_headers = dict(detail.get("headers") or {})
                if not hint_headers:
                    with self.lock:
                        global_hints = list(self.state.get("subtitle_hints", []))
                    for hint in reversed(global_hints):
                        if hint.get("url") == url and (hint.get("requestBody") or {}).get("rawBase64") == request_body.get("rawBase64"):
                            hint_headers = dict(hint.get("headers") or {})
                            break
            else:
                url = list((candidate.get("subtitle_hints") or {}).values())[-1]
                method = "GET"
                request_body = {}
        else:
            source_url = candidate.get("playlist_url") or candidate.get("segment_url") or ""
            if not source_url:
                raise RuntimeError("candidate has no URL to search for subtitles")
            url = self.derive_main_playlist_url(source_url)
            method = "GET"
            request_body = {}
        return self.start_subtitle_download(
            {
                "url": url,
                "method": method,
                "requestBody": request_body,
                "product": product,
                "resolution": resolution,
                "subtitle_convert_mode": subtitle_convert_mode,
                "headers": hint_headers or candidate.get("sample_headers") or {},
                "use_saved_headers": True,
            }
        )

    def run_subtitle_download(self, job_id: str, url: str, headers: dict[str, str], product: str, resolution: str, subtitle_convert_mode: str, method: str = "GET", request_body: dict[str, Any] | None = None) -> None:
        started = time.time()
        try:
            self.update_job(job_id, status="fetching-subtitles", message="Looking for subtitle tracks")
            ref = media_ref_from_url(url)
            product = safe_name(product or (ref.product if ref else "subtitles"))
            resolution = safe_name((ref.resolution if ref and ref.resolution != "unknown" else "") or resolution or "unknown")
            stream_ref = MediaRef(product, resolution, Path(urlparse(url).path).name or "subtitles", "vtt", url, None, parse_resolution(resolution)[0])
            with self.lock:
                stream = self.ensure_stream(stream_ref)
                stream["sample_headers"] = headers
                self.save_state()
            if method.upper() != "GET" or request_body:
                self.update_job(job_id, status="downloading-subtitle-api", product=product, resolution=resolution, total=1, message="Replaying subtitle API request")
                saved = self.save_subtitle_api_response(product, resolution, url, headers, method, request_body or {}, subtitle_convert_mode)
            else:
                tracks = self.subtitle_tracks_for_url(url, headers, product, resolution)
                if not tracks:
                    raise RuntimeError(f"no subtitle tracks found in {url}")
                self.update_job(job_id, status="downloading-subtitles", product=product, resolution=resolution, total=len(tracks), message=f"Downloading {len(tracks)} subtitle track(s)")
                saved = self.download_subtitle_tracks(product, resolution, tracks, headers, subtitle_convert_mode)
            saved_bytes = 0
            failed = 0
            for item in saved:
                if item.get("error"):
                    failed += 1
                    continue
                path_text = item.get("path") or ""
                path = Path(path_text) if path_text else None
                if path and path.is_file():
                    saved_bytes += path.stat().st_size
                conversion = item.get("conversion") or {}
                converted_text = conversion.get("output") or ""
                converted = Path(converted_text) if converted_text else None
                if converted and converted.is_file():
                    saved_bytes += converted.stat().st_size
            short_subtitle, short_message = self.subtitle_is_shorter_than_best(product, resolution, saved)
            status = "warning" if short_subtitle and failed == 0 else ("complete" if failed == 0 else "failed")
            saved_total = max(len(saved), 1)
            self.update_job(
                job_id,
                status=status,
                total=saved_total,
                done=len(saved),
                saved=max(0, len(saved) - failed),
                failed=failed,
                saved_bytes=saved_bytes,
                speed_mbps=round(saved_bytes / 1024 / 1024 / max(time.time() - started, 0.001), 2),
                subtitle_tracks=saved,
                subtitle_convert_mode=subtitle_convert_mode,
                message=short_message or ("Subtitle download complete" if failed == 0 else f"Subtitle download finished with {failed} error(s)"),
            )
        except Exception as exc:
            self.update_job(job_id, status="failed", message=str(exc))

    def fetch_text(self, url: str, headers: dict[str, str]) -> str:
        response = self.session.get(url, headers=headers, timeout=30)
        if response.status_code != 200 or not response.content:
            raise RuntimeError(f"playlist HTTP {response.status_code}, {len(response.content)} bytes")
        return response.text

    def playlist_variants(self, url: str, text: str) -> list[dict[str, Any]]:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        variants: list[dict[str, Any]] = []
        pending: dict[str, Any] | None = None
        for line in lines:
            if line.startswith("#EXT-X-STREAM-INF"):
                res_match = re.search(r"RESOLUTION=(\d+x\d+)", line)
                bandwidth_match = re.search(r"BANDWIDTH=(\d+)", line)
                pending = {
                    "resolution": res_match.group(1) if res_match else "",
                    "bandwidth": int(bandwidth_match.group(1)) if bandwidth_match else 0,
                }
                continue
            if pending and not line.startswith("#"):
                pending["url"] = urljoin(url, line)
                variants.append(pending)
                pending = None
        return variants

    def choose_media_playlist(self, url: str, text: str, headers: dict[str, str], preferred_resolution: str, quality_fallback: bool) -> tuple[str, str, str, list[dict[str, Any]]]:
        variants = self.playlist_variants(url, text)
        if not variants:
            return url, text, preferred_resolution, []
        variants = sorted(variants, key=lambda item: (parse_resolution(item.get("resolution") or "")[0], item.get("bandwidth", 0)), reverse=True)
        if preferred_resolution:
            for variant in variants:
                if variant.get("resolution") == preferred_resolution:
                    chosen = variant
                    break
            else:
                if not quality_fallback:
                    available = ", ".join(filter(None, (variant.get("resolution", "") for variant in variants))) or "unknown"
                    raise RuntimeError(f"requested quality {preferred_resolution} is not available; available: {available}")
                chosen = max(variants, key=lambda item: (parse_resolution(item.get("resolution") or "")[0], item.get("bandwidth", 0)))
        else:
            chosen = max(variants, key=lambda item: (parse_resolution(item.get("resolution") or "")[0], item.get("bandwidth", 0)))
        media_url = chosen["url"]
        return media_url, self.fetch_text(media_url, headers), chosen.get("resolution", preferred_resolution), variants

    def candidate_variant_order(self, variants: list[dict[str, Any]], chosen_resolution: str, quality_fallback: bool) -> list[dict[str, Any]]:
        if not variants:
            return []
        ordered = sorted(variants, key=lambda item: (parse_resolution(item.get("resolution") or "")[0], item.get("bandwidth", 0)), reverse=True)
        chosen = [item for item in ordered if item.get("resolution") == chosen_resolution]
        if not chosen:
            return ordered if quality_fallback else []
        if not quality_fallback:
            return chosen
        lower = [item for item in ordered if item not in chosen and parse_resolution(item.get("resolution") or "")[0] <= parse_resolution(chosen_resolution or "")[0]]
        higher = [item for item in ordered if item not in chosen and item not in lower]
        return chosen + lower + higher

    def playlist_probe_ok(self, segment_urls: list[str], headers: dict[str, str], sample_count: int = 5) -> tuple[bool, str]:
        if not segment_urls:
            return False, "no segments"
        failures = 0
        checked = 0
        for url in segment_urls[:sample_count]:
            try:
                response = self.session.get(url, headers=headers, timeout=20)
                checked += 1
                if response.status_code != 200 or len(response.content) < self.min_segment_bytes:
                    failures += 1
            except Exception:
                failures += 1
                checked += 1
        if checked == 0:
            return False, "no segments checked"
        if failures >= max(1, checked // 2):
            return False, f"probe failed {failures}/{checked}"
        return True, f"probe ok {checked - failures}/{checked}"

    def parse_subtitle_tracks(self, playlist_url: str, text: str) -> list[dict[str, str]]:
        tracks: list[dict[str, str]] = []
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped.startswith("#EXT-X-MEDIA") or "TYPE=SUBTITLES" not in stripped:
                continue
            attrs: dict[str, str] = {}
            for match in re.finditer(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)', stripped):
                value = match.group(2)
                if value.startswith('"') and value.endswith('"'):
                    value = value[1:-1]
                attrs[match.group(1)] = value
            uri = attrs.get("URI")
            if uri:
                tracks.append({
                    "name": safe_name(attrs.get("NAME") or attrs.get("LANGUAGE") or f"subtitle_{len(tracks)+1}"),
                    "language": safe_name(attrs.get("LANGUAGE") or "und"),
                    "url": urljoin(playlist_url, uri),
                })
        return tracks

    def parse_media_playlist(self, playlist_url: str, text: str) -> tuple[list[str], str | None, str | None, list[str]]:
        lines = text.splitlines()
        segments: list[str] = []
        extinfs: list[str] = []
        key_url: str | None = None
        key_iv: str | None = None
        pending_extinf = "#EXTINF:2.002,"
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("#EXT-X-KEY"):
                uri_match = re.search(r'URI="([^"]+)"', stripped)
                iv_match = re.search(r"IV=(0x[0-9a-fA-F]+)", stripped)
                if uri_match:
                    key_url = urljoin(playlist_url, uri_match.group(1))
                if iv_match:
                    key_iv = iv_match.group(1)
            elif stripped.startswith("#EXTINF"):
                pending_extinf = stripped
            elif stripped and not stripped.startswith("#") and ".ts" in stripped.lower():
                segments.append(urljoin(playlist_url, stripped))
                extinfs.append(pending_extinf)
                pending_extinf = "#EXTINF:2.002,"
        return segments, key_url, key_iv, extinfs

    def convert_subtitle_file(self, path: Path, mode: str) -> dict[str, Any]:
        mode = normalize_subtitle_convert_mode(mode)
        if mode == "none":
            return {"source": str(path), "mode": mode, "skipped": True}
        if not path.exists():
            raise RuntimeError(f"subtitle not found: {path}")
        if path.suffix.lower() not in SUBTITLE_FILE_SUFFIXES:
            raise RuntimeError(f"unsupported subtitle file: {path.name}")
        if is_generated_subtitle(path):
            return {"source": str(path), "mode": mode, "skipped": True, "reason": "already converted"}
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("utf-8", errors="replace")
        out = converted_subtitle_path(path, mode)
        converted = convert_subtitle_text(text, mode, self.subtitle_dictionary_for(mode))
        out.write_text(converted, encoding="utf-8")
        return {"source": str(path), "output": str(out), "mode": mode, "bytes": out.stat().st_size}

    def convert_subtitles(self, product: str, resolution: str | None, mode: str) -> dict[str, Any]:
        mode = normalize_subtitle_convert_mode(mode)
        actual_resolution = self.choose_primary_resolution(product, resolution)
        if not actual_resolution:
            raise RuntimeError(f"no streams found for {product}")
        subtitle_dir = self.stream_dir(product, actual_resolution) / "subtitles"
        if not subtitle_dir.exists():
            return {"product": product, "resolution": actual_resolution, "mode": mode, "converted": [], "count": 0}
        converted = []
        for path in subtitle_dir.rglob("*"):
            if path.is_file() and path.suffix.lower() in SUBTITLE_FILE_SUFFIXES and not is_generated_subtitle(path):
                converted.append(self.convert_subtitle_file(path, mode))
        with self.lock:
            stream = self.state.setdefault("streams", {}).get(self.stream_key(product, actual_resolution))
            if stream:
                stream["subtitle_conversions"] = converted
                self.save_state()
        return {"product": product, "resolution": actual_resolution, "mode": mode, "converted": converted, "count": len(converted)}

    def open_location(self, product: str | None = None, resolution: str | None = None, kind: str = "stream", path: str | None = None) -> dict[str, Any]:
        allowed_roots = [self.data_dir.resolve(), self.output_dir.resolve()]
        target: Path
        select_file = False
        if path:
            target = Path(path).expanduser().resolve()
            if target.is_file():
                select_file = True
            elif not target.exists():
                target = target.parent
        else:
            safe_product = safe_name(product or "")
            actual_resolution = self.choose_primary_resolution(safe_product, resolution) or safe_name(resolution or "")
            target = self.stream_dir(safe_product, actual_resolution)
            if kind == "subtitles":
                with self.lock:
                    stream = dict(self.state.get("streams", {}).get(self.stream_key(safe_product, actual_resolution)) or {})
                outputs = self.stream_subtitle_outputs(stream)
                if outputs:
                    target = Path(outputs[-1]["path"]).parent
                else:
                    subtitle_dir = target / "subtitles"
                    if subtitle_dir.exists():
                        target = subtitle_dir
            elif kind == "outputs":
                target = self.output_dir
        resolved = target.resolve()
        if not any(resolved == root or root in resolved.parents for root in allowed_roots):
            raise RuntimeError(f"refusing to open path outside HLS Keeper data/output: {resolved}")
        if not resolved.exists():
            raise RuntimeError(f"path does not exist: {resolved}")
        if os.name == "nt":
            if select_file:
                subprocess.Popen(["explorer.exe", "/select,", str(resolved)])
            else:
                os.startfile(str(resolved))  # type: ignore[attr-defined]
        else:
            opener = shutil.which("open") or shutil.which("xdg-open")
            if not opener:
                raise RuntimeError("no system folder opener found")
            subprocess.Popen([opener, str(resolved if resolved.is_dir() else resolved.parent)])
        return {"opened": str(resolved), "selected": select_file}

    def latest_output_video(self, product: str, resolution: str | None) -> Path | None:
        if not self.output_dir.exists():
            return None
        suffixes = {".mp4", ".mkv", ".mov", ".m4v", ".webm"}
        product_l = product.lower()
        resolution_l = (resolution or "").lower()
        candidates = [
            path for path in self.output_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in suffixes and product_l in path.name.lower()
        ]
        if resolution_l:
            exact = [path for path in candidates if resolution_l in path.name.lower()]
            if exact:
                candidates = exact
        if not candidates:
            return None
        return max(candidates, key=lambda path: path.stat().st_mtime)

    def export_player_subtitle(self, product: str, resolution: str | None = None, mode: str = "none") -> dict[str, Any]:
        actual_resolution = self.choose_primary_resolution(product, resolution) or safe_name(resolution or "")
        key = self.stream_key(product, actual_resolution)
        with self.lock:
            stream = dict(self.state.get("streams", {}).get(key) or {})
        outputs = self.stream_subtitle_outputs(stream)
        if not outputs:
            raise RuntimeError(f"no subtitle file found for {key}")
        source = Path(outputs[-1]["path"])
        if mode and mode != "none" and not source.stem.endswith(SUBTITLE_CONVERT_SUFFIXES.get(mode, "")):
            conversion = self.convert_subtitle_file(source, mode)
            source = Path(conversion.get("output") or source)
        video = self.latest_output_video(product, actual_resolution)
        if video:
            target = video.with_suffix(source.suffix)
            auto_load = True
        else:
            target = self.stream_dir(product, actual_resolution) / f"{product}_{actual_resolution}{source.suffix}"
            auto_load = False
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        result = {
            "source": str(source),
            "output": str(target),
            "auto_load_ready": auto_load,
            "message": "subtitle copied next to matching video" if auto_load else "no merged output video found; copied to stream folder with a player-friendly name",
        }
        with self.lock:
            stream = self.state.setdefault("streams", {}).get(key)
            if stream:
                stream["player_subtitle"] = result
                self.save_state()
        return result

    def download_subtitle_tracks(self, product: str, resolution: str, tracks: list[dict[str, str]], headers: dict[str, str], subtitle_convert_mode: str = "none") -> list[dict[str, Any]]:
        saved: list[dict[str, Any]] = []
        subtitle_convert_mode = normalize_subtitle_convert_mode(subtitle_convert_mode)
        base_dir = self.stream_dir(product, resolution) / "subtitles"
        base_dir.mkdir(parents=True, exist_ok=True)
        for track in tracks:
            try:
                url = track["url"]
                lang = safe_name(track.get("language") or "und")
                name = safe_name(track.get("name") or lang)
                track_dir = base_dir / f"{lang}_{name}"
                track_dir.mkdir(parents=True, exist_ok=True)
                response = self.session.get(url, headers=headers, timeout=30)
                if response.status_code != 200 or not response.content:
                    raise RuntimeError(f"subtitle HTTP {response.status_code}, {len(response.content)} bytes")
                suffix = Path(urlparse(url).path).suffix.lower()
                if suffix == ".m3u8":
                    playlist_path = track_dir / "subtitle.m3u8"
                    playlist_path.write_bytes(response.content)
                    text = response.text
                    segment_urls = [
                        urljoin(url, line.strip())
                        for line in text.splitlines()
                        if line.strip() and not line.strip().startswith("#")
                    ]
                    combined_lines: list[str] = ["WEBVTT", ""]
                    part_count = 0
                    for idx, seg_url in enumerate(segment_urls):
                        seg_resp = self.session.get(seg_url, headers=headers, timeout=30)
                        if seg_resp.status_code != 200 or not seg_resp.content:
                            continue
                        seg_name = Path(urlparse(seg_url).path).name or f"subtitle_{idx:06d}.vtt"
                        (track_dir / seg_name).write_bytes(seg_resp.content)
                        seg_text = seg_resp.content.decode("utf-8", errors="replace")
                        for line in seg_text.splitlines():
                            if line.strip().upper() == "WEBVTT":
                                continue
                            combined_lines.append(line)
                        combined_lines.append("")
                        part_count += 1
                    combined = track_dir / f"{lang}_{name}.vtt"
                    combined.write_text("\n".join(combined_lines), encoding="utf-8")
                    item = {"language": lang, "name": name, "path": str(combined), "parts": part_count}
                    if subtitle_convert_mode != "none":
                        item["conversion"] = self.convert_subtitle_file(combined, subtitle_convert_mode)
                    saved.append(item)
                else:
                    response_text = response.content.decode("utf-8", errors="replace")
                    if suffix in SUBTITLE_FILE_SUFFIXES:
                        ext = suffix
                    elif "WEBVTT" in response_text[:10000].upper() or "-->" in response_text:
                        ext = ".vtt"
                    else:
                        ext = ".txt"
                    out = track_dir / f"{lang}_{name}{ext}"
                    out.write_bytes(response.content)
                    item = {"language": lang, "name": name, "path": str(out), "parts": 1}
                    if subtitle_convert_mode != "none" and out.suffix.lower() in SUBTITLE_FILE_SUFFIXES:
                        item["conversion"] = self.convert_subtitle_file(out, subtitle_convert_mode)
                    saved.append(item)
            except Exception as exc:
                saved.append({"language": track.get("language", "und"), "name": track.get("name", ""), "error": str(exc)})
        with self.lock:
            stream = self.state.setdefault("streams", {}).get(self.stream_key(product, resolution))
            if stream:
                stream["subtitle_tracks"] = saved
                self.save_state()
        return saved

    def run_direct_download(
        self,
        job_id: str,
        url: str,
        headers: dict[str, str],
        product: str,
        resolution: str,
        preferred_resolution: str,
        quality_fallback: bool,
        workers: int,
        request_delay_ms: int,
        subtitle_convert_mode: str,
    ) -> None:
        try:
            subtitle_convert_mode = normalize_subtitle_convert_mode(subtitle_convert_mode)
            self.update_job(job_id, status="fetching-playlist", message="Fetching playlist")
            playlist_text = self.fetch_text(url, headers)
            subtitle_tracks = self.parse_subtitle_tracks(url, playlist_text)
            media_url, playlist_text, chosen_resolution, variants = self.choose_media_playlist(url, playlist_text, headers, preferred_resolution, quality_fallback)
            segments, key_url, key_iv, extinfs = self.parse_media_playlist(media_url, playlist_text)
            if not segments:
                raise RuntimeError("no .ts segments found in playlist")
            probe_ok, probe_message = self.playlist_probe_ok(segments, headers)
            fallback_from = ""
            if not probe_ok and quality_fallback and variants:
                fallback_from = chosen_resolution
                for variant in self.candidate_variant_order(variants, chosen_resolution, quality_fallback)[1:]:
                    alt_url = variant["url"]
                    alt_text = self.fetch_text(alt_url, headers)
                    alt_segments, alt_key_url, alt_key_iv, alt_extinfs = self.parse_media_playlist(alt_url, alt_text)
                    alt_ok, alt_message = self.playlist_probe_ok(alt_segments, headers)
                    if alt_ok:
                        media_url, playlist_text, chosen_resolution = alt_url, alt_text, variant.get("resolution", "")
                        segments, key_url, key_iv, extinfs = alt_segments, alt_key_url, alt_key_iv, alt_extinfs
                        probe_message = f"fallback from {fallback_from}: {alt_message}"
                        break
                else:
                    raise RuntimeError(f"selected quality failed and no fallback worked: {probe_message}")
            elif not probe_ok:
                raise RuntimeError(f"selected quality failed probe: {probe_message}")

            ref = media_ref_from_url(media_url) or media_ref_from_url(url)
            product = safe_name(product or (ref.product if ref else "direct"))
            resolution = safe_name((ref.resolution if ref and ref.resolution != "unknown" else "") or chosen_resolution or resolution or preferred_resolution or "unknown")
            self.update_job(
                job_id,
                product=product,
                resolution=resolution,
                chosen_resolution=chosen_resolution,
                requested_resolution=preferred_resolution,
                fallback_from=fallback_from,
                available_resolutions=[v.get("resolution") for v in variants if v.get("resolution")],
                message=probe_message,
            )

            stream_ref = MediaRef(product, resolution, Path(urlparse(media_url).path).name or "first.m3u8", "m3u8", media_url, None, parse_resolution(resolution)[0])
            with self.lock:
                stream = self.ensure_stream(stream_ref)
                stream["sample_url"] = segments[0]
                stream["sample_headers"] = headers
                stream["playlist"] = "first.m3u8"
                self.save_state()

            folder = self.stream_dir(product, resolution)
            folder.mkdir(parents=True, exist_ok=True)
            if key_url:
                key_response = self.session.get(key_url, headers=headers, timeout=30)
                if key_response.status_code == 200 and key_response.content:
                    (folder / "file.key").write_bytes(key_response.content)
            saved_subtitles = self.download_subtitle_tracks(product, resolution, subtitle_tracks, headers, subtitle_convert_mode) if subtitle_tracks else []

            local_lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:3", "#EXT-X-MEDIA-SEQUENCE:0"]
            if key_url:
                local_lines.append(f'#EXT-X-KEY:METHOD=AES-128,URI="file.key",IV={key_iv or "0x00000000000000000000000000000000"}')
            for idx, segment_url in enumerate(segments):
                local_lines.append(extinfs[idx] if idx < len(extinfs) else "#EXTINF:2.002,")
                local_lines.append(Path(urlparse(segment_url).path).name or f"v_{idx:06d}.ts")
            local_lines.append("#EXT-X-ENDLIST")
            (folder / "first.m3u8").write_text("\n".join(local_lines) + "\n", encoding="ascii")

            self.update_job(job_id, status="downloading", product=product, resolution=resolution, total=len(segments), subtitle_tracks=saved_subtitles, subtitle_convert_mode=subtitle_convert_mode, message="Downloading segments")
            download_started = time.time()
            counters = {"done": 0, "saved": 0, "saved_bytes": 0, "failed": 0, "bad_small": 0, "skipped_existing": 0}
            counters_lock = threading.Lock()

            def progress_snapshot() -> dict[str, Any]:
                elapsed = max(time.time() - download_started, 0.001)
                speed_mbps = counters["saved_bytes"] / 1024 / 1024 / elapsed
                remaining = max(len(segments) - counters["done"], 0)
                eta_seconds = None
                if counters["done"] > 0:
                    eta_seconds = round(remaining / (counters["done"] / elapsed), 1)
                return {
                    **counters,
                    "speed_mbps": round(speed_mbps, 2),
                    "eta_seconds": eta_seconds,
                    "percent": round(counters["done"] / len(segments) * 100, 2) if segments else 0,
                }

            def download_segment(index_url: tuple[int, str]) -> None:
                index, segment_url = index_url
                if request_delay_ms:
                    time.sleep(request_delay_ms / 1000)
                name = Path(urlparse(segment_url).path).name or f"v_{index:06d}.ts"
                dest = folder / name
                with counters_lock:
                    if dest.exists() and dest.stat().st_size >= self.min_segment_bytes:
                        counters["skipped_existing"] += 1
                        counters["saved_bytes"] += dest.stat().st_size
                        counters["done"] += 1
                        return
                try:
                    response = self.session.get(segment_url, headers=headers, timeout=30)
                    body = response.content
                    if response.status_code != 200:
                        raise RuntimeError(f"HTTP {response.status_code}, {len(body)} bytes")
                    if len(body) < self.min_segment_bytes:
                        with counters_lock:
                            counters["bad_small"] += 1
                        raise RuntimeError(f"too small to be a TS segment: {len(body)} bytes")
                    tmp = dest.with_suffix(".ts.part")
                    tmp.write_bytes(body)
                    tmp.replace(dest)
                    with counters_lock:
                        counters["saved"] += 1
                        counters["saved_bytes"] += len(body)
                    with self.lock:
                        self.state["counters"]["saved"] += 1
                        stream = self.state.setdefault("streams", {}).get(self.stream_key(product, resolution))
                        if stream:
                            stream["segments_saved"] = int(stream.get("segments_saved") or 0) + 1
                        self.save_state()
                except Exception as exc:
                    with counters_lock:
                        counters["failed"] += 1
                    with self.lock:
                        self.state["counters"]["failed"] += 1
                        if "too small" in str(exc):
                            self.state["counters"]["bad_small"] += 1
                        self.save_state()
                    self.log_event({"type": "direct-failed", "job_id": job_id, "segment": name, "error": str(exc)})
                finally:
                    with counters_lock:
                        counters["done"] += 1
                        if counters["done"] % 25 == 0 or counters["done"] == len(segments):
                            self.update_job(job_id, **progress_snapshot())

            with ThreadPoolExecutor(max_workers=workers) as executor:
                list(executor.map(download_segment, enumerate(segments)))
            self.update_job(job_id, status="complete", **progress_snapshot(), message="Direct download complete")
        except Exception as exc:
            self.update_job(job_id, status="failed", message=str(exc))

    def choose_primary_resolution(self, product: str, requested: str | None) -> str | None:
        rows = [row for row in self.list_streams() if row["product"] == product]
        if requested:
            return requested
        if not rows:
            return None
        rows.sort(key=lambda row: int(row.get("width") or 0), reverse=True)
        return rows[0]["resolution"]

    def make_merge_playlist(self, product: str, resolution: str, strategy: str) -> dict[str, Any]:
        primary_dir = self.stream_dir(product, resolution)
        primary_playlist = primary_dir / "first.m3u8"
        if not primary_playlist.exists():
            raise RuntimeError(f"missing playlist: {primary_playlist}")

        playlist_lines = primary_playlist.read_text(encoding="utf-8", errors="replace").splitlines()
        extinfs = [line.strip() for line in playlist_lines if line.strip().startswith("#EXTINF")]
        segment_names = [Path(line.strip()).name for line in playlist_lines if line.strip().endswith(".ts")]
        if not extinfs:
            nums = self.stream_numbers(product, resolution)
            total = (nums[-1] + 1) if nums else 0
            extinfs = ["#EXTINF:2.002," for _ in range(total)]

        available_resolutions = [row["resolution"] for row in self.list_streams() if row["product"] == product]
        available_resolutions.sort(key=lambda value: parse_resolution(value)[0], reverse=True)
        if resolution in available_resolutions:
            available_resolutions.remove(resolution)
        fallback_resolutions = available_resolutions

        def key_line_for(res: str) -> str:
            playlist = self.stream_dir(product, res) / "first.m3u8"
            key_line = ""
            if playlist.exists():
                key_line = next((line.strip() for line in playlist.read_text(encoding="utf-8", errors="replace").splitlines() if line.startswith("#EXT-X-KEY")), "")
            iv_match = re.search(r"IV=(0x[0-9a-fA-F]+)", key_line)
            iv = iv_match.group(1) if iv_match else "0x00000000000000000000000000000000"
            key_path = (self.stream_dir(product, res) / "file.key").resolve().as_posix()
            return f'#EXT-X-KEY:METHOD=AES-128,URI="{key_path}",IV={iv}'

        selected: list[tuple[int, str, Path]] = []
        replacements: list[dict[str, Any]] = []
        skipped: list[int] = []
        total = len(extinfs)
        for num in range(total):
            template_name = segment_names[0] if segment_names else "v_000000.ts"
            name = replace_segment_number(template_name, num)
            primary_file = primary_dir / name
            chosen_res = resolution
            chosen_file = primary_file
            if not (chosen_file.exists() and chosen_file.stat().st_size >= self.min_segment_bytes):
                chosen_file = Path()
                if strategy in {"fill", "fill-skip"}:
                    for fallback in fallback_resolutions:
                        candidate = self.stream_dir(product, fallback) / name
                        if candidate.exists() and candidate.stat().st_size >= self.min_segment_bytes:
                            chosen_res = fallback
                            chosen_file = candidate
                            replacements.append({"num": num, "resolution": fallback, "bytes": candidate.stat().st_size})
                            break
                if not chosen_file:
                    if strategy in {"skip", "fill-skip"}:
                        skipped.append(num)
                        continue
                    raise RuntimeError(f"missing segment {name}")
            selected.append((num, chosen_res, chosen_file))

        merge_dir = self.data_dir / "merge_playlists"
        merge_dir.mkdir(parents=True, exist_ok=True)
        playlist_path = merge_dir / f"{product}_{resolution}_{strategy}_{int(time.time())}.m3u8"
        lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:3", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"]
        last_res = None
        for num, res, file in selected:
            if res != last_res:
                if last_res is not None:
                    lines.append("#EXT-X-DISCONTINUITY")
                lines.append(key_line_for(res))
                last_res = res
            lines.append(extinfs[num] if num < len(extinfs) else "#EXTINF:2.002,")
            lines.append(file.resolve().as_posix())
        lines.append("#EXT-X-ENDLIST")
        playlist_path.write_text("\n".join(lines) + "\n", encoding="ascii")
        return {
            "playlist": playlist_path,
            "selected": len(selected),
            "replacements": replacements,
            "skipped": skipped,
            "total": total,
        }

    def merge(self, product: str, resolution: str | None, strategy: str) -> dict[str, Any]:
        actual_resolution = self.choose_primary_resolution(product, resolution)
        if not actual_resolution:
            raise RuntimeError(f"no streams found for {product}")
        if strategy not in {"strict", "skip", "fill-skip"}:
            raise RuntimeError("strategy must be strict, skip, or fill-skip")
        merge_info = self.make_merge_playlist(product, actual_resolution, strategy)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        output = self.output_dir / f"{product}_{actual_resolution.replace('x', 'p')}_{strategy}_{stamp}.mp4"
        cmd = [
            self.ffmpeg,
            "-hide_banner",
            "-y",
            "-protocol_whitelist",
            "file,http,https,tcp,tls,crypto",
            "-allowed_extensions",
            "ALL",
            "-i",
            str(merge_info["playlist"]),
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            "-movflags",
            "+faststart",
            str(output),
        ]
        if not Path(self.ffmpeg).exists():
            found = shutil.which("ffmpeg")
            if found:
                cmd[0] = found
            else:
                raise RuntimeError(f"ffmpeg not found: {self.ffmpeg}")
        started = time.time()
        run = subprocess.run(cmd, capture_output=True, text=True)
        result = {
            "product": product,
            "resolution": actual_resolution,
            "strategy": strategy,
            "output": str(output),
            "playlist": str(merge_info["playlist"]),
            "duration_seconds": round(time.time() - started, 2),
            "returncode": run.returncode,
            "stdout": run.stdout[-4000:],
            "stderr": run.stderr[-4000:],
            "selected": merge_info["selected"],
            "replacements": merge_info["replacements"],
            "skipped": merge_info["skipped"],
        }
        self.log_event({"type": "merge", **{key: result[key] for key in ("product", "resolution", "strategy", "output", "returncode")}})
        if run.returncode != 0:
            raise RuntimeError(json.dumps(result, ensure_ascii=False))
        return result


def replace_segment_number(value: str, num: int) -> str:
    def repl(match: re.Match[str]) -> str:
        width = len(match.group("num"))
        trailer = match.groupdict().get("trailer") or ""
        return f"{match.group('prefix')}{num:0{width}d}{match.group('suffix')}{trailer}"

    return NUMERIC_TS_ANY_RE.sub(repl, value)


DASHBOARD_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HLS Keeper</title>
  <style>
    :root { color-scheme: light dark; font-family: "Segoe UI", system-ui, sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #171a1f; }
    header { padding: 18px 24px; background: #1f2937; color: white; display: flex; justify-content: space-between; align-items: center; }
    h1 { font-size: 20px; margin: 0; letter-spacing: 0; }
    main { padding: 20px 24px 36px; }
    .stats { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .stat { background: white; border: 1px solid #d8dde6; border-radius: 6px; padding: 12px; }
    .label { font-size: 12px; color: #657083; }
    .value { font-size: 22px; font-weight: 650; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d8dde6; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #e7ebf0; text-align: left; font-size: 13px; vertical-align: top; }
    th { background: #eef2f7; font-weight: 650; }
    button, select, input { font: inherit; }
    button { border: 1px solid #aeb8c7; background: #fff; border-radius: 5px; padding: 6px 9px; cursor: pointer; }
    button:hover { background: #f2f5f9; }
    progress { width: 180px; height: 12px; vertical-align: middle; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .ok { color: #107c41; font-weight: 650; }
    .warn { color: #9a6700; font-weight: 650; }
    .bad { color: #b42318; font-weight: 650; }
    .mono { font-family: Consolas, monospace; font-size: 12px; }
    .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
    .notice { display: none; border: 1px solid #f1c36d; background: #fff7e6; color: #6f4e00; border-radius: 6px; padding: 10px 12px; margin-bottom: 12px; }
    .notice.show { display: block; }
    #log { white-space: pre-wrap; background: #111827; color: #e5e7eb; border-radius: 6px; padding: 12px; margin-top: 14px; min-height: 72px; max-height: 280px; overflow: auto; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #e5e7eb; }
      .stat, table { background: #182233; border-color: #364252; }
      th { background: #223047; }
      td, th { border-bottom-color: #334155; }
      button { background: #1f2937; color: #e5e7eb; border-color: #4b5563; }
      button:hover { background: #293548; }
      .label { color: #aab4c4; }
      .notice { background: #3a2a12; color: #f8dda0; border-color: #8a651e; }
    }
  </style>
</head>
<body>
  <header>
    <h1>HLS Keeper</h1>
    <div id="heartbeat" class="mono">checking...</div>
  </header>
  <main>
    <div class="stats">
      <div class="stat"><div class="label">Streams</div><div id="streams" class="value">0</div></div>
      <div class="stat"><div class="label">Saved</div><div id="saved" class="value">0</div></div>
      <div class="stat"><div class="label">Failed</div><div id="failed" class="value">0</div></div>
      <div class="stat"><div class="label">Bad Small</div><div id="badSmall" class="value">0</div></div>
      <div class="stat"><div class="label">Size</div><div id="size" class="value">0 MB</div></div>
    </div>
    <div class="toolbar">
      <button id="refresh">Refresh</button>
      <button id="retryAll">Retry Missing</button>
      <span class="label">Strategy: strict = no missing; skip = continuous playback with gaps skipped; fill-skip = fill from lower quality, then skip leftovers.</span>
    </div>
    <div id="subtitleNotice" class="notice"></div>
    <section class="stat" style="margin-bottom:16px">
      <div class="label">Discovered videos</div>
      <table style="margin-top:8px">
        <thead><tr><th>Candidate</th><th>Seen</th><th>URLs</th><th>Quality</th><th>Actions</th></tr></thead>
        <tbody id="candidates"></tbody>
      </table>
    </section>
    <section class="stat" style="margin-bottom:16px">
      <div class="label">Advanced fallback: direct m3u8 / subtitle URL</div>
      <div style="display:grid; grid-template-columns: 2fr 120px 120px 90px 100px; gap:8px; margin-top:8px">
        <input id="directUrl" placeholder="m3u8 URL or subtitle URL">
        <input id="directProduct" placeholder="video id">
        <input id="directResolution" placeholder="preferred quality, e.g. 1920x1080 or 1920x1080,1280x720">
        <input id="directWorkers" type="number" min="1" max="64" value="8" title="Parallel workers">
        <input id="directDelay" type="number" min="0" max="10000" value="0" title="Delay ms/request">
      </div>
      <textarea id="directHeaders" placeholder='optional headers JSON, e.g. {"referer":"https://..."}' style="box-sizing:border-box;width:100%;height:62px;margin-top:8px;font:12px Consolas,monospace"></textarea>
      <div class="toolbar" style="margin:8px 0 0">
        <label><input id="useSavedHeaders" type="checkbox" checked> use saved browser headers when possible</label>
        <label><input id="qualityFallback" type="checkbox" checked> auto fallback if selected quality is missing</label>
        <label>CC convert
          <select id="subtitleConvert">
            <option value="none">keep original</option>
            <option value="zh-hans">Traditional Chinese -> Simplified</option>
            <option value="zh-hant">Simplified Chinese -> Traditional</option>
            <option value="en-us">British English -> American</option>
            <option value="en-gb">American English -> British</option>
          </select>
        </label>
        <button id="startDirect">Start direct download</button>
        <button id="startSubtitleOnly">Download CC only</button>
      </div>
    </section>
    <section class="stat" style="margin-bottom:16px">
      <div class="label">Archive: FANBOX ZIP attachments</div>
      <div style="display:grid; grid-template-columns: 160px 90px 90px 90px 90px 110px; gap:8px; margin-top:8px">
        <input id="archiveCreator" placeholder="creatorId, e.g. dollhouse">
        <input id="archiveStartPage" type="number" min="1" value="1" title="Start page">
        <input id="archiveEndPage" type="number" min="1" placeholder="end" title="End page, blank = all">
        <input id="archiveWorkers" type="number" min="1" max="32" value="4" title="Parallel workers">
        <input id="archiveDelay" type="number" min="0" max="10000" value="100" title="Delay ms/request">
        <label><input id="archiveZipOnly" type="checkbox" checked> ZIP only</label>
      </div>
      <input id="archiveOutput" placeholder="optional output folder, blank = archives/fanbox/<creatorId>" style="box-sizing:border-box;width:100%;margin-top:8px">
      <textarea id="archiveHeaders" placeholder='optional headers JSON override/fallback, e.g. {"cookie":"FANBOXSESSID=..."}' style="box-sizing:border-box;width:100%;height:62px;margin-top:8px;font:12px Consolas,monospace"></textarea>
      <div class="toolbar" style="margin:8px 0 0">
        <label><input id="archiveUseSavedHeaders" type="checkbox" checked> use saved browser headers first</label>
        <button id="startArchiveFanbox">Start FANBOX archive</button>
        <span id="archiveHeaderStatus" class="label">Open FANBOX with Discover enabled to capture headers automatically.</span>
      </div>
    </section>
    <table>
      <thead>
        <tr>
          <th>Video</th><th>Resolution</th><th>Media</th><th>Files</th><th>Missing</th><th>Subtitles</th><th>Latest</th><th>Size</th><th>Actions</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <h2 style="font-size:16px;margin:18px 0 8px">Jobs</h2>
    <table>
      <thead>
        <tr><th>Job</th><th>Status</th><th>Target</th><th>Quality</th><th>Progress</th><th>Speed Setting</th><th>Subtitles</th><th>Message</th></tr>
      </thead>
      <tbody id="jobs"></tbody>
    </table>
    <div id="log">Ready.</div>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    function log(text) { $("log").textContent = `${new Date().toLocaleTimeString()}  ${text}\n` + $("log").textContent; }
    async function api(path, options = {}) {
      const res = await fetch(path, options);
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      if (!res.ok) throw new Error(typeof body === "string" ? body : JSON.stringify(body));
      return body;
    }
    async function refresh() {
      const status = await api("/api/status");
      $("streams").textContent = status.streams.length;
      $("saved").textContent = status.counters.saved || 0;
      $("failed").textContent = status.counters.failed || 0;
      $("badSmall").textContent = status.counters.bad_small || 0;
      $("size").textContent = `${status.total_mb} MB`;
      const ping = status.last_ping;
      $("heartbeat").textContent = ping ? `${ping.reason} ${new Date(ping.server_time * 1000).toLocaleTimeString()}` : "no extension ping";
      const latestCcJob = (status.jobs || []).find(job => String(job.type || "").includes("subtitle"));
      const shortCcJob = latestCcJob && latestCcJob.status === "warning" && String(latestCcJob.message || "").toLowerCase().includes("cc looks short") ? latestCcJob : null;
      const fanboxHeaders = (status.archive_headers || {}).fanbox || null;
      if (fanboxHeaders && fanboxHeaders.updated_at) {
        $("archiveHeaderStatus").textContent = `saved FANBOX headers: ${fanboxHeaders.host || "fanbox"} ${new Date(fanboxHeaders.updated_at * 1000).toLocaleTimeString()}`;
      } else {
        $("archiveHeaderStatus").textContent = "Open FANBOX with Discover enabled to capture headers automatically.";
      }
      const subtitleNotice = $("subtitleNotice");
      if (shortCcJob) {
        subtitleNotice.classList.add("show");
        subtitleNotice.textContent = `CC subtitle looks shorter than expected for ${shortCcJob.product || "this video"}. Refresh the video page, turn CC on, play a few seconds, then click Download CC only again. Existing longer subtitle was kept.`;
      } else {
        subtitleNotice.classList.remove("show");
        subtitleNotice.textContent = "";
      }
      const rows = $("rows");
      rows.innerHTML = "";
      const candidates = $("candidates");
      candidates.innerHTML = "";
      for (const item of status.candidates || []) {
        const variants = item.variants || [];
        const subtitleCount = item.subtitle_urls ? Object.keys(item.subtitle_urls).length : 0;
        const subtitleHintCount = item.subtitle_hints ? Object.keys(item.subtitle_hints).length : 0;
        const urlBadges = [
          item.playlist_url ? "playlist" : "",
          item.segment_url ? "segment" : "",
          item.key_url ? "key" : "",
          subtitleCount ? `subtitle ${subtitleCount}` : "",
          subtitleHintCount ? `subtitle hint ${subtitleHintCount}` : ""
        ].filter(Boolean).join(" ");
        const qualityOptions = variants.length
          ? variants.map(v => `<option value="${v.resolution || ""}">${v.resolution || "auto"} ${v.bandwidth ? Math.round(v.bandwidth / 1000) + " kbps" : ""}</option>`).join("")
          : `<option value="${item.resolution || ""}">${item.resolution || "auto"}</option>`;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="mono">${item.product}<br>${item.resolution}</td>
          <td>${item.seen || 0}<br><span class="label">${item.last_seen ? new Date(item.last_seen * 1000).toLocaleTimeString() : ""}</span></td>
          <td class="mono">${urlBadges || "none"}<br><span class="label">${subtitleCount || subtitleHintCount ? "CC candidate detected" : "no CC detected"}</span></td>
          <td><select multiple size="${Math.min(Math.max(variants.length || 1, 1), 4)}" data-quality-for="${item.product}/${item.resolution}">${qualityOptions}</select><br><span class="label">Ctrl/Shift for multiple</span></td>
          <td><div class="actions">
            <button data-action="candidate-download" data-product="${item.product}" data-resolution="${item.resolution}">Direct download</button>
            <button data-action="candidate-subtitles" data-product="${item.product}" data-resolution="${item.resolution}">Download CC only</button>
          </div></td>`;
        candidates.appendChild(tr);
      }
      for (const row of status.streams) {
        const complete = row.missing_count === 0 && row.files > 0;
        const media = row.media_info || {};
        const tr = document.createElement("tr");
        const latestSubtitle = row.latest_subtitle || {};
        const subtitleMinutes = latestSubtitle.last_seconds ? `${Math.round(latestSubtitle.last_seconds / 60)}m` : "";
        const subtitleDetail = latestSubtitle.name ? `${latestSubtitle.name}${subtitleMinutes ? " | " + subtitleMinutes : ""}${latestSubtitle.cue_count ? " | " + latestSubtitle.cue_count + " cues" : ""}` : "";
        tr.innerHTML = `
          <td class="mono">${row.product}</td>
          <td>${row.resolution}</td>
          <td>${media.width && media.height ? `${media.width}x${media.height}` : ""}<br><span class="label">${media.codec || ""} ${media.fps || ""}</span></td>
          <td>${row.files}<br><span class="label">contig ${row.contiguous_from_start}</span></td>
          <td class="${complete ? "ok" : "warn"}">${row.missing_count}${row.bad_small_count ? `<br><span class="bad">small ${row.bad_small_count}</span>` : ""}<br><span class="mono">${(row.missing_first || []).join(", ")}</span></td>
          <td>${row.subtitle_count || 0}<br><span class="label mono" title="${latestSubtitle.path || ""}">${subtitleDetail}</span></td>
          <td class="mono">${row.last_segment || ""}<br>${row.latest_age_seconds == null ? "" : row.latest_age_seconds + "s ago"}</td>
          <td>${row.mb} MB</td>
          <td><div class="actions">
            <button data-action="retry" data-product="${row.product}" data-resolution="${row.resolution}">Retry</button>
            <button data-action="merge-strict" data-product="${row.product}" data-resolution="${row.resolution}">Merge strict</button>
            <button data-action="merge-fill" data-product="${row.product}" data-resolution="${row.resolution}">Merge fill-skip</button>
            <button data-action="merge-skip" data-product="${row.product}" data-resolution="${row.resolution}">Merge skip</button>
            <button data-action="open-subtitles" data-product="${row.product}" data-resolution="${row.resolution}">Open CC folder</button>
            <button data-action="convert-subtitles" data-product="${row.product}" data-resolution="${row.resolution}">Convert CC</button>
            <button data-action="export-player-subtitle" data-product="${row.product}" data-resolution="${row.resolution}">Export sidecar CC</button>
          </div></td>`;
        rows.appendChild(tr);
      }
      const jobs = $("jobs");
      jobs.innerHTML = "";
      for (const job of status.jobs || []) {
        const total = job.total || 0;
        const done = job.done || 0;
        const progressMax = Math.max(total, done, 1);
        const pct = total ? Math.min(100, Math.round(done / progressMax * 100)) : 0;
        const mb = ((job.saved_bytes || 0) / 1024 / 1024).toFixed(1);
        const eta = job.eta_seconds == null ? "" : `${Math.floor(job.eta_seconds / 60)}m ${Math.round(job.eta_seconds % 60)}s`;
        const hasSubtitles = (job.subtitle_tracks || []).length > 0;
        const jobActions = (job.status === "complete" || (job.status === "warning" && hasSubtitles))
          ? `<div class="actions">
              <button data-action="open-subtitles" data-product="${job.product || ""}" data-resolution="${job.resolution || ""}">Open folder</button>
              ${hasSubtitles ? `<button data-action="convert-subtitles" data-product="${job.product || ""}" data-resolution="${job.resolution || ""}">Convert CC</button>` : ""}
              ${hasSubtitles ? `<button data-action="export-player-subtitle" data-product="${job.product || ""}" data-resolution="${job.resolution || ""}">Export sidecar CC</button>` : ""}
            </div>`
          : "";
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="mono">${job.id || ""}<br>${job.type || ""}</td>
          <td class="${job.status === "complete" ? "ok" : job.status === "failed" ? "bad" : "warn"}">${job.status || ""}</td>
          <td class="mono">${job.product || ""}<br>${job.resolution || ""}</td>
          <td>requested ${job.requested_resolution || job.preferred_resolution || "auto"}<br>chosen ${job.chosen_resolution || job.resolution || ""}${job.fallback_from ? `<br><span class="warn">fallback from ${job.fallback_from}</span>` : ""}</td>
          <td><progress value="${Math.min(done, progressMax)}" max="${progressMax}"></progress> ${pct}%<br>${done}/${total}<br><span class="label">saved ${job.saved || 0}, existing ${job.skipped_existing || 0}, failed ${job.failed || 0}, small ${job.bad_small || 0}</span></td>
          <td>${job.workers || ""} workers<br><span class="label">${job.request_delay_ms || 0} ms/request</span><br>${job.speed_mbps || 0} MB/s<br><span class="label">${mb} MB${eta ? ", ETA " + eta : ""}</span></td>
          <td>${(job.subtitle_tracks || []).length}<br><span class="label">${job.subtitle_convert_mode || "none"}</span></td>
          <td>${job.message || ""}${jobActions}</td>`;
        jobs.appendChild(tr);
      }
    }
    document.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      try {
        if (btn.id === "refresh") return refresh();
        if (btn.id === "retryAll") {
          const result = await api("/api/retry-missing", { method: "POST", headers: {"content-type":"application/json"}, body: "{}" });
          log(`retry queued ${result.queued}`);
          return refresh();
        }
        if (btn.id === "startArchiveFanbox") {
          const result = await api("/api/archive/fanbox", {
            method: "POST",
            headers: {"content-type":"application/json"},
            body: JSON.stringify({
              creator_id: $("archiveCreator").value.trim(),
              start_page: Number($("archiveStartPage").value || 1),
              end_page: $("archiveEndPage").value.trim(),
              workers: Number($("archiveWorkers").value || 4),
              request_delay_ms: Number($("archiveDelay").value || 100),
              zip_only: $("archiveZipOnly").checked,
              use_saved_headers: $("archiveUseSavedHeaders").checked,
              output_dir: $("archiveOutput").value.trim(),
              headers_json: $("archiveHeaders").value.trim()
            })
          });
          log(`archive job started: ${result.id}`);
          return refresh();
        }
        if (btn.id === "startDirect") {
          const preferred_resolutions = $("directResolution").value.split(",").map(x => x.trim()).filter(Boolean);
          const result = await api("/api/direct-download", {
            method: "POST",
            headers: {"content-type":"application/json"},
            body: JSON.stringify({
              url: $("directUrl").value.trim(),
              product: $("directProduct").value.trim(),
              resolution: preferred_resolutions.length === 1 ? preferred_resolutions[0] : "",
              preferred_resolution: preferred_resolutions[0] || "",
              preferred_resolutions,
              quality_fallback: $("qualityFallback").checked,
              subtitle_convert_mode: $("subtitleConvert").value,
              workers: Number($("directWorkers").value || 8),
              request_delay_ms: Number($("directDelay").value || 0),
              headers_json: $("directHeaders").value.trim(),
              use_saved_headers: $("useSavedHeaders").checked
            })
          });
          log(result.jobs ? `direct jobs started: ${result.jobs.map(j => j.id).join(", ")}` : `direct job started: ${result.id}`);
          return refresh();
        }
        if (btn.id === "startSubtitleOnly") {
          const result = await api("/api/subtitles-only", {
            method: "POST",
            headers: {"content-type":"application/json"},
            body: JSON.stringify({
              url: $("directUrl").value.trim(),
              product: $("directProduct").value.trim(),
              resolution: $("directResolution").value.split(",")[0].trim(),
              subtitle_convert_mode: $("subtitleConvert").value,
              headers_json: $("directHeaders").value.trim(),
              use_saved_headers: $("useSavedHeaders").checked
            })
          });
          log(`subtitle-only job started: ${result.id}`);
          return refresh();
        }
        const product = btn.dataset.product;
        const resolution = btn.dataset.resolution;
        if (btn.dataset.action === "retry") {
          const result = await api("/api/retry-missing", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({product, resolution}) });
          log(`${product}/${resolution} retry queued ${result.queued}`);
        }
        if (btn.dataset.action === "candidate-download") {
          const select = document.querySelector(`select[data-quality-for="${product}/${resolution}"]`);
          const preferred_resolutions = select ? Array.from(select.selectedOptions).map(option => option.value).filter(Boolean) : [resolution];
          const result = await api("/api/start-candidate-download", {
            method: "POST",
            headers: {"content-type":"application/json"},
            body: JSON.stringify({product, resolution, preferred_resolutions: preferred_resolutions.length ? preferred_resolutions : [resolution], quality_fallback: $("qualityFallback").checked, subtitle_convert_mode: $("subtitleConvert").value, workers: Number($("directWorkers").value || 8), request_delay_ms: Number($("directDelay").value || 0)})
          });
          log(result.jobs ? `candidate jobs started: ${result.jobs.map(j => j.id).join(", ")}` : `candidate direct job started: ${result.id}`);
        }
        if (btn.dataset.action === "candidate-subtitles") {
          const result = await api("/api/start-candidate-subtitles", {
            method: "POST",
            headers: {"content-type":"application/json"},
            body: JSON.stringify({product, resolution, subtitle_convert_mode: $("subtitleConvert").value})
          });
          log(`candidate subtitle-only job started: ${result.id}`);
        }
        if (btn.dataset.action === "convert-subtitles") {
          const mode = $("subtitleConvert").value;
          if (mode === "none") {
            log("choose a CC convert mode first, e.g. Traditional Chinese -> Simplified");
            return;
          }
          const result = await api("/api/convert-subtitles", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({product, resolution, mode}) });
          const outputs = (result.converted || []).map(item => item.output).filter(Boolean);
          log(`converted subtitles: ${outputs.length} file(s), mode=${mode}${outputs.length ? "\\n" + outputs.join("\\n") : ""}`);
        }
        if (btn.dataset.action === "open-subtitles") {
          const result = await api("/api/open-location", {
            method: "POST",
            headers: {"content-type":"application/json"},
            body: JSON.stringify({product, resolution, kind: "subtitles"})
          });
          log(`opened folder: ${result.opened}`);
        }
        if (btn.dataset.action === "export-player-subtitle") {
          const result = await api("/api/export-player-subtitle", {
            method: "POST",
            headers: {"content-type":"application/json"},
            body: JSON.stringify({product, resolution, mode: $("subtitleConvert").value})
          });
          log(`${result.message}: ${result.output}`);
        }
        if (btn.dataset.action && btn.dataset.action.startsWith("merge")) {
          const strategy = btn.dataset.action === "merge-strict" ? "strict" : btn.dataset.action === "merge-skip" ? "skip" : "fill-skip";
          log(`merge started ${product}/${resolution} ${strategy}`);
          const result = await api("/api/merge", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({product, resolution, strategy}) });
          log(`merge done: ${result.output}\nreplacements=${result.replacements.length}, skipped=${result.skipped.length}`);
        }
        await refresh();
      } catch (err) {
        log(`ERROR ${err.message}`);
      }
    });
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>
"""


def make_handler(store: CaptureStore):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            return

        def send_json(self, status: int, value: Any) -> None:
            body = json_bytes(value)
            self.send_response(status)
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-headers", "content-type")
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def send_text(self, status: int, text: str, content_type: str = "text/plain; charset=utf-8") -> None:
            body = text.encode("utf-8")
            self.send_response(status)
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-headers", "content-type")
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("content-length", "0") or "0")
            if length <= 0:
                return {}
            return json.loads(self.rfile.read(length).decode("utf-8"))

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
            self.send_header("access-control-allow-headers", "content-type")
            self.end_headers()

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path in {"/", "/dashboard"}:
                self.send_text(200, DASHBOARD_HTML, "text/html; charset=utf-8")
                return
            if parsed.path in {"/api/status", "/status"}:
                self.send_json(200, store.app_status())
                return
            if parsed.path == "/api/streams":
                self.send_json(200, store.list_streams())
                return
            self.send_text(404, "not found")

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            try:
                payload = self.read_json()
                if parsed.path == "/ping":
                    store.record_ping(payload)
                    self.send_json(200, {"ok": True})
                    return
                if parsed.path == "/candidate":
                    status, message = store.record_candidate(payload)
                    self.send_json(status, {"message": message})
                    return
                if parsed.path == "/capture":
                    status, message = store.enqueue_payload(payload)
                    self.send_json(status, {"message": message})
                    return
                if parsed.path == "/api/archive/headers":
                    status, message = store.record_archive_headers(payload)
                    self.send_json(status, {"message": message})
                    return
                if parsed.path == "/api/retry-missing":
                    result = store.retry_missing(
                        product=payload.get("product"),
                        resolution=payload.get("resolution"),
                        limit_per_stream=int(payload.get("limit_per_stream") or 200),
                    )
                    self.send_json(200, result)
                    return
                if parsed.path == "/api/direct-download":
                    preferred_resolutions = payload.get("preferred_resolutions") or []
                    if preferred_resolutions:
                        jobs = []
                        for preferred in preferred_resolutions:
                            item_payload = dict(payload)
                            item_payload["preferred_resolution"] = preferred
                            item_payload["resolution"] = ""
                            item_payload.pop("preferred_resolutions", None)
                            jobs.append(store.start_direct_download(item_payload))
                        result = {"jobs": jobs, "count": len(jobs)}
                    else:
                        result = store.start_direct_download(payload)
                    self.send_json(200, result)
                    return
                if parsed.path == "/api/subtitles-only":
                    result = store.start_subtitle_download(payload)
                    self.send_json(200, result)
                    return
                if parsed.path == "/api/archive/fanbox":
                    result = store.start_archive_fanbox(payload)
                    self.send_json(200, result)
                    return
                if parsed.path == "/api/start-candidate-download":
                    preferred_resolutions = payload.get("preferred_resolutions") or [payload.get("preferred_resolution") or ""]
                    jobs = [
                        store.start_candidate_download(
                            product=payload["product"],
                            resolution=payload["resolution"],
                            workers=int(payload.get("workers") or 8),
                            request_delay_ms=int(payload.get("request_delay_ms") or 0),
                            preferred_resolution=preferred or "",
                            quality_fallback=bool(payload.get("quality_fallback", True)),
                            subtitle_convert_mode=payload.get("subtitle_convert_mode") or "none",
                        )
                        for preferred in preferred_resolutions
                    ]
                    result = jobs[0] if len(jobs) == 1 else {"jobs": jobs, "count": len(jobs)}
                    self.send_json(200, result)
                    return
                if parsed.path == "/api/start-candidate-subtitles":
                    result = store.start_candidate_subtitle_download(
                        product=payload["product"],
                        resolution=payload["resolution"],
                        subtitle_convert_mode=payload.get("subtitle_convert_mode") or "none",
                    )
                    self.send_json(200, result)
                    return
                if parsed.path == "/api/convert-subtitles":
                    result = store.convert_subtitles(
                        product=payload["product"],
                        resolution=payload.get("resolution"),
                        mode=payload.get("mode") or payload.get("subtitle_convert_mode") or "none",
                    )
                    self.send_json(200, result)
                    return
                if parsed.path == "/api/open-location":
                    result = store.open_location(
                        product=payload.get("product"),
                        resolution=payload.get("resolution"),
                        kind=payload.get("kind") or "stream",
                        path=payload.get("path"),
                    )
                    self.send_json(200, result)
                    return
                if parsed.path == "/api/export-player-subtitle":
                    result = store.export_player_subtitle(
                        product=payload["product"],
                        resolution=payload.get("resolution"),
                        mode=payload.get("mode") or payload.get("subtitle_convert_mode") or "none",
                    )
                    self.send_json(200, result)
                    return
                if parsed.path == "/api/merge":
                    result = store.merge(
                        product=payload["product"],
                        resolution=payload.get("resolution"),
                        strategy=payload.get("strategy", "fill-skip"),
                    )
                    self.send_json(200, result)
                    return
                self.send_text(404, "not found")
            except Exception as exc:
                self.send_json(500, {"error": str(exc)})

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="HLS Keeper local capture server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17888)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--archive-dir", type=Path, default=DEFAULT_ARCHIVE_DIR)
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG", DEFAULT_FFMPEG))
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--burst-ahead", type=int, default=180)
    parser.add_argument("--backfill", type=int, default=3)
    parser.add_argument("--min-segment-bytes", type=int, default=188)
    parser.add_argument("--auto-retry-seconds", type=int, default=45)
    args = parser.parse_args()

    store = CaptureStore(
        data_dir=args.data_dir,
        output_dir=args.output_dir,
        archive_dir=args.archive_dir,
        ffmpeg=args.ffmpeg,
        workers=args.workers,
        burst_ahead=args.burst_ahead,
        backfill=args.backfill,
        min_segment_bytes=args.min_segment_bytes,
        auto_retry_seconds=args.auto_retry_seconds,
    )
    server = ThreadingHTTPServer((args.host, args.port), make_handler(store))
    print(f"{APP_NAME} {APP_VERSION}", flush=True)
    print(f"Dashboard: http://{args.host}:{args.port}/", flush=True)
    print(f"Capture endpoint: http://{args.host}:{args.port}/capture", flush=True)
    print(f"Data: {args.data_dir}", flush=True)
    print(f"Archives: {args.archive_dir}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
