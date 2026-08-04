from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


class DownloadPageSmokeTests(unittest.TestCase):
    def test_download_page_renders_all_main_states(self) -> None:
        """Load the real page scripts in a stub DOM and execute render() end to end.

        Contract tests only prove strings exist; this one executes the code, which is
        what catches load-order and temporal-dead-zone regressions that once shipped.
        """
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is not available")
        completed = subprocess.run(
            [node, str(ROOT / "tests" / "smoke_download_page.js")],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(0, completed.returncode, completed.stderr or completed.stdout)
        self.assertIn("SMOKE_OK", completed.stdout)


if __name__ == "__main__":
    unittest.main()
