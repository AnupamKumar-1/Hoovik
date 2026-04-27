# ML Pipeline

> SkyMeetAI runs two distinct ML pipelines: a **real-time video inference pipeline** during meetings, and a **batch ASR + NLP pipeline** triggered post-meeting for transcription. Both are fully self-hosted with no external AI API dependencies.

---

## Dataset

**RAVDESS** — 24 professional actors, 7,356 audio-video clips, 8 emotion classes.

- Neutral and calm merged into a single class (class 5)
- Surprised excluded due to ambiguous valence and underrepresentation
- Actor-based train/val/test split (70/15/15) to prevent data leakage across actors

Class distribution after merging: `angry(1128), fearful(576), disgust(1128), happy(1128), sad(1128), neutral/calm(1692)`

---

## Real-Time Inference Pipeline

Runs during an active meeting. Video frames are streamed from the host's browser to the Emotion Service over a persistent WebSocket. Inference always operates on the freshest available frame via an overwrite buffer — no queue buildup, O(1) memory per participant.

### Feature Extraction

**Face features (27-dim) via py-feat**

| Path | Features | Dimensions |
|------|----------|------------|
| Training (`extract_embeddings_data.py`) | 17 AU intensities + 7 basic emotion scores | 24 values in 27-dim array; last 3 (pose) zero-filled |
| Live inference (`app.py`) | 17 AU intensities + 7 basic emotion scores + 3 head pose angles (pitch, yaw, roll) | 27-dim |

Both paths use the same 27-dim array, ensuring train/inference consistency. Pose is zero-filled during batch extraction and populated during live inference when available.

**Audio features (1024-dim) via wav2vec2**

Model: `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim` (Wav2Vec2 large, fine-tuned on MSP-PODCAST).  
Audio is windowed around each sampled frame timestamp, passed through the model, and the last hidden state is mean-pooled then L2-normalized.

> Note: Audio features are used during training and batch inference. Real-time inference currently operates on video only due to latency constraints. Full multimodal real-time inference is a planned extension.

### Sequence Modeling

Fixed-length **8-frame sliding window**.

- Training: frames uniformly sampled per clip
- Live inference: sliding window maintained over incoming frames
- Missing face detections: forward-filled from the last valid embedding
- Frames with no prior detection: zero-padded and masked out

### Extraction Pipeline (Training)

Files are processed in configurable chunks and saved as intermediate `.npz` files. Existing chunks are skipped on re-run — the pipeline is resumable after interruption. All chunks are merged and actor-split at the end.

---

## Models

### EmotionTransformer

Multimodal temporal model. Learns temporal dynamics across the 8-frame sequence.

```
Face(27)    --> ModalityProjection(-->128) --> PositionalEncoding --+
                                                                     +--> concat(256)
Audio(1024) --> ModalityProjection(-->128) --> PositionalEncoding --+
                                                                     |
                                             TransformerEncoder -----+
                                             (6 layers, 8 heads, FFN=768)
                                                                     |
                                             Attention Pool ----------+
                                             (learned scalar weights)
                                                                     |
                                             LayerNorm --> Linear(-->6 classes)
```

`ModalityProjection` uses a gated activation: `output = MLP(x) * sigmoid(Linear(x))`.  
Cross-modal fusion is by concatenation — simpler than cross-attention and more robust when one modality is absent.

### XGBoost

Captures statistical structure via hand-crafted aggregates over the sequence. Complements the Transformer's temporal inductive bias.

| Feature group | Dimensionality |
|---------------|---------------|
| Per-modality: mean, std, min, max (face + audio) | 4×27 + 4×1024 |
| Temporal delta: last − first valid frame | 27 + 1024 |
| Modality flags: has_face, has_audio, has_both | 3 |
| **Total** | **5,258** |

1,500 trees, max_depth=6, lr=0.03, early stopping on validation accuracy.

### Ensemble

Grid search over `w_modal ∈ [0, 1]` at 0.05 increments on validation set:

```
final_probs = w_modal × p_transformer + w_xgb × p_xgboost
```

**Calibrated weights: `w_modal=0.45, w_xgb=0.55`**

XGBoost carries slightly more weight because RAVDESS is a small dataset (~7,400 clips) and the Transformer overfits at this scale. The balanced weighting reflects that both models contribute complementary signal — the Transformer captures temporal dynamics, XGBoost captures statistical structure. Single-modality fallbacks (audio-only: 0.2/0.8, video-only: 0.8/0.2) are heuristic; the calibration script does not run separate grid searches per modality subset.

### OOD Detection

`IsolationForest` (200 trees) trained on the same behavioral features as XGBoost, **excluding the 3 modality flags** (5,255-dim). Detects out-of-distribution inputs — e.g., low-light webcam video, motion blur, partial occlusion — that fall outside the clean RAVDESS training distribution.

- Threshold calibrated at 10% FPR on the validation set
- OOD inputs are flagged in the response but still inferred; the flag surfaces in logs for monitoring
- Adds ~1ms overhead; runs before the ensemble

Validation OOD rates: `audio_only: 13.28%` | `video_only: 0.78%` | `both: 16.10%`

---

## Batch Pipeline — Transcript Service

Triggered once per meeting after the call ends. Stateless; all persistence is delegated to the Node.js backend.

### Pipeline

```
Audio WebM blobs (per participant)
  --> ffmpeg: WebM → 16kHz mono WAV
  --> Whisper (small): WAV → timestamped segments { start, end, text }
      [discard segments < 3 characters]
  --> DistilRoBERTa (j-hartmann/emotion-english-distilroberta-base): per-segment emotion label
  --> merge_segments: time-sort + speaker interleave
  --> POST /api/v1/transcripts (Node.js, authenticated via x-host-secret)
```

### Output

Speaker-attributed transcript with per-segment emotion labels:

```json
{ "speaker": "...", "start": 0.0, "end": 3.4, "text": "...", "emotion": "..." }
```

### Noise Filtering (Node.js layer)

Applied before persistence:
- Segments shorter than 3 characters discarded
- Minimum word threshold enforced
- Alpha ratio filtering
- Repetition detection

### Consistency Model

The transcript pipeline is **eventually consistent** — results may appear with slight delay after meeting completion. Submissions are retried on transient failures and handled idempotently via MongoDB upsert (`meetingCode` as key). The service is stateless and horizontally scalable.

---

## Results

| Model | Test Accuracy | Val Accuracy | Notes |
|-------|--------------|--------------|-------|
| EmotionTransformer | 71.1% | 72.5% | Multimodal temporal model |
| XGBoost | 70.8% | ~70–71% | Statistical aggregates + modality flags |
| **Ensemble (0.45 / 0.55)** | **73.0%** | **76.8%** | Calibrated via grid search on val set |

The ensemble improves ~1.9% over the best standalone model, confirming complementary error patterns between temporal modeling and statistical aggregation.

**Per-class performance:**
- Best F1: `angry 0.81`, `happy 0.78`, `neutral/calm 0.74`
- Hardest: `fearful` (0.53 recall) — frequently confused with `sad`
- Second hardest: `sad` (0.59 recall) — confused with `disgust` and `neutral/calm`

> Val accuracy (76.8%) exceeds test accuracy (73.0%) because ensemble weights were tuned on the validation set — expected behavior for small datasets like RAVDESS.

---

## Training (optional — pre-trained weights included)

```bash
cd emotion_service
# Requires RAVDESS dataset path configured in config/config.json
python embeddings/extract_embeddings_data.py
python training/train_modal.py
python training/train_xgb.py
python inference/calibrate_ensemble.py
python training/train_anomaly.py
```