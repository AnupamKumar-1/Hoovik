#!/bin/bash

# Hoovik — start all four services in parallel
# chmod +x dev.sh   -- one-time
# Usage: ./dev.sh

set -e

# Colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
MAGENTA='\033[0;35m'
YELLOW='\033[0;33m'
RESET='\033[0m'

log() { echo -e "${1}[${2}]${RESET} ${3}"; }

cleanup() {
  echo ""
  echo "Shutting down all services..."
  kill 0
}
trap cleanup SIGINT SIGTERM

log $BLUE  "FRONTEND"   "Starting React dev server..."
(cd frontend && npm start 2>&1 | sed "s/^/$(echo -e ${BLUE})[FRONTEND]$(echo -e ${RESET}) /") &

log $GREEN "BACKEND"    "Starting Node.js backend..."
(cd backend && npm run dev 2>&1 | sed "s/^/$(echo -e ${GREEN})[BACKEND]$(echo -e ${RESET}) /") &

log $MAGENTA "EMOTION"  "Starting emotion service on :5002..."
(./emotion_service/venv/bin/python -m uvicorn app:app \
  --app-dir emotion_service --host 0.0.0.0 --port 5002 --reload \
  2>&1 | sed "s/^/$(echo -e ${MAGENTA})[EMOTION]$(echo -e ${RESET}) /") &

log $YELLOW "TRANSCRIPT" "Starting transcript service on :5001..."
(./transcript_service/venv/bin/python -m uvicorn app:app \
  --app-dir transcript_service --host 0.0.0.0 --port 5001 --reload \
  2>&1 | sed "s/^/$(echo -e ${YELLOW})[TRANSCRIPT]$(echo -e ${RESET}) /") &

wait