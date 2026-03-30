# SkymeetAI

## Project Overview

SkyMeet AI is a real-time meeting intelligence platform that combines video conferencing, live chat, and AI-driven insights into a unified system. Built on WebRTC for low-latency communication and Socket.io for real-time signaling, it enables seamless multi-user collaboration.

The platform enhances meetings with live transcription using Whisper, multimodal emotion analysis (audio + visual + NLP), and anomaly detection to surface meaningful participant insights. By integrating communication with intelligent analytics, SkyMeet AI transforms meetings from simple interactions into data-driven, human-aware experiences.

## 🧩 System Components

The platform is designed as a **microservices-based system** with four core components:

- **Frontend (React)**: Handles the user interface, WebRTC-based video/audio streaming, chat, and authentication flows.  

- **Backend (Node.js + Express + Socket.io)**: Manages REST APIs, real-time signaling, meeting lifecycle, and integrates with AI services.  

- **Transcription Service (Flask + Whisper)**: Performs real-time speech-to-text (ASR) and text-based emotion classification at the segment level.  

- **Emotion Service (Flask + Deep Learning)**: Executes multimodal emotion recognition using audio features (mel spectrograms) and visual embeddings, with anomaly detection via Isolation Forest.  


---

## 🚀 Core Features

- Low-latency **real-time video/audio communication** with screen sharing  
- **WebSocket-based chat and signaling** for synchronized interactions  
- **JWT-based authentication** and secure session management  
- **Live transcription** with structured outputs (text + JSON)  
- **Multimodal emotion analysis** (audio + visual + NLP)  
- **Anomaly detection** for behavioral insights in meetings  
- Seamless **inter-service communication** between backend and ML pipelines  


---

## 💡 Design Philosophy

The system is built to bridge communication and intelligence by combining:

- **Real-time distributed systems (WebRTC + Socket.io)**  
- **Scalable ML inference pipelines (Flask services)**  

This enables SkyMeet AI to go beyond traditional meeting tools by delivering **context-aware, insight-driven collaboration**, suitable for applications such as:

- Virtual meetings  
- Sentiment analysis  
- Behavioral monitoring  


## 📊 Datasets (Emotion Service)

The Emotion Service leverages publicly available datasets for training multimodal emotion recognition models:

- **CREMA-D (Audio Dataset)**  
  Contains labeled audio recordings for emotions such as *anger, disgust, fear, happiness, neutral,* and *sadness*.  
  🔗 https://www.kaggle.com/datasets/ejlok1/cremad  
  📄 License: CC BY 4.0  

- **AffectNet Aligned (Facial Dataset)**  
  A large-scale dataset of facial images annotated with emotion labels.  
  🔗 https://www.kaggle.com/datasets/yakhyokhuja/affectnetaligned  
  📄 License: Research / Non-commercial use  


---

### ⚠️ Notes

- Datasets must be downloaded manually and placed in:
  - `data/audio/`
  - `data/images/`
- Ensure compliance with dataset licenses and ethical guidelines  
- Avoid biased or privacy-invasive usage of emotion recognition systems

## 🏗️ Architecture Overview

SkyMeet AI is built using a **microservices architecture with real-time extensions**, designed to separate low-latency communication from compute-intensive AI workloads.

---

### 🧩 High-Level Components

1. **Frontend (React + WebRTC)**  
   Handles the user interface, real-time video/audio streaming, chat, and client-side interactions  

2. **Backend (Node.js + Express + Socket.io)**  
   Manages REST APIs, real-time signaling, meeting lifecycle, and database interactions  

3. **Transcription Service (Flask + Whisper)**  
   Performs speech-to-text (ASR) and text-based emotion classification  

4. **Emotion Service (Flask + Deep Learning)**  
   Processes audio and video inputs for multimodal emotion recognition and anomaly detection  

---

### 🔄 Data Flow

- **User Interaction**  
  The frontend communicates with the backend via REST APIs and WebSockets for real-time events  

- **Meeting Lifecycle**  
  The backend handles room creation, participant management, and signaling (SDP, ICE)  

