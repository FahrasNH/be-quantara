@echo off
REM Run Wyckoff backtest report without PowerShell npm.ps1 (avoids ExecutionPolicy errors).
REM Usage:
REM   scripts\run-wyckoff-report.cmd
REM   set WYCKOFF_BT_MONTHS=12&& scripts\run-wyckoff-report.cmd
REM   scripts\run-wyckoff-report.cmd -- --source mock --months 12 --symbol BTCUSDT

cd /d "%~dp0.."
if "%WYCKOFF_BT_MONTHS%"=="" set WYCKOFF_BT_MONTHS=12
node --test test/wyckoff-backtest-report.test.js %*
