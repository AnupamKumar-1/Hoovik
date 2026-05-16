import logging
import shutil
import subprocess


logger = logging.getLogger(__name__)


def ensure_ffmpeg_available() -> None:
    """Verify that the ``ffmpeg`` executable is installed and on ``PATH``.

    Intended to be called during service startup so a missing dependency
    fails fast with a clear message instead of surfacing later during the
    first audio conversion request.

    Raises:
        RuntimeError: If ``ffmpeg`` cannot be located on ``PATH``.
    """
    if shutil.which("ffmpeg") is None:
        message = (
            "ffmpeg executable not found on PATH. "
            "transcript_service requires ffmpeg for audio conversion; "
            "install it (e.g. `apt-get install -y ffmpeg`) and restart the service."
        )
        logger.error(message)
        raise RuntimeError(message)


def convert_to_wav(src_path: str, dst_path: str) -> None:
    """Convert an audio file to mono 16 kHz WAV using ffmpeg.

    Overwrites ``dst_path`` if it already exists. Video streams are
    stripped (``-vn``). Raises ``subprocess.CalledProcessError`` on a
    non-zero ffmpeg exit code. stdout and stderr are captured and not
    forwarded.

    Args:
        src_path: Path to the source audio file (any ffmpeg-supported format).
        dst_path: Path where the converted WAV file will be written.
    """
    subprocess.run(
        ["ffmpeg", "-y", "-i", src_path, "-ac", "1", "-ar", "16000", "-vn", dst_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
