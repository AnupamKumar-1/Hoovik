# SkymeetAI - Emotion Service


A real-time multimodal emotion recognition system built for deployment in video conferencing environments. Combines facial action unit analysis and speech-based audio embeddings through a hybrid deep learning + gradient boosting ensemble, served via FastAPI with Socket.IO support.

---

## Overview

Most emotion recognition systems work on a single modality — either video or audio. This service processes both simultaneously and fuses predictions from two independently trained models: a Transformer that captures temporal patterns across a sequence of frames, and an XGBoost classifier trained on aggregated statistical features. An Isolation Forest anomaly detector gates inference at runtime to reject noisy or malformed inputs before they reach the models.

The system is designed to run alongside a WebRTC video call, receiving frame and audio data from participants in real time and returning per-participant emotion predictions back to the host.

---

## Architecture


```mermaid
flowchart TD

A[Video Frames (streamed)]
    --> B[Frame Buffer (deque, sliding window)]
    --> C[Face Processing (fast_face)]

C --> D1[Face sequence (xf)]
C --> D2[Face mask (fm)]
C --> D3[Audio placeholder (xa = zeros)]
C --> D4[Audio mask (am = zeros)]

D1 --> E[EmotionPredictor.predict]
D2 --> E
D3 --> E
D4 --> E

%% Split into two paths
E --> F1[build_anomaly_features]
E --> F2[Transformer (sequence model)]

%% PATH 1
F1 --> G[Aggregated vector (X)]
G --> H[Scaler.transform]

H --> I1[Isolation Forest]
H --> I2[XGBoost]

I1 --> J1[Anomaly score + flag]
I2 --> J2[XGB probabilities]

%% PATH 2
F2 --> K[Transformer probabilities]

%% Merge
J2 --> L[EmotionEnsemble Fusion]
K --> L

%% Output
L --> M[Final Output]

J1 --> M

M --> N[Emotion label]
M --> O[Confidence]
M --> P[Probability distribution]
M --> Q[Anomaly flag + score]
M --> R[Latency]
```
---

## Emotion Classes

| Index | Label    | RAVDESS Code |
|-------|----------|-------------|
| 0     | Angry    | 05          |
| 1     | Disgust  | 07          |
| 2     | Fearful  | 06          |
| 3     | Happy    | 03          |
| 4     | Sad      | 04          |
| 5     | Neutral  | 01 (Neutral), 02 (Calm) |

> Note: RAVDESS classes "Neutral" (01) and "Calm" (02) are merged into a single "Neutral" class due to high similarity in expression and to improve class balance.

---

## Project Structure

```
emotion_service/
├── config/
│   └── config.json

├── embeddings/
│   └── extract_embeddings_data.py

├── extracted_dataset/
│   ├── dataset.npz
│   ├── norm_stats/
│   └── sample/

├── training/
│   ├── train_modal.py              # Transformer training
│   └── train_xgb.py                # XGBoost training

├── anomaly/
│   └── train_anomaly.py            # Isolation Forest training

├── inference/
│   ├── ensemble.py                 # Fusion logic
│   ├── predict.py                  # Main inference pipeline
│   └── calibrate_ensemble.py       # Weight tuning

├── inspect/
│   └── inspect_embeddings.py

├── models/
│   ├── modal/
│   │   └── best_modal.pt           # Transformer model
│   │
│   ├── xgb/
│   │   ├── xgb_model.joblib        # Trained XGBoost
│   │   ├── scaler.joblib           # Feature scaler
│   │   ├── pca.joblib              # (optional PCA)
│   │   └── best_xgb.json           # Config / params
│   │
│   ├── anomaly/
│   │   ├── iso_forest.joblib       # Isolation Forest
│   │   ├── scaler.joblib
│   │   └── meta.json               # Threshold
│   │
│   └── ensemble/
│       └── weights.json            # Fusion weights

├── logs/
│   ├── train_modal.log
│   ├── train_xgb.log
│   ├── train_anomaly.log
│   ├── confusion_xgb.png
│   ├── feature_importance_xgb.png
│   └── anomaly_scores.png

├── test_embeddings/
├── test_videos/

├── app.py                          # FastAPI server
├── create_sample.py

├── test_audio.py
├── test_speed.py

├── requirements.txt
└── README.md
```

