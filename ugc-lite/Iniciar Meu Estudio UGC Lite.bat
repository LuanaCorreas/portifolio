@echo off
chcp 65001 >nul
title Meu Estudio UGC Lite
cd /d "%~dp0"
set "PYCMD=python"
where py >nul 2>nul && set "PYCMD=py -3"
where py >nul 2>nul && py -3.11 -c "" >nul 2>nul && set "PYCMD=py -3.11"
%PYCMD% app.py %*
if errorlevel 1 (
  echo.
  echo Ocorreu um erro ao iniciar. Verifique se o Python 3.11 esta instalado.
  pause
)
