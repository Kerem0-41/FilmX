@echo off
rem FilmX'i bilgisayarda web adresiyle açar (YouTube/Dailymotion oynatıcıları bunu istiyor). İnternete bir şey yüklenmez.
cd /d "%~dp0"
start "FilmX sunucu" /min python -m http.server 8791 --bind 127.0.0.1
timeout /t 1 /nobreak >nul
start "" http://127.0.0.1:8791/index.html
