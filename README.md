# Web Keeper

Web Keeper is a local browser-assisted download and archiving tool. It keeps the existing HLS capture workflow, and adds a separate Archive module for site attachments such as FANBOX ZIP files.

[中文文档](README.zh-CN.md)

> Current implementation note: the project directory and Python package are still named `hls-keeper` / `hls_keeper` for compatibility with the existing scripts. The user-facing project name is now **Web Keeper**.

## What It Does

Web Keeper runs as three local pieces:

```text
Browser extension -> local Python server -> local downloads / archives / outputs
```

The browser extension observes requests that your browser is already allowed to make. The local Python server stores candidates, downloads files with the captured headers when needed, tracks progress, and exposes a Dashboard at `http://127.0.0.1:17888/`.

Web Keeper does not decrypt DRM, bypass access controls, or grant access to content your browser cannot already load.

## Modules

### HLS Capture

The HLS module is for ordinary `.m3u8` playback streams:

- discovers `.m3u8`, `.ts`, `.key`, and subtitle requests from the browser;
- records playlist, segment, key, and subtitle metadata;
- downloads HLS segments in the background;
- retries missing pieces;
- detects bad tiny segment responses such as `30B` / `33B` placeholders;
- merges downloaded segments to MP4 with ffmpeg;
- supports subtitle-only downloads and subtitle conversion workflows.

### Archive

The Archive module is for normal downloadable site attachments.

The first adapter is FANBOX ZIP archive downloading:

- scans FANBOX creator pages;
- calls FANBOX `post.info` for each post;
- reads original file metadata from the API;
- saves ZIP files using `name + extension`, not UUID download URLs;
- groups files by page, for example `Page 001`, `Page 002`;
- writes `archive_manifest.jsonl` for audit and retry context;
- verifies downloaded ZIP files.

The Archive tab also supports generic batch downloads:

- scan any page URL for direct archive links (`.zip`, `.rar`, `.7z`, `.tar`, `.tar.gz`, `.cbz`, and more), with relative URLs resolved;
- or paste direct archive URLs, one per line;
- filenames come from `Content-Disposition` when available, otherwise from the URL;
- ZIP integrity is verified after download, and an `archive_manifest.jsonl` is written next to the files.

Archive jobs appear in the same Dashboard Jobs table as HLS jobs.

## Quick Start

1. Install dependencies:

```powershell
.\scripts\install_requirements.ps1
```

2. Start the local server:

```powershell
.\scripts\start_server.ps1
```

3. Start Edge with the extension loaded:

```powershell
.\scripts\start_edge.ps1
```

4. Open the Dashboard:

[http://127.0.0.1:17888/](http://127.0.0.1:17888/)

## Browser Extension

The extension has two main switches:

- `Discover`: observe useful browser requests and send candidates to the local server.
- `Capture`: actively capture HLS media requests for background downloading.

For Archive workflows, keep `Discover` enabled. When you open FANBOX in that browser, the extension automatically saves recent FANBOX request headers to the local server. Archive downloads use those saved headers first, and manual headers are only a fallback or override.

After changing extension files, reload the extension in Edge/Chrome.

## HLS Workflow

Recommended flow:

1. Open the video page and start playback.
2. Enable `Discover` in the extension.
3. Wait for the Dashboard to show a candidate video.
4. Use `Direct download` from the Dashboard when a playlist or segment candidate is available.
5. If pieces are missing, use `Retry` or replay the missing area in the browser to refresh authorization.
6. Merge when enough segments are saved.

Merge strategies:

- `strict`: requires a complete segment set.
- `skip`: skips missing pieces and keeps playback continuous where possible.
- `fill-skip`: fills missing pieces from lower qualities when available, then skips any remaining gaps.

## Archive Workflow: FANBOX ZIP Files

Open the Dashboard and use `Archive: FANBOX ZIP attachments`.

Fields:

- `creatorId`: for example `dollhouse`.
- `start page` / `end page`: page range to scan. Leave end blank to continue until there are no more pages.
- `output folder`: optional. If blank, files are saved under `archives/fanbox/<creatorId>`.
- `use saved browser headers first`: enabled by default. This uses automatically captured browser headers.
- `headers JSON`: optional override/fallback, for example `{"cookie":"..."}`.
- `ZIP only`: enabled by default.

Automatic headers are preferred. Manual `headers JSON` values are merged on top of the saved browser headers, so a stale cookie or referer can be overridden without disabling the automatic path.

API example:

```powershell
Invoke-RestMethod http://127.0.0.1:17888/api/archive/fanbox `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"creator_id":"dollhouse","start_page":1,"end_page":10,"workers":4,"request_delay_ms":100,"zip_only":true}'
```

## API

```text
GET  /                         Dashboard
GET  /api/status               Current server status
POST /ping                     Extension heartbeat
POST /candidate                Extension-discovered media candidate
POST /capture                  Extension-captured HLS media request
POST /api/retry-missing        Retry missing HLS segments
POST /api/direct-download      Start direct HLS download
POST /api/subtitles-only       Download subtitles only
POST /api/start-candidate-download
POST /api/start-candidate-subtitles
POST /api/convert-subtitles
POST /api/export-player-subtitle
POST /api/open-location
POST /api/merge                Merge HLS output
POST /api/archive/headers      Save browser-captured archive headers
POST /api/archive/fanbox       Start FANBOX archive download
```

Direct HLS example:

```powershell
Invoke-RestMethod http://127.0.0.1:17888/api/direct-download `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"url":"https://example.com/video/1280x720/first.m3u8","workers":8,"request_delay_ms":100,"use_saved_headers":true}'
```

Merge example:

```powershell
Invoke-RestMethod http://127.0.0.1:17888/api/merge `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"product":"video-id","resolution":"1280x720","strategy":"fill-skip"}'
```

## Directory Layout

```text
hls-keeper/
  extension/              Browser extension
  hls_keeper/
    server.py             Local server, Dashboard, API, HLS workflow
    archive.py            Archive module and FANBOX adapter
  scripts/                Startup and install scripts
  data/                   Local state, captured requests, HLS captures
  archives/               Archive module output
  outputs/                Merged MP4 outputs
