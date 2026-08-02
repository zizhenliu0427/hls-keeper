from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import time
import types
import unittest


try:
    import requests  # noqa: F401
except ModuleNotFoundError:
    requests_stub = types.ModuleType("requests")

    class PlaceholderSession:
        pass

    requests_stub.Session = PlaceholderSession
    requests_stub.Response = object
    sys.modules["requests"] = requests_stub

from hls_keeper.server import CaptureStore


class FakeResponse:
    def __init__(self, body: bytes, status_code: int = 200):
        self.content = body
        self.status_code = status_code
        self.text = body.decode("utf-8", errors="replace")


class FakeSession:
    PLAYLIST = b"""#EXTM3U
#EXT-X-MEDIA-SEQUENCE:40
#EXTINF:2.5,
part40.ts
#EXTINF:3.0,
part41.ts
#EXT-X-ENDLIST
"""

    def get(self, url: str, **_kwargs: object) -> FakeResponse:
        if url.endswith(".m3u8"):
            return FakeResponse(self.PLAYLIST)
        if url.endswith(".ts"):
            return FakeResponse((url.rsplit("/", 1)[-1].encode("ascii") + b"-") * 50)
        return FakeResponse(b"", 404)


class FlakySession(FakeSession):
    def __init__(self) -> None:
        self.calls: dict[str, int] = {}

    def get(self, url: str, **kwargs: object) -> FakeResponse:
        self.calls[url] = self.calls.get(url, 0) + 1
        if url.endswith("part41.ts") and self.calls[url] > 1:
            return FakeResponse(b"temporarily unavailable", 503)
        return super().get(url, **kwargs)


class ServerLedgerIntegrationTests(unittest.TestCase):
    def make_store(self, root: Path) -> CaptureStore:
        return CaptureStore(
            data_dir=root / "data",
            output_dir=root / "outputs",
            archive_dir=root / "archives",
            ffmpeg="missing-ffmpeg",
            workers=2,
            burst_ahead=0,
            backfill=0,
            min_segment_bytes=188,
            auto_retry_seconds=0,
        )

    def close_store(self, store: CaptureStore) -> None:
        store.stop_event.set()
        store.executor.shutdown(wait=True, cancel_futures=True)
        store.ledger.close()

    def test_direct_download_persists_a_resumable_work_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = self.make_store(root)
            store.session = FakeSession()
            try:
                store.run_direct_download(
                    "job_test",
                    "https://media.example/video/index.m3u8",
                    {},
                    "video-42",
                    "1280x720",
                    "",
                    True,
                    2,
                    0,
                    "none",
                )

                self.assertEqual("complete", store.state["jobs"]["job_test"]["status"])
                works = store.list_works()
                self.assertEqual(1, len(works))
                self.assertEqual("video-42", works[0]["product_id"])
                self.assertEqual(2, works[0]["primary_variant"]["saved_segments"])
                self.assertEqual("direct", works[0]["sessions"][0]["mode"])
                self.assertEqual("complete", works[0]["sessions"][0]["status"])
                self.assertEqual(
                    [40, 41],
                    [
                        item["sequence"]
                        for item in store.ledger.connection.execute(
                            "SELECT sequence FROM segments ORDER BY sequence"
                        ).fetchall()
                    ],
                )
            finally:
                self.close_store(store)

    def test_direct_download_marks_failed_segment_for_resume(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = self.make_store(Path(temp))
            store.session = FlakySession()
            try:
                store.run_direct_download(
                    "job_flaky",
                    "https://media.example/video/index.m3u8",
                    {},
                    "video-43",
                    "1280x720",
                    "",
                    True,
                    2,
                    0,
                    "none",
                )

                work = store.list_works()[0]
                self.assertEqual("warning", store.state["jobs"]["job_flaky"]["status"])
                self.assertEqual(1, work["primary_variant"]["saved_segments"])
                self.assertEqual(1, work["primary_variant"]["disk_missing"])
                self.assertEqual("resume", work["recommended_action"])
                self.assertEqual(
                    [41],
                    [
                        item["sequence"]
                        for item in store.ledger.resumable_segments(work["primary_variant"]["id"])
                    ],
                )
            finally:
                self.close_store(store)

    def test_discovery_waits_for_browser_assisted_choice_before_capture(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            store = self.make_store(root)
            store.session = FakeSession()
            payload = {
                "url": "https://media.example/v/video-44/1280x720/v_000040.ts",
                "initiator": "https://watch.example/video-44",
                "tabId": 17,
                "requestHeaders": [{"name": "referer", "value": "https://watch.example/video-44"}],
            }
            try:
                status, message = store.record_candidate(payload)
                target = store.stream_dir("video-44", "1280x720") / "v_000040.ts"
                self.assertEqual((200, "candidate"), (status, message))
                self.assertFalse(target.exists())

                result = store.choose_candidate(
                    {
                        "product": "video-44",
                        "resolution": "1280x720",
                        "choice": "browser-assisted",
                    }
                )
                store.executor.shutdown(wait=True, cancel_futures=False)

                self.assertEqual("browser-assisted", result["choice"])
                self.assertTrue(target.exists())
                work = store.list_works()[0]
                self.assertEqual("browser-assisted", work["sessions"][0]["mode"])
                self.assertEqual(1, work["primary_variant"]["saved_segments"])
            finally:
                self.close_store(store)

    def test_interrupted_direct_job_resumes_and_skips_existing_segment(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            store = self.make_store(Path(temp))
            store.session = FakeSession()
            folder = store.stream_dir("video-45", "1280x720")
            folder.mkdir(parents=True)
            (folder / "part40.ts").write_bytes(b"existing" * 40)
            store.state.setdefault("jobs", {})["job_restart"] = {
                "id": "job_restart",
                "type": "direct-download",
                "status": "downloading",
                "url": "https://media.example/video/index.m3u8",
                "product": "video-45",
                "resolution": "1280x720",
                "preferred_resolution": "",
                "quality_fallback": True,
                "subtitle_convert_mode": "none",
                "workers": 2,
                "request_delay_ms": 0,
                "created_at": 1,
            }
            try:
                store._resume_interrupted_direct_jobs()
                deadline = time.time() + 3
                while time.time() < deadline and store.state["jobs"]["job_restart"]["status"] not in {"complete", "warning", "failed"}:
                    time.sleep(0.01)

                job = store.state["jobs"]["job_restart"]
                self.assertEqual("complete", job["status"])
                self.assertEqual(1, job["skipped_existing"])
                self.assertEqual(1, job["saved"])
                self.assertEqual(2, store.list_works()[0]["primary_variant"]["saved_segments"])
            finally:
                self.close_store(store)


if __name__ == "__main__":
    unittest.main()
