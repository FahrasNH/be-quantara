# Deploy BE development ke VPS (tanpa clone FE).
# Usage (PowerShell, dari root be-quantara):
#   .\deploy-development.ps1
#   .\deploy-development.ps1 -BeOnly

param(
  [switch]$BeOnly,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Help) {
  Write-Host "Usage: .\deploy-development.ps1 [-BeOnly]"
  Write-Host "  Deploy BE ke https://dev.quantara.software"
  Write-Host "  Pastikan sudah: git push origin development"
  exit 0
}

$bash = @(
  "C:\Program Files\Git\bin\bash.exe",
  "C:\Program Files\Git\usr\bin\bash.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $bash) {
  Write-Error "Git Bash tidak ditemukan. Install Git for Windows, atau jalankan: bash deploy-development.sh"
  exit 1
}

$argsList = @("$Root\deploy-development.sh")
if ($BeOnly) { $argsList += "--be-only" }

& $bash @argsList
exit $LASTEXITCODE
