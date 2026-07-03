from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
import json
from pathlib import Path
import re
import shutil
import time
from typing import Any, Callable
from urllib.parse import unquote, urlencode, urljoin, urlparse
import zipfile

import requests


FANBOX_API = "https://api.fanbox.cc"
ZIP_EXTENSIONS = {"zip"}
ARCHIVE_EXTENSIONS = {"zip", "rar", "7z", "tar", "gz", "tgz", "cbz", "bz2", "xz"}
LINK_ATTR_RE = re.compile(r"""(?:href|src|data-href|data-url|data-download-url)\s*=\s*["']([^"'<>]+)["']""", re.I)
CONTENT_DISPOSITION_RE = re.compile(r"""filename\*?=(?:UTF-8'')?["']?([^"';]+)""", re.I)
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
}


@dataclass(frozen=True)
class ArchiveFile:
    post_id: str
    post_title: str
    name: str
    extension: str
    url: str
    size: int | None = None

    @property
    def filename(self) -> str:
        suffix = f".{self.extension.lstrip('.')}" if self.extension else ""
        if suffix and self.name.lower().endswith(suffix.lower()):
            return self.name
        return f"{self.name}{suffix}"


def safe_filename(value: str, fallback: str = "download") -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", value).strip().rstrip(".")
    if not cleaned:
        cleaned = fallback
    if cleaned.upper() in WINDOWS_RESERVED_NAMES:
        cleaned = f"_{cleaned}"
    return cleaned[:180]


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    for index in range(2, 10000):
        candidate = path.with_name(f"{stem} ({index}){suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Could not find a free filename for {path}")


def parse_headers_json(headers_json: str | None) -> dict[str, str]:
    if not headers_json or not headers_json.strip():
        return {}
    value = json.loads(headers_json)
    if not isinstance(value, dict):
        raise RuntimeError("headers_json must be a JSON object")
    return {str(key): str(item) for key, item in value.items() if str(key).strip()}


def normalize_headers(headers: dict[str, str] | None) -> dict[str, str]:
    result = {
        "accept": "application/json, text/plain, */*",
        "origin": "https://www.fanbox.cc",
        "referer": "https://www.fanbox.cc/",
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
        ),
    }
    for key, value in (headers or {}).items():
        if key and value:
            result[str(key)] = str(value)
    return result


def response_body(data: dict[str, Any]) -> dict[str, Any]:
    body = data.get("body")
    if isinstance(body, dict):
        return body
    return data


def fanbox_files_from_post(post: dict[str, Any], zip_only: bool = True) -> list[ArchiveFile]:
    post_id = str(post.get("id") or "")
    title = str(post.get("title") or post_id or "post")
    found: list[ArchiveFile] = []
    seen: set[tuple[str, str, str]] = set()

    def append_file(item: dict[str, Any]) -> None:
        url = str(item.get("url") or item.get("downloadUrl") or "").strip()
        name = str(item.get("name") or item.get("filename") or "").strip()
        extension = str(item.get("extension") or Path(name).suffix.lstrip(".")).strip().lower()
        if not url or not name:
            return
        if zip_only and extension not in ZIP_EXTENSIONS:
            return
        key = (url, name, extension)
        if key in seen:
            return
        seen.add(key)
        size_value = item.get("size")
        found.append(
            ArchiveFile(
                post_id=post_id,
                post_title=title,
                name=name,
                extension=extension,
                url=url,
                size=int(size_value) if isinstance(size_value, int) else None,
            )
        )

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            append_file(value)
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(post)
    return found