- **Media Processing**  
  Audio and video streams are captured on the client and forwarded to ML services  

- **AI Inference**  
  - Transcription Service → generates transcripts and text-based emotions  
  - Emotion Service → extracts multimodal emotion insights and anomaly scores  

- **Persistence & Streaming**  
  Results are stored in MongoDB and streamed back to clients in real-time via Socket.io  

### 📊 Architecture Diagram

```mermaid
flowchart TD

A[Frontend (React + WebRTC)]
B[Backend (Node.js + Socket.io)]
C[(MongoDB)]
D[Transcription Service (Flask + Whisper)]
E[Emotion Service (Flask + ML)]
F[Analytics & Transcripts]

A <-->|API + WebSockets| B
B -->|Store Data| C
B -->|Audio Stream| D
B -->|Audio + Video Frames| E
D -->|Transcripts + Text Emotion| B
E -->|Emotion + Anomaly Scores| B
B -->|Persist Insights| F
F --> C
B -->|Real-time Updates| A

### ⚙️ Scalability & Performance

- **Backend (Node.js)**
  - Currently maintains meeting state in-memory  
  - Can be extended with **Redis** for horizontal scaling and distributed session management  
  - Event-driven architecture ensures efficient handling of concurrent real-time connections  

- **ML Services (Flask)**
  - Models are preloaded at startup to reduce inference latency  
  - Designed for independent scaling (can be deployed on separate instances or GPUs)  
  - GPU acceleration recommended for faster audio/video inference  

- **Potential Bottlenecks**
  - **Whisper ASR latency** for long audio segments  
  - **FFmpeg preprocessing overhead** during media extraction  
  - **WebRTC bandwidth constraints** affecting real-time quality  

---

### 💡 Scalability Strategy

- Introduce **Redis Pub/Sub** for distributed Socket.io signaling  
- Use **load balancers** for backend and ML services  
- Enable **parallel processing** for transcription and emotion pipelines  
- Optimize inference using batching and GPU acceleration  
## Installation and Setup

### Prerequisites
- Python 3.8+ (for Flask services).
- Node.js 18+ and npm (for Backend and Frontend).
- MongoDB (for Backend).
- FFmpeg (system-level, for audio/video processing in services).
- GPU (optional, for faster AI inference via CUDA/Torch).
- Git (for cloning the repo).

### Steps
1. Clone the repository:
   ```
   git clone <repo-url>
   cd skymeetai
   ```

2. Install dependencies for each component (detailed below).

3. Download datasets for Emotion Service (if using).

4. Set up environment variables in `.env` files (see each component's section).

### Component-Specific Installation

#### Frontend (React)
- Directory: `frontend/`
- Install: `npm install`
- Environment: Set `REACT_APP_API_URL`, `REACT_APP_SIGNALING_URL`, `REACT_APP_TRANSCRIPT_URL`, `REACT_APP_EMOTION_URL` in `.env`.

#### Backend (Node.js)
- Directory: `backend/`
- Install: `npm install`
- Environment Variables (in `.env`):
  - `CLIENT_ORIGIN`: CORS origin (e.g., `http://localhost:3000`).
  - `PORT`: Server port (default: 8000).
  - `MONGO_URI`: MongoDB connection string.
  - `JWT_SECRET`: For token signing.
  - `EMOTION_SERVICE_URL`: Emotion Service endpoint (default: `http://localhost:5002/analyze`).
  - `PARTIAL_UPLOAD_MAX_BYTES`: Upload size limit (default: 200MB).
- Connect to MongoDB.

#### Transcription Service (Flask)
- Directory: `transcription_service/`
- Install: `pip install -r requirements.txt` (includes Flask, Whisper from GitHub, transformers, torch, etc.).
- Folders: Ensure `uploads/` and `outputs/` exist (auto-created on startup).
- Configuration: Modify globals in `app.py` (e.g., `MIN_DURATION_SEC=0.30`, `CLEANUP_DELAY_SEC=120`).

