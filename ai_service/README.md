# AI Meeting Transcription & Emotion Intelligence System

![Architecture](architecture.png)

------------------------------------------------------------------------

## Overview

An end-to-end AI-powered system that converts meeting audio into
**structured, emotion-aware transcripts**.

Built with a **microservices architecture**, combining: - 🎙 Speech
Recognition (Whisper) - Emotion Intelligence (Transformers) - ⚙️
Scalable Backend (Node.js) -  Modern Frontend (React)

------------------------------------------------------------------------

## Key Highlights

-    **Accurate Transcription** using Whisper
-    **Emotion Detection per Sentence**
-    **Multi-Speaker Support**
-    **Emoji-enhanced UX**
-    **Real-time Processing Pipeline**
-    **Secure Host-based Authorization**
-    **Seamless Microservice Integration**

------------------------------------------------------------------------

## System Architecture

      Meeting Audio
       →  FFmpeg Processing
       →  Whisper ASR
       →  Emotion Detection
       →  Structured Transcript
       →  Flask AI Service
       →  Node.js API
       →  MongoDB
       →  React UI

------------------------------------------------------------------------

## Tech Stack

  Layer        Technology
  ------------ --------------------------------
  AI Service   Flask + Whisper + Transformers
  Backend      Node.js + Express
  Database     MongoDB
  Frontend     React
  Audio        FFmpeg

------------------------------------------------------------------------

## Project Structure

    ai_service/
    ├── app.py
    ├── services/
    ├── utils/
    ├── uploads/
    ├── outputs/

------------------------------------------------------------------------

## Setup

### Install dependencies

    pip install -r requirements.txt

### Run service

    python app.py

------------------------------------------------------------------------

## API

### POST `/process_meeting`

Upload audio → get transcript + emotions

------------------------------------------------------------------------

## Example Response

    {
      "success": true,
      "segments": [
        {
          "speaker": "Host",
          "text": "Hello everyone",
          "emotion": "joy",
          "emoji": "😄"
        }
      ]
    }

------------------------------------------------------------------------

## Output Example

    Host 😄 (joy)
      Hello everyone

    Guest 😐 (neutral)
      Thank you

------------------------------------------------------------------------

## Performance

-   Models loaded once at startup
-   GPU recommended for Whisper
-   Optimized for async backend integration

------------------------------------------------------------------------

## Future Enhancements

-    Emotion Timeline Graph
-    LLM Meeting Summary
-    Real-time streaming transcription
-    Key insight extraction

------------------------------------------------------------------------

> Built an AI-powered meeting intelligence system using Whisper and NLP,
> enabling emotion-aware transcription with a scalable microservices
> architecture.

------------------------------------------------------------------------

## 📜 License

MIT
