$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Python = "python"
$Port = if ($env:HLS_KEEPER_PORT) { $env:HLS_KEEPER_PORT } else { "17888" }

Set-Location $Root
Write-Host "Starting Web Keeper on http://127.0.0.1:$Port/"
# ffmpeg is auto-detected: FFMPEG env var -> tools\ffmpeg\ -> PATH -> C:\ffmpeg\bin
if ($env:FFMPEG) {
  & $Python -m hls_keeper.server --port ([int]$Port) --ffmpeg $env:FFMPEG
} else {
  & $Python -m hls_keeper.server --port ([int]$Port)
}
