# AI Meeting Transcription & Emotion Intelligence System

---

## Overview

An end-to-end AI-powered system that converts meeting audio into  
**structured, emotion-aware transcripts**.

Built with a **microservices architecture**, combining:

- Speech Recognition (Whisper)
- Emotion Intelligence (Transformers)
- Scalable Backend (Node.js)
- Modern Frontend (React)

---

## Key Highlights

- Accurate Transcription using Whisper  
- Emotion Detection per Sentence  
- Multi-Speaker Support  
- Emoji-enhanced UX  
- Real-time Processing Pipeline  
- Secure Host-based Authorization  
- Seamless Microservice Integration  

---

## Architecture

Audio Input (files / stream)
        │
        ▼
Flask API (/process_meeting)
        │
        ▼
Audio Processing (audio.py)
        │
        ▼
ASR Service (asr_service.py)
        │
        ▼
Whisper Model
        │
        ▼
Raw Transcription
        │
        ▼
Emotion Analysis (emotion.py)
        │
        ▼
Processing Service (processing_service.py)
        │
        ▼
Helpers (helpers.py)
        │
        ▼
Node.js Backend API
        │
        ▼
Final JSON Response

---

## Tech Stack

- AI Service: Flask + Whisper + Transformers  
- Backend: Node.js + Express  
- Database: MongoDB  
- Frontend: React  
- Audio: FFmpeg  

---

## Setup

pip install -r requirements.txt  
python app.py  

---

## License

MIT