class FanboxArchiveDownloader:
    def __init__(
        self,
        output_root: Path,
        headers: dict[str, str] | None = None,
        workers: int = 4,
        request_delay_ms: int = 100,
        zip_only: bool = True,
        update: Callable[..., None] | None = None,
    ):
        self.output_root = output_root
        self.headers = normalize_headers(headers)
        self.workers = max(1, min(int(workers), 32))
        self.request_delay_ms = max(0, min(int(request_delay_ms), 10000))
        self.zip_only = zip_only
        self.update = update or (lambda **_: None)
        self.session = requests.Session()
        self.session.headers.update(self.headers)

    def get_json(self, url: str) -> dict[str, Any]:
        response = self.session.get(url, timeout=30)
        if response.status_code != 200:
            raise RuntimeError(f"FANBOX API HTTP {response.status_code}: {response.text[:200]}")
        data = response.json()
        if not isinstance(data, dict):
            raise RuntimeError("FANBOX API returned non-object JSON")
        return data

    def list_page_url(self, creator_id: str, limit: int) -> str:
        query = urlencode({"creatorId": creator_id, "limit": limit})
        return f"{FANBOX_API}/post.listCreator?{query}"

    def post_info_url(self, post_id: str) -> str:
        return f"{FANBOX_API}/post.info?{urlencode({'postId': post_id})}"

    def iter_creator_pages(
        self,
        creator_id: str,
        start_page: int = 1,
        end_page: int | None = None,
        limit: int = 10,
    ):
        page_number = 1
        next_url: str | None = self.list_page_url(creator_id, limit)
        while next_url:
            data = self.get_json(next_url)
            body = response_body(data)
            items = body.get("items") or []
            if not isinstance(items, list):
                raise RuntimeError("FANBOX post list response has no items list")
            if page_number >= start_page:
                yield page_number, items
            if end_page is not None and page_number >= end_page:
                break
            next_url = body.get("nextUrl") or body.get("next")
            page_number += 1

    def post_files(self, post_id: str) -> list[ArchiveFile]:
        data = self.get_json(self.post_info_url(post_id))
        body = response_body(data)
        return fanbox_files_from_post(body, zip_only=self.zip_only)

    def verify_download(self, path: Path, item: ArchiveFile) -> None:
        if item.size is not None and path.stat().st_size != item.size:
            raise RuntimeError(f"size mismatch: expected {item.size}, got {path.stat().st_size}")
        if item.extension == "zip":
            with zipfile.ZipFile(path, "r") as zf:
                bad_member = zf.testzip()
                if bad_member is not None:
                    raise RuntimeError(f"bad ZIP member: {bad_member}")

    def download_one(self, item: ArchiveFile, page_dir: Path) -> dict[str, Any]:
        page_dir.mkdir(parents=True, exist_ok=True)
        target = page_dir / safe_filename(item.filename, fallback=f"{item.post_id}.zip")
        if target.exists() and (item.size is None or target.stat().st_size == item.size):
            return {
                "status": "existing",
                "post_id": item.post_id,
                "name": item.filename,
                "path": str(target),
                "bytes": target.stat().st_size,
            }
        target = unique_path(target)
        part = target.with_name(f"{target.name}.part")
        if self.request_delay_ms:
            time.sleep(self.request_delay_ms / 1000)
        with self.session.get(item.url, stream=True, timeout=60) as response:
            if response.status_code != 200:
                raise RuntimeError(f"download HTTP {response.status_code}")
            with part.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        handle.write(chunk)
        self.verify_download(part, item)
        part.replace(target)
        return {
            "status": "saved",
            "post_id": item.post_id,
            "name": item.filename,
            "path": str(target),
            "bytes": target.stat().st_size,
        }

    def download_creator(
        self,
        creator_id: str,
        start_page: int = 1,
        end_page: int | None = None,
        limit: int = 10,
    ) -> dict[str, Any]:
        root = self.output_root
        root.mkdir(parents=True, exist_ok=True)
        manifest_path = root / "archive_manifest.jsonl"
        saved = 0
        skipped_existing = 0
        failed = 0
        done = 0
        total = 0
        saved_bytes = 0

        for page_number, posts in self.iter_creator_pages(
            creator_id=creator_id,
            start_page=start_page,
            end_page=end_page,
            limit=limit,
        ):
            page_dir = root / f"Page {page_number:03d}"
            page_files: list[ArchiveFile] = []
            self.update(status="fetching-posts", message=f"Fetching page {page_number}")
            for post in posts:
                post_id = str(post.get("id") or "")
                if not post_id:
                    continue
                page_files.extend(self.post_files(post_id))

            total += len(page_files)
            self.update(total=total, done=done, message=f"Downloading page {page_number}")

            with ThreadPoolExecutor(max_workers=self.workers) as executor:
                futures = [executor.submit(self.download_one, item, page_dir) for item in page_files]
                for future in as_completed(futures):
                    done += 1
                    try:
                        result = future.result()
                        if result["status"] == "existing":
                            skipped_existing += 1
                        else:
                            saved += 1
                        saved_bytes += int(result.get("bytes") or 0)
                    except Exception as exc:
                        failed += 1
                        result = {"status": "failed", "error": str(exc)}
                    with manifest_path.open("a", encoding="utf-8") as handle:
                        handle.write(json.dumps({"page": page_number, **result}, ensure_ascii=False) + "\n")
                    self.update(
                        status="downloading",
                        done=done,
                        total=total,
                        saved=saved,
                        skipped_existing=skipped_existing,
                        failed=failed,
                        saved_bytes=saved_bytes,
                        message=f"Page {page_number}: {done}/{total}",
                    )

        return {
            "done": done,
            "total": total,
            "saved": saved,
            "skipped_existing": skipped_existing,
            "failed": failed,
            "saved_bytes": saved_bytes,
            "output_dir": str(root),
            "manifest": str(manifest_path),
        }


def generic_headers(headers: dict[str, str] | None = None, referer: str = "") -> dict[str, str]:
    result = {
        "accept": "*/*",
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
        ),
    }
    if referer:
        result["referer"] = referer
    for key, value in (headers or {}).items():
        if key and value:
            result[str(key)] = str(value)
    return result


def archive_extension_from_url(url: str) -> str:
    path = unquote(urlparse(url).path)
    lower = path.lower()
    for compound in (".tar.gz", ".tar.bz2", ".tar.xz"):
        if lower.endswith(compound):
            return compound.lstrip(".")
    extension = Path(lower).suffix.lstrip(".")
    return extension if extension in ARCHIVE_EXTENSIONS else ""


