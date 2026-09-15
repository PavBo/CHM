#!/bin/bash
cd "$(dirname "$0")"
node server.js &
PID=$!
sleep 1
if command -v open >/dev/null 2>&1; then open http://localhost:4173; fi
wait $PID
