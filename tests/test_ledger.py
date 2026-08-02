from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from hls_keeper.ledger import DownloadLedger


class DownloadLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.db_path = self.root / "downloads.sqlite"
        self.ledger = DownloadLedger(self.db_path)

    def tearDown(self) -> None:
        self.ledger.close()
        self.temp_dir.cleanup()

    def test_variants_and_subtitles_are_grouped_under_one_work(self) -> None:
        work_id = self.ledger.ensure_work_for_url("video-1", "https://watch.example/video-1")
        high = self.ledger.ensure_variant(work_id, "1920x1080", selected=True)
        low = self.ledger.ensure_variant(work_id, "1280x720")
        self.ledger.record_subtitle(work_id, language="zh", format="vtt", source_url="https://watch.example/sub.vtt")

        work = self.ledger.get_work(work_id)
        self.assertIsNotNone(work)
        assert work is not None
        self.assertEqual({high, low}, {item["id"] for item in work["variants"]})
        self.assertEqual(high, work["primary_variant"]["id"])
        self.assertEqual(1, len(work["subtitles"]))

    def test_segment_progress_survives_restart_and_is_resumable(self) -> None:
        work_id = self.ledger.ensure_work("example.com", "video-2")
        variant_id = self.ledger.ensure_variant(work_id, "1920x1080", expected_segments=4)
        for sequence in (0, 1, 3):
            self.ledger.record_segment(
                variant_id,
                sequence,
                source_url=f"https://cdn.example/video/{sequence}.ts?token=short-lived",
                local_path=str(self.root / f"v_{sequence:06d}.ts"),
                actual_bytes=1000 + sequence,
                status="saved",
            )
        self.ledger.record_segment(
            variant_id,
            2,
            source_url="https://cdn.example/video/2.ts",
            status="retryable",
            increment_attempts=True,
            last_error="timeout",
        )

        self.assertEqual([2], [item["sequence"] for item in self.ledger.resumable_segments(variant_id)])
        before = self.ledger.get_work(work_id)
        assert before is not None
        self.assertEqual(3, before["primary_variant"]["saved_segments"])
        self.assertEqual(1, before["primary_variant"]["disk_missing"])

        self.ledger.close()
        self.ledger = DownloadLedger(self.db_path)
        after = self.ledger.get_work(work_id)
        assert after is not None
        self.assertEqual(3, after["primary_variant"]["saved_segments"])
        self.assertEqual("fill-gaps", after["recommended_action"])

    def test_lazy_directory_reconcile_does_not_modify_media(self) -> None:
        capture = self.root / "captures" / "video-3" / "1280x720"
        capture.mkdir(parents=True)
        files = {
            "v_000010.ts": b"a" * 200,
            "v_000012.ts": b"b" * 300,
            "v_000013.ts": b"x",
        }
        for name, content in files.items():
            (capture / name).write_bytes(content)

        result = self.ledger.reconcile_variant_directory(
            site="legacy-local",
            product_id="video-3",
            resolution="1280x720",
            folder=capture,
            min_segment_bytes=188,
        )

        self.assertEqual(2, result["saved_segments"])
        self.assertEqual(1, result["disk_missing"])
        self.assertEqual(files, {path.name: path.read_bytes() for path in capture.iterdir()})

    def test_duplicate_saved_records_for_one_sequence_are_not_double_counted(self) -> None:
        work_id = self.ledger.ensure_work("example.com", "video-4")
        variant_id = self.ledger.ensure_variant(work_id, "720p")
        self.ledger.record_segment(variant_id, 7, source_url="https://a.example/7.ts", actual_bytes=200, status="saved")
        self.ledger.record_segment(variant_id, 7, local_path=str(self.root / "7.ts"), actual_bytes=250, status="saved")
        work = self.ledger.get_work(work_id)
        assert work is not None
        self.assertEqual(1, work["primary_variant"]["saved_segments"])
        self.assertEqual(250, work["primary_variant"]["saved_bytes"])


if __name__ == "__main__":
    unittest.main()
