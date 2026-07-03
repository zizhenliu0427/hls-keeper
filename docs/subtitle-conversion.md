# Subtitle Conversion

HLS Keeper can keep the original CC/subtitle file and write converted copies next to it.

Supported modes:

- `none`: keep the original subtitle only.
- `zh-hans`: Traditional Chinese to Simplified Chinese, output suffix `*.zh-hans.vtt/srt/...`.
- `zh-hant`: Simplified Chinese to Traditional Chinese, output suffix `*.zh-hant.vtt/srt/...`.
- `en-us`: British English spelling to American English spelling, output suffix `*.en-us.vtt/srt/...`.
- `en-gb`: American English spelling to British English spelling, output suffix `*.en-gb.vtt/srt/...`.

Converted files are saved under:

```text
data/captures/<video>/<resolution>/subtitles/
```

In the Dashboard, choose a mode from `CC convert`.

- Direct m3u8 downloads apply the selected conversion after subtitles are downloaded.
- Existing subtitles can be converted later with the `Convert CC` button on the stream row.

Chinese conversion prefers OpenCC when it is installed. If OpenCC is not available, HLS Keeper uses its built-in common mapping.

The project dependency file installs the compatible Python package:

```powershell
.\scripts\install_requirements.ps1
```

## Custom Dictionary

You can add your own phrase overrides in:

```text
data/subtitle_dictionary.json
```

Start from:

```text
data/subtitle_dictionary.example.json
```

Schema:

```json
{
  "zh-hans": {
    "後臺": "后台"
  },
  "zh-hant": {
    "后台": "後臺"
  },
  "en-us": {
    "subtitles": "captions"
  },
  "en-gb": {
    "captions": "subtitles"
  }
}
```

Custom dictionary replacements run after the normal OpenCC/spelling conversion, so they can be used for names, site-specific terms, and personal preferences.

Manual API example:

```powershell
Invoke-RestMethod http://127.0.0.1:17888/api/convert-subtitles `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"product":"mizd00509","resolution":"1280x720","mode":"zh-hans"}'
```
