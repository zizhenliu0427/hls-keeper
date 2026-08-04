# Web Keeper

> Current extension development version: **0.4.6**

Web Keeper is a browser-first HLS discovery, direct-download, and assisted-capture tool. The main video flow now runs entirely inside the extension; the legacy Python Dashboard remains available for existing captures, native ffmpeg workflows, and Archive jobs.

[中文文档](README.zh-CN.md)

> Current implementation note: the project directory and Python package are still named `hls-keeper` / `hls_keeper` for compatibility with the existing scripts. The user-facing project name is now **Web Keeper**.

## What It Does

Web Keeper currently has two independent paths:

```text
Default video flow: browser extension -> private resumable workspace -> browser Downloads
Legacy/Archive flow: browser or manual input -> local Python server -> data / archives / outputs
```

The extension observes requests that the browser is already allowed to make and stores candidates and checkpoints locally. By default it finishes and validates media in private extension storage, then hands the finished file to the browser Downloads API. A user-selected custom folder remains available as an advanced alternative. The Python service is no longer required for the core video flow.

Web Keeper does not decrypt DRM, bypass access controls, or grant access to content your browser cannot already load.

## Modules

### Browser Media Engine

The extension identifies and executes direct media files, HLS, DASH/CMAF, and browser-assisted saving:

- discovers ordinary MP4, WebM, and audio responses, including extensionless media URLs;
- streams direct files to disk and resumes from existing bytes when the server supports HTTP Range;
- discovers `.m3u8`, `.ts`, `.key`, and subtitle requests from the browser;
- records playlist, segment, key, subtitle, and checkpoint metadata;
- downloads HLS directly or follows only the segments requested by the player;
- decrypts ordinary AES-128 HLS in the browser;
- joins MPEG-TS and common fragmented MP4 output without requiring the Python service;
- combines separate `EXT-X-MEDIA` audio and video for common static CMAF HLS;
- parses DASH `SegmentTemplate` / `SegmentTimeline`, checkpoints separate tracks, and combines clear CMAF audio and video in the browser;
- saves detected subtitles next to the video.

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

1. Start an isolated Edge test window with the unpacked extension:

```powershell
.\scripts\start_edge.ps1
```

Alternatively, enable Developer mode at `edge://extensions`, choose **Load unpacked**, and select the `extension` directory. Enable listening, play a video, then choose a mode from the popup. Finished files use browser Downloads by default.

No Helper or Python server is required for this flow. Run `.\scripts\start_server.ps1` only when you need the legacy Dashboard, existing captures, Archive, or native ffmpeg tools.

Settings can switch the destination to a custom folder. Chromium may reject system-folder roots in the custom-folder picker; this does not affect the recommended browser Downloads mode.

## Browser Extension

The extension has one listening switch. Discovery never starts a download by itself. After a candidate is found, choose:

- **Direct download (recommended):** parse the playlist, save missing segments with checkpoints, decrypt ordinary AES-128 HLS, and generate a `.ts` or fragmented `.mp4` output.
- **Browser-assisted capture:** conservatively save only the HLS or DASH segments actually requested by the player. Keep the task page open for reliable capture and continue playback. If it closes briefly, recent request metadata is queued for a best-effort retry when the task reopens; browser response bodies are not cached.
- **Ignore this time:** do not create a task.

Detected videos you do not want are dismissable from the download centre: each detection without a download has **Remove this detection**, and a header button clears all of them at once. This only drops the detection record — created downloads, saved files and checkpoints are untouched, and playing the video again detects it again.

The extension never scans or modifies the existing `data/captures` tree. Each new task uses a private resumable workspace or a user-approved custom folder. Temporary HLS pieces have a separate cleanup action. Tasks can also be removed from the download-centre list without deleting saved files or resumable content.

Browser-assisted tasks show missing time ranges. The user-triggered gap filler seeks only those ranges, slows down when the player is not ready, and stops after repeated lack of progress.

Capture follows the quality the player actually uses: while nothing has been saved yet, it switches to the variant playlist that contains the observed segments. Once the first segment is saved the playlist is fixed, so a later quality switch in the player is reported instead of mixing resolutions into one file. Segments that cannot be placed yet are kept and retried after the next playlist update. When the task page cannot fetch a segment itself, it retries the request inside the original page session, which carries that page's cookies, referrer, and origin.

DASH capture works the same way from the MPD: every representation is indexed up front, the first representation the player requests for video and for audio is locked for the task, and both tracks are checkpointed separately and combined into one CMAF MP4. The locked representations are stored with the task, so reopening it keeps the same tracks.

Once assisted saving starts, Web Keeper keeps the media bytes the player already received inside the video page (about 96 MB at most) and saves those bytes directly, falling back to a fresh request only when they are not available. One-time URLs and session-bound authorisation therefore usually succeed. This only covers playback after the task starts: anything played earlier has to be played again. The page is restored and the buffer cleared when the task completes or is removed.

Live streams (a live HLS playlist or a `type="dynamic"` MPD) never finalise on their own; they keep saving until you choose Check and create video.

