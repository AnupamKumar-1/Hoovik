
from feat import Detector
import cv2, numpy as np
from pathlib import Path

d = Detector(device="cpu")
test_file = next(Path("data/").rglob("*.mp4"))
cap = cv2.VideoCapture(str(test_file))
ret, frame = cap.read()
cap.release()

frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
import tempfile, os
with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
    cv2.imwrite(tmp.name, cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR))
    tmp_path = tmp.name

result = d.detect_image(tmp_path)
os.remove(tmp_path)

aus   = result.aus.values[0]
emots = result.emotions.values[0]
emb   = np.concatenate([aus, emots])

print("AU cols:",    list(result.aus.columns))
print("Emot cols:", list(result.emotions.columns))
print("AU dim:",    len(aus))
print("Emot dim:",  len(emots))
print("Total FACE_DIM:", len(emb))