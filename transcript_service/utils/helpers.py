import os
import threading


def allowed_file(filename: str, allowed_ext: set) -> bool:
    """Check whether a filename has a permitted extension.

    Splits on the last ``.`` and tests the suffix against ``allowed_ext``
    case-insensitively.

    Args:
        filename: Original filename string, including extension.
        allowed_ext: Set of lowercase extension strings without leading dots
            (e.g. ``{"wav", "mp3", "webm"}``).

    Returns:
        ``True`` if the file extension is in ``allowed_ext``, else ``False``.
    """
    return filename.rsplit(".", 1)[-1].lower() in allowed_ext


def clean_speaker(name: str) -> str:
    """Return a sanitised speaker display name.

    Substitutes ``"Guest"`` when ``name`` is falsy, ``"unknown"``, or
    ``"undefined"`` (case-insensitive). Otherwise returns the name unchanged.

    Args:
        name: Raw speaker name from the request speaker map.

    Returns:
        Sanitised display name string.
    """
    if not name or name.lower() in ["unknown", "undefined"]:
        return "Guest"
    return name


def schedule_file_cleanup(paths: list[str], delay: float) -> None:
    """Schedule a list of files for deletion after a delay.

    Launches a daemon ``threading.Timer`` that iterates ``paths`` and
    removes each file if it exists. Per-file errors are logged to stdout
    and do not interrupt deletion of remaining files. The daemon flag
    ensures the timer does not prevent process exit.

    Args:
        paths: List of absolute or relative file paths to delete.
        delay: Seconds to wait before deletion begins.
    """

    def cleanup():
        for p in paths:
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception as e:
                print(f"helpers: file cleanup failed for {p} — {e}")

    t = threading.Timer(delay, cleanup)
    t.daemon = True
    t.start()
