# Performance

> Metrics are collected using high-resolution timers (`time.perf_counter`) and `process.hrtime` across AWS EC2 and macOS (M1).

---

## Freshness vs Throughput Tradeoff

SkyMeetAI prioritizes *freshness* over *throughput* in real-time inference.  
Instead of processing every frame (which leads to queue buildup and latency growth), the system processes only the most recent frame, ensuring outputs always reflect the current user state.

This guarantees bounded latency at the cost of dropping intermediate frames — a deliberate design choice for real-time analytics.

---

## Core System Latency

| Metric | Value |
|--------|-------|
| WebRTC signaling latency | ~0.02–4.3 ms (observed range, typically <1 ms) |
| Room join latency (client-perceived) | ~65–420 ms (observed range across test runs) |

**Notes:**
- Metrics are derived from instrumented logs during local and EC2 testing
- Values represent observed samples, not percentile-based measurements
- Join latency includes network RTT, Socket.IO connection setup, and backend coordination

---

## Emotion Processing Pipeline (CPU-bound)

| Stage | Latency |
|------|---------|
| Frame decode (base64 → image) | ~1–5 ms |
| Face detection + feature extraction | ~1.1–1.7 s (steady), ~4–5 s (cold start) |
| Model inference | ~5–20 ms |
| Total per-frame processing | ~1.2–1.7 s |

> Feature extraction accounts for >95% of total pipeline latency; model inference is negligible.  
> The system is compute-bound (face detection + feature extraction), not network-bound — WebRTC signaling and transport contribute <1 ms latency in comparison.

---

## Real-Time Streaming Design

| Metric | Value |
|--------|-------|
| Buffer strategy | Single-slot latest-frame overwrite (no queue, no backlog) |
| Temporal window | 8 frames (sliding window) |
| Frame skip rate | 7× (1 processed per 7 received) |
| Minimum inference interval | 350 ms (rate limiter, not the bottleneck) |
| Effective inference interval | ~1.2–1.7 s (compute-bound) |
| Memory complexity | O(1) per participant |
| Inference batching | Disabled (real-time single sequence inference) |

---

## End-to-End Latency

| Metric | Value |
|--------|-------|
| Capture → inference → emit latency | ~1.2–1.7 s (steady-state, compute-bound) |
| Cold start latency | up to ~4–5 s |

> Latency remains stable over time due to overwrite-buffer design, preventing queue buildup and backpressure.

---

## Key Architectural Properties

- **No frame queue** → eliminates latency accumulation
- **Latest-frame processing** → always reflects current user state
- **Constant memory (O(1)) per user**
- Latency remains stable under sustained load (does not increase with higher input frame rates)
- **Compute-bound pipeline (not network-bound)**

---

## Test Configuration

> Tested with 4–5 participants across Chrome and Safari tabs on a single Apple MacBook Air (M1, 2020), plus one mobile client.

This represents a worst-case single-device scenario:
- Encoding/decoding load is concentrated
- CPU contention is artificially high

In real-world distributed usage:
- Load is shared across devices
- Practical performance improves

---

## Scalability Constraint

Due to **O(N²)** WebRTC mesh topology:
- Each participant connects to every other participant
- CPU and bandwidth scale quadratically

This architecture is not suitable for large rooms without:
- SFU (Selective Forwarding Unit)
- or hybrid architecture

---

## Internal Latency Instrumentation

- Stage-level timing using `time.perf_counter`
- Covers decode, extraction, inference, and total pipeline latency
- Socket-level metrics tracked via `process.hrtime`

> Provides precise, stage-level visibility into bottlenecks without reliance on external APM tools.