Assisted tasks can be sped up from the task page. **Playback speed** first tries the page player's own `playbackRate` (2x, 4x, 8x, muted); when a site refuses or caps it, capture falls back to stepping the player forward on a timer. That fallback is configurable: how often to step (0.25–30 s, default 1 s) and how far each step goes (1–120 s, default 10 s). Pausing stops it and continuing restores it.

If saved progress does not move for about 45 seconds, the notice turns red and an alert appears once per stall, reporting the player's current position, whether it is near a gap, and roughly where the next gap starts. Gap filling highlights the range it is working on, warns when the player ends up more than ~20 s away from the target, and reports the next gap when a range is done.

Segments smaller than 188 bytes (one MPEG-TS packet) are never counted as saved. Web Keeper then reads the timestamps of the neighbouring saved segments — a 512 KB sample each, no decoding and no ffmpeg — and decides: if the neighbours already join up, the tiny segment carried no media and is marked skippable, so it is neither retried nor merged; if the gap matches the playlist duration, real content is missing and it stays a gap; anything ambiguous stays a gap as well. Merging skips confirmed skippable items and says how many it skipped.

The same timestamp check watches for a timeline that shifts mid-task, which happens when a long pause is followed by a re-encoded or re-signed source. Web Keeper records a break at that seam, drops stale skippable verdicts, keeps the downloaded segments, and carries on; the merge step re-times the pieces into one file. Seams may still be slightly rough — this is not ffmpeg-grade alignment.

Old `data/captures` folders can be brought into the extension with **Import legacy capture** in the download centre. Pick the captures root, a work folder, or a single quality folder. A work folder usually holds several qualities, so the segment count and size of each are listed first and only the largest is preselected — nothing is imported until you confirm.

The default is to **reference the files in place**: segment records point at your original folder, nothing is copied, it finishes in seconds, and decryption happens on read. The trade-off is that the original folder must stay where it is until the video is created. Tick **Also copy into extension storage** if you need the task to be independent of that folder. Whatever is missing can then be filled with assisted capture as usual.

Capture is still a stream-oriented fallback, not a general network-response recorder. Multi-period DASH and complex separate-track streams still require further validation or adaptation.

## Local Release Package

The development package is `dist/Web-Keeper-0.4.6.zip`. Extract it, enable Developer mode in Edge/Chrome, and choose **Load unpacked**. The archive excludes the experimental Helper and does not require the Python service. The recommended destination uses the browser Downloads API, so it can save to the normal Downloads folder without granting that folder through the File System Access picker.

After changing extension files, reload the extension in Edge/Chrome.

## Video Workflow

Recommended flow:

1. Enable video detection in the extension and play the target video briefly.
2. Open the popup when the `!` badge appears.
3. Choose a quality and either **Direct download (recommended)** or **Web-assisted saving**.
4. The task starts in the extension's private resumable workspace and publishes the validated result to browser Downloads. Choose a custom folder only if you specifically want one.
5. Reopen an interrupted task and select **Continue**; completed bytes or segments are skipped.
6. For an assisted task with gaps, use the missing-time guidance or the user-confirmed gap filler, then create the output.

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

The default extension-only video flow keeps candidates, required request headers, and checkpoints in browser-local storage. It does not contact a remote service or `127.0.0.1`. Only the explicitly started legacy Python Dashboard/Archive flow may send selected URLs and headers to the local service. Those headers may include cookies or authorization tokens. Do not publish or share these legacy files:

- `data/state.json`
- `data/requests.jsonl`
- `data/events.jsonl`
- archive manifests that include private source URLs

## Limitations

Web Keeper is most useful for ordinary HLS streams and normal downloadable attachments. It may not fully handle:

- DRM-protected media;
- sources that intentionally return empty or one-time segments;
- extremely short-lived tokens bound to device fingerprint, IP, or playback session;
- non-CMAF or live HLS with separate audio, and multi-Period or non-standard DASH manifests;
- sites where the real filename is only available through a site-specific API that has not been adapted yet.

## Roadmap

- Browser-captured archive queue: save archive download requests seen by the extension as Dashboard candidates.
- Batch image downloader: capture or scan image resources such as `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.avif`, and `.bmp`; group them by page, title, source site, or user-defined folder rule.
- Image filename and folder rules: preserve original filenames when available, infer names from page metadata when URLs are opaque, and avoid overwriting with stable duplicate handling.
- Shared archive manifest: record source URL, page URL, headers source, original filename, saved path, file size, checksum when practical, and retry status for archive and image downloads.
- Internal rename cleanup: eventually rename package and scripts from `hls_keeper` / HLS Keeper to Web Keeper when it is worth the migration cost.
- Broaden real-site fixtures and add focused adapters only where the generic parser and authorization refresh path cannot cover a site.
- Study existing video downloader extensions for feature and UX reference, e.g. Video DownloadHelper and CocoCut: media detection UI on the toolbar icon (badge with candidate count), per-tab candidate lists, one-click quality pick, and broader site/format coverage.