```

## Configuration

Server options:

```powershell
python -m hls_keeper.server --help
```

Common options:

- `--port`: local server port, default `17888`.
- `--data-dir`: state and capture data directory.
- `--output-dir`: merged HLS output directory.
- `--archive-dir`: archive output directory.
- `--ffmpeg`: ffmpeg executable path (optional).
- `--workers`: default HLS worker count.

### ffmpeg lookup

ffmpeg is only needed for merging segments to MP4. It is auto-detected in this order:

1. `--ffmpeg` argument or the `FFMPEG` environment variable;
2. `tools\ffmpeg\bin\ffmpeg.exe` or `tools\ffmpeg\ffmpeg.exe` inside the project (drop a downloaded build here to bundle it locally — do not commit the binary);
3. `ffmpeg` on `PATH`;
4. the legacy default `C:\ffmpeg\bin\ffmpeg.exe`.

If ffmpeg is missing, the Dashboard shows a banner with a download link (https://ffmpeg.org/download.html). Downloads still work without ffmpeg — segments are kept on disk, so you can merge manually later.

## Privacy

The extension sends selected browser request URLs and headers to `127.0.0.1`. Headers may include cookies or authorization tokens. Do not publish or share these files:

- `data/state.json`
- `data/requests.jsonl`
- `data/events.jsonl`
- archive manifests that include private source URLs

## Limitations

Web Keeper is most useful for ordinary HLS streams and normal downloadable attachments. It may not fully handle:

- DRM-protected media;
- sources that intentionally return empty or one-time segments;
- extremely short-lived tokens bound to device fingerprint, IP, or playback session;
- sites where the real filename is only available through a site-specific API that has not been adapted yet.

## Roadmap

- Browser-captured archive queue: save archive download requests seen by the extension as Dashboard candidates.
- Batch image downloader: capture or scan image resources such as `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.avif`, and `.bmp`; group them by page, title, source site, or user-defined folder rule.
- Image filename and folder rules: preserve original filenames when available, infer names from page metadata when URLs are opaque, and avoid overwriting with stable duplicate handling.
- Shared archive manifest: record source URL, page URL, headers source, original filename, saved path, file size, checksum when practical, and retry status for archive and image downloads.
- Internal rename cleanup: eventually rename package and scripts from `hls_keeper` / HLS Keeper to Web Keeper when it is worth the migration cost.
- Chinese (zh-CN) UI localisation: translate the Dashboard and extension popup into Simplified Chinese, ideally behind a language toggle. The UI is currently Australian English only.
- Study existing video downloader extensions for feature and UX reference, e.g. Video DownloadHelper and CocoCut: media detection UI on the toolbar icon (badge with candidate count), per-tab candidate lists, one-click quality pick, and broader site/format coverage.
