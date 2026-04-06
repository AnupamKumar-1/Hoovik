import time
from pathlib import Path
from embeddings.extract_embeddings_data import load_models, process_video, DATA_ROOT

load_models()

files = list(Path(DATA_ROOT).rglob("*.mp4"))[:3]

for f in files:
    start = time.time()
    result = process_video(f, 0, 1)
    elapsed = time.time() - start

    face_sum = result[3].sum() if (result and result[3] is not None) else 0

    print(f"{f.name} | {elapsed:.1f}s | face_mask_sum={face_sum}")