---

## Models

### Transformer (EmotionTransformer)

- Dual-stream architecture with separate projections for **face (27-dim AU features)** and **audio (1024-dim embeddings)**, fused along the feature dimension  
- Learns **temporal dynamics** across a fixed-length sequence (`SEQ_LEN`) using a **6-layer Transformer encoder (8 attention heads)**  
- Incorporates **gated modality projection (sigmoid gating)** to suppress unreliable inputs (e.g., missing face/audio)  
- Uses **attention-weighted pooling** instead of naive averaging to focus on informative frames  
- Trained with:
  - Cosine annealing scheduler with warmup  
  - Class-weighted cross-entropy loss  
  - Early stopping based on validation loss  

---

### XGBoost

- Operates on **aggregated statistical features**, not raw sequences  
- Feature vector includes:
  - Mean, standard deviation, min, max  
  - Temporal delta (last − first valid frame)  
  - Modality presence indicators (face/audio masks)  
- Pipeline:
  - `StandardScaler` for normalization  
  - Optional `PCA` for dimensionality reduction  
- Uses **class-balanced sample weights** to address dataset imbalance  
- Provides robust predictions when temporal modeling is weak or noisy  


### Ensemble

- Weighted average of Transformer softmax probabilities and XGBoost `predict_proba`
- Weights calibrated via grid search on the validation set
- Single-modality fallback weights (heuristic) when one modality is missing

### Anomaly Detector

- Isolation Forest trained on the same aggregated features as XGBoost
- Decision score threshold set at a fixed percentile on the training set
- Anomalies are flagged in the response but inference still runs — the caller decides how to handle it

---

## Data Pipeline

