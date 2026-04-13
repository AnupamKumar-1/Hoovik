

import subprocess


def convert_to_wav(src_path, dst_path):
    subprocess.run(
        ["ffmpeg", "-y", "-i", src_path, "-ac", "1", "-ar", "16000", "-vn", dst_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
