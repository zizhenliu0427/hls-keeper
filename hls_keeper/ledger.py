from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import time
from typing import Any, Iterator

from .works import (
    VariantMetrics,
    canonical_site,
    missing_ranges,
    recommended_action,
    segment_fingerprint,
    sequence_from_filename,
    stable_variant_id,
    stable_work_id,
)


SCHEMA_VERSION = 2


def unix_time() -> int:
    return int(time.time())


class DownloadLedger:
    """Durable work/download index. It never moves or deletes captured media."""

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        with self.lock:
            self.connection.execute("PRAGMA foreign_keys = ON")
            self.connection.execute("PRAGMA journal_mode = WAL")
            self.connection.execute("PRAGMA synchronous = NORMAL")
            self._create_schema()

    def close(self) -> None:
        with self.lock:
            self.connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self.lock:
            try:
                yield self.connection
                self.connection.commit()
            except Exception:
                self.connection.rollback()
                raise

    def _create_schema(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS works (
                id TEXT PRIMARY KEY,
                site TEXT NOT NULL,
                product_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                source_page_url TEXT NOT NULL DEFAULT '',
                primary_variant_id TEXT,
                capture_policy TEXT NOT NULL DEFAULT 'ask',
                status TEXT NOT NULL DEFAULT 'detected',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(site, product_id)
            );

            CREATE TABLE IF NOT EXISTS variants (
                id TEXT PRIMARY KEY,
                work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
                resolution TEXT NOT NULL,
                bandwidth INTEGER,
                codecs TEXT NOT NULL DEFAULT '',
                playlist_url TEXT NOT NULL DEFAULT '',
                playlist_type TEXT NOT NULL DEFAULT '',
                selected INTEGER NOT NULL DEFAULT 0,
                media_sequence INTEGER,
                expected_segments INTEGER,
                saved_segments INTEGER NOT NULL DEFAULT 0,
                first_sequence INTEGER,
                last_sequence INTEGER,
                disk_missing INTEGER,
                saved_bytes INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'detected',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(work_id, resolution)
            );

            CREATE TABLE IF NOT EXISTS subtitles (
                id TEXT PRIMARY KEY,
                work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
                language TEXT NOT NULL DEFAULT 'und',
                label TEXT NOT NULL DEFAULT '',
                format TEXT NOT NULL DEFAULT '',
                source_url TEXT NOT NULL DEFAULT '',
                output_path TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'detected',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS segments (
                variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
                sequence INTEGER NOT NULL,
                uri_fingerprint TEXT NOT NULL,
                source_url TEXT NOT NULL DEFAULT '',
                byte_range TEXT NOT NULL DEFAULT '',
                duration REAL,
                start_seconds REAL,
                end_seconds REAL,
                local_path TEXT NOT NULL DEFAULT '',
                expected_bytes INTEGER,
                actual_bytes INTEGER,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(variant_id, sequence, uri_fingerprint)
            );

            CREATE TABLE IF NOT EXISTS download_sessions (
                id TEXT PRIMARY KEY,
                work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
                selected_variant_ids TEXT NOT NULL DEFAULT '[]',
                mode TEXT NOT NULL,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                last_progress_at INTEGER,
                pause_reason TEXT NOT NULL DEFAULT '',
                resumable INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_variants_work ON variants(work_id);
            CREATE INDEX IF NOT EXISTS idx_segments_status ON segments(variant_id, status);
            CREATE INDEX IF NOT EXISTS idx_subtitles_work ON subtitles(work_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_work ON download_sessions(work_id, updated_at DESC);
            """
        )
        variant_columns = {
            str(row["name"])
            for row in self.connection.execute("PRAGMA table_info(variants)").fetchall()
        }
        if "media_sequence" not in variant_columns:
            self.connection.execute("ALTER TABLE variants ADD COLUMN media_sequence INTEGER")
        self.connection.execute(
            "INSERT INTO metadata(key, value) VALUES('schema_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(SCHEMA_VERSION),),
        )
        self.connection.commit()

    def ensure_work(
        self,
        site: str,
        product_id: str,
        *,
        title: str = "",
        source_page_url: str = "",
        status: str = "detected",
    ) -> str:
        site = (site or "unknown").strip().lower()
        product_id = (product_id or "unknown").strip()
        work_id = stable_work_id(site, product_id)
        stamp = unix_time()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO works(id, site, product_id, title, source_page_url, status, created_at, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(site, product_id) DO UPDATE SET
                    title=CASE WHEN excluded.title != '' THEN excluded.title ELSE works.title END,
                    source_page_url=CASE WHEN excluded.source_page_url != '' THEN excluded.source_page_url ELSE works.source_page_url END,
                    status=CASE WHEN excluded.status != '' THEN excluded.status ELSE works.status END,
                    updated_at=excluded.updated_at
                """,
                (work_id, site, product_id, title, source_page_url, status, stamp, stamp),
            )
        return work_id

    def ensure_work_for_url(self, product_id: str, url: str, **values: Any) -> str:
        return self.ensure_work(canonical_site(url), product_id, source_page_url=url, **values)

    def ensure_variant(
        self,
        work_id: str,
        resolution: str,
        *,
        playlist_url: str = "",
        bandwidth: int | None = None,
        codecs: str = "",
        playlist_type: str = "",
        selected: bool | None = None,
        media_sequence: int | None = None,
        expected_segments: int | None = None,
        status: str = "detected",
    ) -> str:
        resolution = (resolution or "unknown").strip()
        variant_id = stable_variant_id(work_id, resolution)
        stamp = unix_time()
        selected_value = 1 if selected else 0
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO variants(
                    id, work_id, resolution, bandwidth, codecs, playlist_url, playlist_type,
                    selected, media_sequence, expected_segments, status, created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(work_id, resolution) DO UPDATE SET
                    bandwidth=COALESCE(excluded.bandwidth, variants.bandwidth),
                    codecs=CASE WHEN excluded.codecs != '' THEN excluded.codecs ELSE variants.codecs END,
                    playlist_url=CASE WHEN excluded.playlist_url != '' THEN excluded.playlist_url ELSE variants.playlist_url END,
                    playlist_type=CASE WHEN excluded.playlist_type != '' THEN excluded.playlist_type ELSE variants.playlist_type END,
                    selected=CASE WHEN ? IS NULL THEN variants.selected ELSE excluded.selected END,
                    media_sequence=COALESCE(excluded.media_sequence, variants.media_sequence),
                    expected_segments=COALESCE(excluded.expected_segments, variants.expected_segments),
                    status=CASE WHEN excluded.status != '' THEN excluded.status ELSE variants.status END,
                    updated_at=excluded.updated_at
                """,
                (
                    variant_id, work_id, resolution, bandwidth, codecs, playlist_url, playlist_type,
                    selected_value, media_sequence, expected_segments, status, stamp, stamp, selected,
                ),
            )
            if selected:
                connection.execute("UPDATE works SET primary_variant_id=?, updated_at=? WHERE id=?", (variant_id, stamp, work_id))
        return variant_id

    def record_subtitle(
        self,
        work_id: str,
        *,
        language: str = "und",
        label: str = "",
        format: str = "",
        source_url: str = "",
        output_path: str = "",
        status: str = "detected",
    ) -> str:
        identity = f"{work_id}\0{language}\0{label}\0{source_url or output_path}".encode("utf-8")
        subtitle_id = f"subtitle_{hashlib.sha256(identity).hexdigest()[:20]}"
        stamp = unix_time()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO subtitles(id, work_id, language, label, format, source_url, output_path, status, created_at, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    format=CASE WHEN excluded.format != '' THEN excluded.format ELSE subtitles.format END,
                    output_path=CASE WHEN excluded.output_path != '' THEN excluded.output_path ELSE subtitles.output_path END,
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                (subtitle_id, work_id, language or "und", label, format, source_url, output_path, status, stamp, stamp),
            )
        return subtitle_id

    def record_segment(
        self,
        variant_id: str,
        sequence: int,
        *,
        source_url: str = "",
        byte_range: str = "",
        duration: float | None = None,
        start_seconds: float | None = None,
        end_seconds: float | None = None,
        local_path: str = "",
        expected_bytes: int | None = None,
        actual_bytes: int | None = None,
        status: str = "pending",
        increment_attempts: bool = False,
        last_error: str = "",
        refresh_metrics: bool = True,
    ) -> None:
        fingerprint = segment_fingerprint(source_url or local_path, byte_range)
        stamp = unix_time()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO segments(
                    variant_id, sequence, uri_fingerprint, source_url, byte_range, duration,
                    start_seconds, end_seconds, local_path, expected_bytes, actual_bytes,
                    status, attempts, last_error, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(variant_id, sequence, uri_fingerprint) DO UPDATE SET
                    source_url=CASE WHEN excluded.source_url != '' THEN excluded.source_url ELSE segments.source_url END,
                    duration=COALESCE(excluded.duration, segments.duration),
                    start_seconds=COALESCE(excluded.start_seconds, segments.start_seconds),
                    end_seconds=COALESCE(excluded.end_seconds, segments.end_seconds),
                    local_path=CASE WHEN excluded.local_path != '' THEN excluded.local_path ELSE segments.local_path END,
                    expected_bytes=COALESCE(excluded.expected_bytes, segments.expected_bytes),
                    actual_bytes=COALESCE(excluded.actual_bytes, segments.actual_bytes),
                    status=excluded.status,
                    attempts=segments.attempts + excluded.attempts,
                    last_error=excluded.last_error,
                    updated_at=excluded.updated_at
                """,
                (
                    variant_id, int(sequence), fingerprint, source_url, byte_range, duration,
                    start_seconds, end_seconds, local_path, expected_bytes, actual_bytes,
                    status, 1 if increment_attempts else 0, last_error, stamp,
                ),
            )
            if refresh_metrics:
                self._refresh_variant_metrics(connection, variant_id)

    def register_segments(self, variant_id: str, segments: list[dict[str, Any]]) -> None:
        """Register playlist entries in one transaction without changing saved rows."""
        stamp = unix_time()
        rows = []
        for item in segments:
            source_url = str(item.get("source_url") or "")
            byte_range = str(item.get("byte_range") or "")
            rows.append(
                (
                    variant_id,
                    int(item["sequence"]),
                    segment_fingerprint(source_url, byte_range),
                    source_url,
                    byte_range,
                    item.get("duration"),
                    item.get("start_seconds"),
                    item.get("end_seconds"),
                    str(item.get("local_path") or ""),
                    item.get("expected_bytes"),
                    stamp,
                )
            )
        with self.transaction() as connection:
            connection.executemany(
                """
                INSERT INTO segments(
                    variant_id, sequence, uri_fingerprint, source_url, byte_range, duration,
                    start_seconds, end_seconds, local_path, expected_bytes, status, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                ON CONFLICT(variant_id, sequence, uri_fingerprint) DO UPDATE SET
                    source_url=excluded.source_url,
                    duration=COALESCE(excluded.duration, segments.duration),
                    start_seconds=COALESCE(excluded.start_seconds, segments.start_seconds),
                    end_seconds=COALESCE(excluded.end_seconds, segments.end_seconds),
                    local_path=CASE WHEN excluded.local_path != '' THEN excluded.local_path ELSE segments.local_path END,
                    expected_bytes=COALESCE(excluded.expected_bytes, segments.expected_bytes),
                    status=CASE WHEN segments.status='saved' THEN segments.status ELSE 'pending' END,
                    updated_at=excluded.updated_at
                """,
                rows,
            )

    def refresh_variant_metrics(self, variant_id: str) -> VariantMetrics:
        with self.transaction() as connection:
            return self._refresh_variant_metrics(connection, variant_id)

    def _refresh_variant_metrics(self, connection: sqlite3.Connection, variant_id: str) -> VariantMetrics:
        rows = connection.execute(
            "SELECT sequence, MAX(COALESCE(actual_bytes, 0)) AS actual_bytes FROM segments "
            "WHERE variant_id=? AND status='saved' GROUP BY sequence ORDER BY sequence",
            (variant_id,),
        ).fetchall()
        sequences = [int(row["sequence"]) for row in rows]
        saved_bytes = sum(int(row["actual_bytes"] or 0) for row in rows)
        first = sequences[0] if sequences else None
        last = sequences[-1] if sequences else None
        variant = connection.execute(
            "SELECT expected_segments FROM variants WHERE id=?",
            (variant_id,),
        ).fetchone()
        expected_segments = int(variant["expected_segments"]) if variant and variant["expected_segments"] is not None else None
        if expected_segments is not None:
            missing = max(expected_segments - len(sequences), 0)
        else:
            missing = sum(item["count"] for item in missing_ranges(sequences, first, last)) if sequences else None
        metrics = VariantMetrics(len(sequences), saved_bytes, first, last, missing)
        connection.execute(
            """
            UPDATE variants SET saved_segments=?, saved_bytes=?, first_sequence=?, last_sequence=?,
                disk_missing=?, updated_at=? WHERE id=?
            """,
            (metrics.saved_segments, metrics.saved_bytes, first, last, missing, unix_time(), variant_id),
        )
        return metrics

    def reconcile_variant_directory(
        self,
        *,
        site: str,
        product_id: str,
        resolution: str,
        folder: Path,
        min_segment_bytes: int = 188,
    ) -> dict[str, Any]:
        work_id = self.ensure_work(site, product_id, status="indexed")
        variant_id = self.ensure_variant(work_id, resolution, status="indexed")
        stamp = unix_time()
        records: list[tuple[Any, ...]] = []
        if folder.exists():
            for path in folder.glob("*.ts"):
                sequence = sequence_from_filename(path)
                if sequence is None:
                    continue
                size = path.stat().st_size
                status = "saved" if size >= min_segment_bytes else "invalid"
                fingerprint = segment_fingerprint(str(path))
                records.append(
                    (variant_id, sequence, fingerprint, "", "", str(path), size, status, stamp)
                )
        with self.transaction() as connection:
            connection.executemany(
                """
                INSERT INTO segments(
                    variant_id, sequence, uri_fingerprint, source_url, byte_range,
                    local_path, actual_bytes, status, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(variant_id, sequence, uri_fingerprint) DO UPDATE SET
                    local_path=excluded.local_path,
                    actual_bytes=excluded.actual_bytes,
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                records,
            )
            metrics = self._refresh_variant_metrics(connection, variant_id)
        return {
            "work_id": work_id,
            "variant_id": variant_id,
            "resolution": resolution,
            "saved_segments": metrics.saved_segments,
            "saved_bytes": metrics.saved_bytes,
            "first_sequence": metrics.first_sequence,
            "last_sequence": metrics.last_sequence,
            "disk_missing": metrics.disk_missing,
        }

    def create_session(
        self,
        session_id: str,
        work_id: str,
        *,
        selected_variant_ids: list[str],
        mode: str,
        status: str = "queued",
    ) -> str:
        if mode not in {"direct", "browser-assisted", "hybrid"}:
            raise ValueError("mode must be direct, browser-assisted, or hybrid")
        stamp = unix_time()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO download_sessions(
                    id, work_id, selected_variant_ids, mode, status, created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    selected_variant_ids=excluded.selected_variant_ids,
                    mode=excluded.mode,
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                (session_id, work_id, json.dumps(selected_variant_ids), mode, status, stamp, stamp),
            )
        return session_id

    def update_session(self, session_id: str, **updates: Any) -> None:
        allowed = {"status", "progress", "last_progress_at", "pause_reason", "resumable", "mode"}
        values = {key: value for key, value in updates.items() if key in allowed}
        if not values:
            return
        values["updated_at"] = unix_time()
        assignments = ", ".join(f"{key}=?" for key in values)
        with self.transaction() as connection:
            connection.execute(
                f"UPDATE download_sessions SET {assignments} WHERE id=?",
                (*values.values(), session_id),
            )

    def resumable_segments(self, variant_id: str) -> list[dict[str, Any]]:
        with self.lock:
            rows = self.connection.execute(
                "SELECT * FROM segments WHERE variant_id=? AND status != 'saved' ORDER BY sequence",
                (variant_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_works(self) -> list[dict[str, Any]]:
        with self.lock:
            work_rows = self.connection.execute("SELECT * FROM works ORDER BY updated_at DESC").fetchall()
            variant_rows = self.connection.execute("SELECT * FROM variants ORDER BY resolution").fetchall()
            metric_rows = self.connection.execute(
                """
                SELECT variant_id, COUNT(*) AS saved_segments,
                    SUM(actual_bytes) AS saved_bytes,
                    MIN(sequence) AS first_sequence,
                    MAX(sequence) AS last_sequence
                FROM (
                    SELECT variant_id, sequence, MAX(COALESCE(actual_bytes, 0)) AS actual_bytes
                    FROM segments WHERE status='saved'
                    GROUP BY variant_id, sequence
                )
                GROUP BY variant_id
                """
            ).fetchall()
            subtitle_rows = self.connection.execute("SELECT * FROM subtitles ORDER BY language, label").fetchall()
            session_rows = self.connection.execute(
                "SELECT * FROM download_sessions ORDER BY updated_at DESC"
            ).fetchall()
        metrics_by_variant = {str(row["variant_id"]): dict(row) for row in metric_rows}
        variants_by_work: dict[str, list[dict[str, Any]]] = {}
        for row in variant_rows:
            item = dict(row)
            metrics = metrics_by_variant.get(str(row["id"]))
            if metrics:
                first = int(metrics["first_sequence"])
                last = int(metrics["last_sequence"])
                saved_segments = int(metrics["saved_segments"])
                item.update(
                    {
                        "saved_segments": saved_segments,
                        "saved_bytes": int(metrics["saved_bytes"] or 0),
                        "first_sequence": first,
                        "last_sequence": last,
                        "disk_missing": (
                            max(int(item["expected_segments"]) - saved_segments, 0)
                            if item.get("expected_segments") is not None
                            else max(last - first + 1 - saved_segments, 0)
                        ),
                    }
                )
            elif item.get("expected_segments") is not None:
                item["disk_missing"] = int(item["expected_segments"])
            variants_by_work.setdefault(str(row["work_id"]), []).append(item)
        subtitles_by_work: dict[str, list[dict[str, Any]]] = {}
        for row in subtitle_rows:
            subtitles_by_work.setdefault(str(row["work_id"]), []).append(dict(row))
        sessions_by_work: dict[str, list[dict[str, Any]]] = {}
        for row in session_rows:
            item = dict(row)
            item["selected_variant_ids"] = json.loads(item.get("selected_variant_ids") or "[]")
            sessions_by_work.setdefault(str(row["work_id"]), []).append(item)

        result: list[dict[str, Any]] = []
        for row in work_rows:
            item = dict(row)
            variants = variants_by_work.get(str(row["id"]), [])
            sessions = sessions_by_work.get(str(row["id"]), [])
            primary = next((variant for variant in variants if variant["id"] == row["primary_variant_id"]), None)
            if primary is None and variants:
                primary = max(variants, key=lambda variant: int(variant.get("saved_bytes") or 0))
            latest_session = sessions[0] if sessions else None
            item.update(
                {
                    "variants": variants,
                    "subtitles": subtitles_by_work.get(str(row["id"]), []),
                    "sessions": sessions,
                    "primary_variant": primary,
                    "saved_bytes": sum(int(variant.get("saved_bytes") or 0) for variant in variants),
                    "recommended_action": recommended_action(
                        session_status=str((latest_session or {}).get("status") or ""),
                        disk_missing=(primary or {}).get("disk_missing"),
                        saved_segments=int((primary or {}).get("saved_segments") or 0),
                        has_output=False,
                    ),
                }
            )
            result.append(item)
        return result

    def get_work(self, work_id: str) -> dict[str, Any] | None:
        return next((item for item in self.list_works() if item["id"] == work_id), None)
