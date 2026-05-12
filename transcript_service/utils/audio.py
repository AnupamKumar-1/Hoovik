import subprocess


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
