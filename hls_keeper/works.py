from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
from urllib.parse import urlsplit, urlunsplit


SEGMENT_NUMBER_RE = re.compile(r"(?P<number>\d+)(?=\.ts$)", re.I)


def canonical_site(url: str) -> str:
    """Return a stable site key without credentials or a port."""
    try:
        return (urlsplit(url).hostname or "unknown").lower()
    except ValueError:
        return "unknown"


def stable_work_id(site: str, product_id: str) -> str:
    raw = f"{site.strip().lower()}\0{product_id.strip()}".encode("utf-8")
    return f"work_{hashlib.sha256(raw).hexdigest()[:20]}"


def stable_variant_id(work_id: str, resolution: str) -> str:
    raw = f"{work_id}\0{resolution.strip().lower()}".encode("utf-8")
    return f"variant_{hashlib.sha256(raw).hexdigest()[:20]}"


def normalized_media_url(url: str) -> str:
    """Drop short-lived query/fragment values while keeping media identity."""
    try:
        parsed = urlsplit(url)
        return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, "", ""))
    except ValueError:
        return url


def segment_fingerprint(url: str, byte_range: str = "") -> str:
    raw = f"{normalized_media_url(url)}\0{byte_range}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def sequence_from_filename(path: str | Path) -> int | None:
    match = SEGMENT_NUMBER_RE.search(Path(path).name)
    return int(match.group("number")) if match else None


def missing_ranges(
    present_sequences: list[int] | set[int],
    expected_start: int | None = None,
    expected_end: int | None = None,
) -> list[dict[str, int]]:
    present = sorted(set(int(item) for item in present_sequences))
    if expected_start is None:
        expected_start = present[0] if present else None
    if expected_end is None:
        expected_end = present[-1] if present else None
    if expected_start is None or expected_end is None or expected_end < expected_start:
        return []

    present_set = set(present)
    missing = [number for number in range(expected_start, expected_end + 1) if number not in present_set]
    if not missing:
        return []

    ranges: list[dict[str, int]] = []
    start = previous = missing[0]
    for number in missing[1:]:
        if number != previous + 1:
            ranges.append({"from": start, "to": previous, "count": previous - start + 1})
            start = number
        previous = number
    ranges.append({"from": start, "to": previous, "count": previous - start + 1})
    return ranges


def recommended_action(
    *,
    session_status: str = "",
    disk_missing: int | None = None,
    saved_segments: int = 0,
    has_output: bool = False,
) -> str:
    if has_output:
        return "open-output"
    if session_status in {"queued", "resolving", "downloading", "browser-assisted", "merging"}:
        return "view-progress"
    if session_status == "waiting-browser":
        return "open-browser"
    if session_status in {"paused", "failed", "warning"}:
        return "resume"
    if saved_segments <= 0:
        return "start-download"
    if disk_missing is None:
        return "inspect"
    if disk_missing > 0:
        return "fill-gaps"
    return "merge"


@dataclass(frozen=True)
class WorkIdentity:
    site: str
    product_id: str

    @property
    def id(self) -> str:
        return stable_work_id(self.site, self.product_id)


@dataclass(frozen=True)
class VariantMetrics:
    saved_segments: int
    saved_bytes: int
    first_sequence: int | None
    last_sequence: int | None
    disk_missing: int | None
