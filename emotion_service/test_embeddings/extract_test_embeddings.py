import os
import sys
import subprocess
import tempfile
import numpy as np
from pathlib import Path
from tqdm import tqdm

# ===== PATH SETUP =====
BASE_DIR = Path(__file__).resolve().parent  # test_embeddings/
PROJECT_ROOT = BASE_DIR.parent  # emotion_service/
sys.path.insert(0, str(PROJECT_ROOT))

from embeddings.extract_embeddings_data import load_models, process_video

# ===== PATHS =====
INPUT_DIR = PROJECT_ROOT / "test_videos"  # ✅ correct input
OUTPUT_DIR = BASE_DIR  # ✅ current folder (test_embeddings)

os.makedirs(OUTPUT_DIR, exist_ok=True)


# ✅ FLV → MP4
def convert_flv_to_mp4(input_path: Path) -> Path:
    tmp_file = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    tmp_path = Path(tmp_file.name)
    tmp_file.close()

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        str(tmp_path),
    ]

    result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    if result.returncode != 0:
        print(f"❌ FFmpeg failed for {input_path.name}")
        return None

    return tmp_path


def main():
    print("🚀 Loading models...")
    load_models()

    files = list(INPUT_DIR.glob("*.*"))
    files = [f for f in files if f.suffix.lower() in [".mp4", ".wav", ".m4a", ".flv"]]

    if not files:
        raise RuntimeError(f"No test videos found in {INPUT_DIR}")

    print(f"🎥 Found {len(files)} files")

    for f in tqdm(files):
        temp_file = None

        try:
            input_file = f

            # 🔄 handle FLV
            if f.suffix.lower() == ".flv":
                print(f"🔄 Converting {f.name} → mp4")
                temp_file = convert_flv_to_mp4(f)

                if temp_file is None:
                    continue

                input_file = temp_file

            result = process_video(input_file, label=0, actor=0)

            if result is None:
                print(f"⚠️ Skipping {f.name}")
                continue

            face, audio, _, face_mask, audio_mask, _ = result
            name = f.stem

            np.save(OUTPUT_DIR / f"{name}_xf.npy", face)
            np.save(OUTPUT_DIR / f"{name}_xa.npy", audio)
            np.save(OUTPUT_DIR / f"{name}_fm.npy", face_mask)
            np.save(OUTPUT_DIR / f"{name}_am.npy", audio_mask)

        except Exception as e:
            print(f"❌ Error processing {f.name}: {e}")

        finally:
            if temp_file and temp_file.exists():
                os.remove(temp_file)

    print(f"✅ Done! Saved in: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
