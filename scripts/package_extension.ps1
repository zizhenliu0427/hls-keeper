param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\dist")
)

$ErrorActionPreference = "Stop"
$extensionDirectory = (Resolve-Path (Join-Path $PSScriptRoot "..\extension")).Path
$manifestPath = Join-Path $extensionDirectory "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$resolvedOutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force | Out-Null

$archivePath = Join-Path $resolvedOutputDirectory "Web-Keeper-$($manifest.version).zip"
if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
}

$packageItems = @(
    "manifest.json",
    "background.js",
    "i18n.js",
    "media-engine.js",
    "popup.html",
    "popup.js",
    "download.html",
    "download.js",
    "settings.html",
    "settings.js",
    "vendor",
    "_locales"
) | ForEach-Object { Join-Path $extensionDirectory $_ }

Compress-Archive -LiteralPath $packageItems -DestinationPath $archivePath -CompressionLevel Optimal
Write-Output $archivePath