def filename_from_url(url: str, fallback: str = "download.bin") -> str:
    name = unquote(Path(urlparse(url).path).name)
    return safe_filename(name, fallback=fallback) if name else fallback


def filename_from_response(response: requests.Response) -> str:
    disposition = response.headers.get("content-disposition") or ""
    match = CONTENT_DISPOSITION_RE.search(disposition)
    if match:
        return safe_filename(unquote(match.group(1)).strip())
    return ""


def scan_page_for_archives(url: str, headers: dict[str, str] | None = None, timeout: int = 30) -> list[dict[str, Any]]:
    session = requests.Session()
    session.headers.update(generic_headers(headers, referer=url))
    response = session.get(url, timeout=timeout)
    if response.status_code != 200:
        raise RuntimeError(f"scan HTTP {response.status_code}")
    seen: set[str] = set()
    links: list[dict[str, Any]] = []
    for raw in LINK_ATTR_RE.findall(response.text or ""):
        absolute = urljoin(response.url, raw.strip())
        if absolute in seen:
            continue
        extension = archive_extension_from_url(absolute)
        if not extension:
            continue
        seen.add(absolute)
        links.append(
            {
                "url": absolute,
                "filename": filename_from_url(absolute, fallback=f"download.{extension}"),
                "extension": extension,
            }
        )
    return links


class GenericArchiveDownloader:
    def __init__(
        self,
        output_root: Path,
        headers: dict[str, str] | None = None,
        referer: str = "",
        workers: int = 4,
        request_delay_ms: int = 100,
        update: Callable[..., None] | None = None,
    ):
        self.output_root = output_root
        self.headers = generic_headers(headers, referer=referer)
        self.workers = max(1, min(int(workers), 32))
        self.request_delay_ms = max(0, min(int(request_delay_ms), 10000))
        self.update = update or (lambda **_: None)
        self.session = requests.Session()
        self.session.headers.update(self.headers)

    def verify_download(self, path: Path, extension: str) -> None:
        if path.stat().st_size == 0:
            raise RuntimeError("empty file")
        if extension in {"zip", "cbz"}:
            with zipfile.ZipFile(path, "r") as zf:
                bad_member = zf.testzip()
                if bad_member is not None:
                    raise RuntimeError(f"bad ZIP member: {bad_member}")

    def download_one(self, url: str) -> dict[str, Any]:
        self.output_root.mkdir(parents=True, exist_ok=True)
        if self.request_delay_ms:
            time.sleep(self.request_delay_ms / 1000)
        with self.session.get(url, stream=True, timeout=120) as response:
            if response.status_code != 200:
                raise RuntimeError(f"download HTTP {response.status_code}: {url}")
            name = filename_from_response(response) or filename_from_url(url)
            target = self.output_root / safe_filename(name)
            content_length = response.headers.get("content-length") or ""
            expected = int(content_length) if content_length.isdigit() else None
            if target.exists() and expected is not None and target.stat().st_size == expected:
                return {
                    "status": "existing",
                    "url": url,
                    "name": target.name,
                    "path": str(target),
                    "bytes": target.stat().st_size,
                }
            target = unique_path(target)
            part = target.with_name(f"{target.name}.part")
            with part.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        handle.write(chunk)
        if expected is not None and part.stat().st_size != expected:
            size = part.stat().st_size
            part.unlink(missing_ok=True)
            raise RuntimeError(f"size mismatch: expected {expected}, got {size}")
        self.verify_download(part, Path(target.name).suffix.lstrip(".").lower())
        part.replace(target)
        return {
            "status": "saved",
            "url": url,
            "name": target.name,
            "path": str(target),
            "bytes": target.stat().st_size,
        }

    def download_all(self, urls: list[str]) -> dict[str, Any]:
        root = self.output_root
        root.mkdir(parents=True, exist_ok=True)
        manifest_path = root / "archive_manifest.jsonl"
        total = len(urls)
        done = saved = skipped_existing = failed = 0
        saved_bytes = 0
        self.update(status="downloading", total=total, done=0, message=f"Downloading {total} file(s)")
        with ThreadPoolExecutor(max_workers=self.workers) as executor:
            futures = {executor.submit(self.download_one, url): url for url in urls}
            for future in as_completed(futures):
                done += 1
                try:
                    result = future.result()
                    if result["status"] == "existing":
                        skipped_existing += 1
                    else:
                        saved += 1
                    saved_bytes += int(result.get("bytes") or 0)
                except Exception as exc:
                    failed += 1
                    result = {"status": "failed", "url": futures[future], "error": str(exc)}
                with manifest_path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(result, ensure_ascii=False) + "\n")
                self.update(
                    status="downloading",
                    done=done,
                    total=total,
                    saved=saved,
                    skipped_existing=skipped_existing,
                    failed=failed,
                    saved_bytes=saved_bytes,
                    message=f"{done}/{total}",
                )
        return {
            "done": done,
            "total": total,
            "saved": saved,
            "skipped_existing": skipped_existing,
            "failed": failed,
            "saved_bytes": saved_bytes,
            "output_dir": str(root),
            "manifest": str(manifest_path),
        }
