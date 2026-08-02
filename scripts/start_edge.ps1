$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Extension = Join-Path $Root "extension"
$Profile = Join-Path $Root "edge_profile"
$ExtensionId = "mjojbidcfdcdajjgoopcipmnkdioceip"
$Edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $Edge)) {
  $Edge = "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe"
}
if (-not (Test-Path $Edge)) {
  throw "Microsoft Edge not found."
}

New-Item -ItemType Directory -Force -Path $Profile | Out-Null

Start-Process -FilePath $Edge -ArgumentList @(
  "--user-data-dir=$Profile",
  "--disable-extensions-except=$Extension",
  "--load-extension=$Extension",
  "chrome-extension://$ExtensionId/download.html"
)