Training uses the [RAVDESS dataset](https://zenodo.org/record/1188976) (Ryerson Audio-Visual Database of Emotional Speech and Song).

**Extraction steps:**

1. Uniformly sample `SEQ_LEN` frames per clip
2. Extract face features via py-feat (AU intensities + emotion probabilities)
3. Extract audio embeddings via Wav2Vec2 (mean-pooled hidden states, L2-normalised)
4. Save intermediate chunks to allow resuming after interruption
5. Merge chunks and split by actor (70 / 15 / 15) to prevent data leakage

Actor-based splitting is critical — random splitting would allow the model to memorise speaker identity rather than learn emotion.

---

## API

### Socket.IO — real-time inference

Connect to the server and emit frames as binary data:

```js
socket.emit("frame", { frame: frameBytes });
socket.on("emotion.result", (data) => {
  console.log(data.result); // { emotion, confidence }
});
```

### HTTP — `/analyze`

For batch or HTTP-based clients:

```bash
curl -X POST http://localhost:8000/analyze \
  -F "meeting_id=room123" \
  -F "participant_id=user456" \
  -F "type=frame" \
  -F "file=@frame.jpg"
```

**Response:**

### Response

```json
{
  "meeting_id": "room123",
  "participant_id": "user456",
  "result": {
    "emotion": "happy",
    "confidence": 0.82,
    "probs": {
      "angry": 0.03,
      "disgust": 0.01,
      "fearful": 0.02,
      "happy": 0.82,
      "sad": 0.05,
      "neutral": 0.07
    }
  }
}
```

### Inference response schema

```json
{
  "emotion": "happy",
  "confidence": 0.82,
  "modality": "both",
  "probs": {
    "happy": 0.82,
    "neutral": 0.07
  },
  "latency_ms": 42.3,
  "anomaly": false,
  "anomaly_score": 0.12,
  "status": "ok",
  "error": null
}
```

- **modality** — indicates which input modalities were available during inference  
  Possible values:
  - `both` — both face and audio features present  
  - `audio_only` — only audio available  
  - `video_only` — only face/video available  
  - `none` — no valid input detected  
---

## Setup

### Requirements

```bash
pip install -r requirements.txt
```

Key dependencies: `torch`, `torchvision`, `torchaudio`, `transformers`, `xgboost`, `scikit-learn`, `py-feat`, `fastapi`, `uvicorn`, `python-socketio`, `librosa`, `soundfile`, `soxr`, `opencv-python-headless`, `joblib`, `apscheduler`

### Config

All paths and hyperparameters are in `config/config.json`. Set your dataset root, model output paths, and training parameters there before running anything.

### Training from Scratch

```bash
# 1. Extract features from RAVDESS
python embeddings/extract_embeddings_data.py

# 2. Verify the dataset before training
python inspect/inspect_embeddings.py

# 3. Train the Transformer (temporal model)
python training/train_modal.py

# 4. Train XGBoost (statistical model)
python training/train_xgb.py

# 5. Train Anomaly Detector (Isolation Forest)
python anomaly/train_anomaly.py

# 6. Calibrate ensemble weights on validation set
python inference/calibrate_ensemble.py

# 7. Start the server
uvicorn app:app --host 0.0.0.0 --port 8000

# Create a test sample (generates xf, xa, fm, am)
python create_sample.py

# Run inference
python inference/predict.py \
  --face xf.npy \
  --audio xa.npy \
  --face_mask fm.npy \
  --audio_mask am.npy

```
---

## Design Decisions

### Why use two models instead of one?
The system combines a Transformer and XGBoost because they capture **complementary aspects** of the data:

- The **Transformer** models temporal dynamics — how facial expressions and audio evolve over time.
- **XGBoost** operates on aggregated statistical features, capturing the overall distribution without relying on sequence order.

Since both models make different types of errors, combining them via an ensemble improves overall robustness and generalisation.

---

### Why actor-based splitting?
RAVDESS contains recordings from 24 actors. A random train-test split can leak actor identity into both sets, allowing the model to overfit to speaker-specific traits.

To prevent this:
- Data is split **by actor (70 / 15 / 15)**  
- Ensures the model is evaluated on **unseen speakers**

This provides a more realistic measure of real-world performance.

---

### Why anomaly-aware inference instead of filtering?
In real-time systems (e.g., video calls), inputs can be noisy or corrupted:
- Low lighting or missing faces  
- Audio dropouts or background noise  
- Network artifacts  

Instead of blocking inference, the system:
- Uses an **Isolation Forest** to detect anomalies  
- Outputs an **anomaly score + flag alongside predictions**

This keeps the system responsive while allowing downstream applications to decide how to handle unreliable inputs.

---

### Why merge Neutral and Calm?
RAVDESS defines separate classes for *Neutral (01)* and *Calm (02)*, but:

- They are **visually and acoustically very similar**
- Distinguishing them is often ambiguous, even for humans
- Keeping them separate introduces class imbalance

Merging them into a single **Neutral** class:
- Improves class balance  
- Simplifies the learning problem  
- Leads to more stable and reliable predictions

---

## Limitations

- **CPU-bound inference by default**  
  The system runs on CPU unless explicitly configured for GPU or Apple MPS. This can increase latency for longer sequences or high-throughput scenarios.

- **Dataset-specific calibration**  
  Ensemble weights are calibrated on RAVDESS validation actors. Performance may degrade on out-of-domain speakers, languages, or recording conditions.

- **Heuristic single-modality fallback**  
  When one modality (face or audio) is missing, fallback weights are applied heuristically rather than being separately calibrated.

- **In-memory buffering for streaming**  
  The HTTP and Socket.IO endpoints maintain per-participant frame buffers in memory. This may not scale well for large numbers of concurrent users and should be replaced with a shared or distributed cache in production.

- **Limited real-time audio integration**  
  In the current real-time pipeline, audio features are replaced with zero vectors, effectively making inference video-only. Full audio integration would improve multimodal performance.

- **Dependency on face detection quality**  
  If face detection fails (e.g., occlusion, poor lighting), the system cannot extract valid features, which may lead to degraded or skipped predictions.

  ---

## License

MIT
