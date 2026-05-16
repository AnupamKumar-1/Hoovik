"""Focused tests for the ffmpeg availability check in ``utils.audio``.

Run from the ``transcript_service`` directory::

    python -m unittest tests.test_audio
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from utils.audio import ensure_ffmpeg_available


class EnsureFfmpegAvailableTests(unittest.TestCase):
    def test_returns_none_when_ffmpeg_on_path(self):
        with mock.patch("utils.audio.shutil.which", return_value="/usr/bin/ffmpeg"):
            self.assertIsNone(ensure_ffmpeg_available())

    def test_raises_runtime_error_when_ffmpeg_missing(self):
        with mock.patch("utils.audio.shutil.which", return_value=None):
            with self.assertRaises(RuntimeError) as ctx:
                ensure_ffmpeg_available()
        self.assertIn("ffmpeg", str(ctx.exception).lower())
        self.assertIn("path", str(ctx.exception).lower())


if __name__ == "__main__":
    unittest.main()
