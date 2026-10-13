@echo off
rem Double-click to launch DK WIND. Opens http://127.0.0.1:8765/ ; close this window (or Ctrl+C) to stop.
cd /d "%~dp0"
python serve.py
if errorlevel 1 (
  echo.
  echo Could not start. Is Python installed and on PATH? Try: py serve.py
  pause
)