#### Emotion Service (Flask)
- Directory: `emotion_service/`
- Install: `pip install -r requirements.txt` (includes Torch, librosa, MTCNN, Flask, etc.).
- Environment Variables (in `.env` or shell):
  - `FLASK_CORS_ORIGINS`: CORS origins (e.g., `http://localhost:3000`).
  - `BACKEND_URL`: Backend API for forwarding results.
  - `LOG_LEVEL`: Logging level (e.g., `DEBUG`).
- Preprocess data: Run scripts like `preprocess_images.py`, `preprocessing_audio.py`, etc.

## Running the Application

1. **Backend**: `node src/app.js` (or `pm2 start src/app.js` for production).
2. **Transcription Service**: Development: `python app.py` (runs on `http://0.0.0.0:5001`). Production: `gunicorn -w 4 app:app -b 0.0.0.0:5001`.
3. **Emotion Service**: Development: `FLASK_ENV=development python app.py` (runs on port 5002). Production: `gunicorn -w 4 app:app`.
4. **Frontend**: `npm start` (runs on `http://localhost:3000`).

Access the app at `http://localhost:3000`. Ensure services are running and URLs match environment configs.

For testing:
- Use curl/Postman for APIs.
- Socket.io client for real-time events.

## Key Pages and Usage (Frontend)

- **Landing (`/`)**: Entry page.
- **Authentication (`/auth`)**: Sign-in/register.
- **Home (`/home`)**: Create/join rooms, view transcripts.
- **History (`/history`)**: Past meetings.
- **Video Meeting (`/room/:roomId`)**: Core call interface.

Example Client Request (Transcription Service via curl):
```
curl -X POST http://localhost:5001/process_meeting \
  -F "audio_files=@speaker1.webm" \
  -F "speaker_map={\"speaker1\": \"Alice\"}"
```

API Endpoints (Backend):
- `/api/v1/users`: Login/register.
- `/api/v1/meetings`: List/upsert meetings.
- `/api/v1/transcript`: Manage transcripts.

Socket Events (Backend): `join-call`, `chat`, `signal`, `emotion.frame`, etc.

## API Endpoints (Emotion Service)
- POST `/analyze`: Analyze audio/video file.

## Components Documentation

### Frontend
- **Technology Stack**: React 18, react-router-dom, socket.io-client, axios, @mui/material.
- **Key Modules**:
  - `VideoMeet.jsx`: Manages WebRTC, signaling, chat, screen sharing, emotion analysis.
  - `AuthContext.jsx`: Handles auth, JWT, history.
  - `mediaController.js`: Abstracts media streams and track management.
  - `home.jsx`: Room creation/join, transcript display.
- **Scripts**: `npm start`, `npm build`.

### Backend
- **Models**: User, Meeting (with participants, chat, analytics), Transcript.
- **Controllers**: User (auth/history), Emotion (forwarding), Transcript (CRUD).
- **Socket Events**: Join/leave, chat, signals, uploads, emotions.

### Transcription Service
- **Endpoints**: POST `/process_meeting`, GET `/outputs/<filename>`.
- **Dependencies**: Flask, Whisper, transformers, FFmpeg.
- **Configuration**: Globals in `app.py`.

### Emotion Service
- **Preprocessing/Training Scripts**: `preprocess_*.py`, `extract_embeddings.py`, `train_multimodal.py`, `train_anomaly.py`.
- **Inference**: `predict.py` (CLI), `app.py` (API).
- **Models**: ResNet18 + MLP for fusion, Isolation Forest for anomalies.

## Troubleshooting
- **CORS Issues**: Verify origins in `.env` and service configs.
- **Media Access**: Ensure HTTPS/localhost and browser permissions.
- **Socket Failures**: Check URLs and backend logs.
- **AI Latency**: Use GPU; monitor FFmpeg/Torch.
- **Resource Leaks**: Ensure cleanup timers/jobs run.
- **Errors**: Check console/server logs; fallback to localStorage for history.

For detailed module docs, refer to sub-directories.

## License
This project is for educational/research purposes. Respect dataset licenses and ethical guidelines.

MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
