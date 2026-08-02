from __future__ import annotations

import unittest

from hls_keeper.works import (
    canonical_site,
    missing_ranges,
    recommended_action,
    segment_fingerprint,
    stable_variant_id,
    stable_work_id,
)


class WorkModelTests(unittest.TestCase):
    def test_ids_are_stable_and_variants_share_a_work(self) -> None:
        work_id = stable_work_id("example.com", "video-7")
        self.assertEqual(work_id, stable_work_id("EXAMPLE.COM", "video-7"))
        self.assertNotEqual(
            stable_variant_id(work_id, "1920x1080"),
            stable_variant_id(work_id, "1280x720"),
        )

    def test_site_and_segment_identity_ignore_ephemeral_url_parts(self) -> None:
        first = "https://cdn.example.com:8443/video/10.ts?token=one#part"
        second = "https://cdn.example.com:8443/video/10.ts?token=two"
        self.assertEqual(canonical_site(first), "cdn.example.com")
        self.assertEqual(segment_fingerprint(first), segment_fingerprint(second))

    def test_missing_ranges_are_compact(self) -> None:
        self.assertEqual(
            missing_ranges([10, 11, 14, 17], 10, 18),
            [
                {"from": 12, "to": 13, "count": 2},
                {"from": 15, "to": 16, "count": 2},
                {"from": 18, "to": 18, "count": 1},
            ],
        )

    def test_recommended_action_prefers_resume_for_failed_session(self) -> None:
        self.assertEqual(
            recommended_action(session_status="failed", disk_missing=3, saved_segments=10),
            "resume",
        )


if __name__ == "__main__":
    unittest.main()
