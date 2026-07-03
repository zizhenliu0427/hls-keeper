$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Python = "python"
$Port = if ($env:HLS_KEEPER_PORT) { $env:HLS_KEEPER_PORT } else { "17888" }
$Ffmpeg = if ($env:FFMPEG) { $env:FFMPEG } else { "C:\ffmpeg\bin\ffmpeg.exe" }

Set-Location $Root
Write-Host "Starting HLS Keeper on http://127.0.0.1:$Port/"
& $Python -m hls_keeper.server --port ([int]$Port) --ffmpeg $Ffmpeg
