from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


class MediaEngineTests(unittest.TestCase):
    def run_node(self, source: str) -> dict:
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is not available")
        completed = subprocess.run(
            [node, "-e", source],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        return json.loads(completed.stdout)

    def test_hls_parser_normalizes_ranges_timeline_and_subtitles(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const text = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:40
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="zh",NAME="中文",DEFAULT=YES,URI="sub/zh.vtt"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-MAP:URI="media.mp4",BYTERANGE="100@0"
#EXTINF:4.5,
#EXT-X-BYTERANGE:200@100
media.mp4
#EXTINF:5.5,
#EXT-X-BYTERANGE:300
media.mp4
#EXT-X-ENDLIST`;
const p = e.parseHlsPlaylist(text, 'https://example.test/a/index.m3u8');
console.log(JSON.stringify(p));
"""
        parsed = self.run_node(source)
        self.assertEqual(40, parsed["mediaSequence"])
        self.assertEqual("200@100", parsed["segments"][0]["byteRange"])
        self.assertEqual("300@300", parsed["segments"][1]["byteRange"])
        self.assertEqual(4.5, parsed["segments"][1]["startSeconds"])
        self.assertEqual(10, parsed["duration"])
        self.assertFalse(parsed["isLive"])
        self.assertEqual("https://example.test/a/sub/zh.vtt", parsed["subtitles"][0]["url"])
        self.assertEqual("https://example.test/a/audio/en.m3u8", parsed["audios"][0]["url"])

    def test_hls_parser_marks_live_gap_and_range_header(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const text = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:8
#EXT-X-GAP
#EXTINF:2,
gone.ts
#EXTINF:2,
ok.ts`;
const p = e.parseHlsPlaylist(text, 'https://example.test/live/index.m3u8');
console.log(JSON.stringify({isLive:p.isLive, gap:p.segments[0].gap, range:e.rangeHeader('300@120')}));
"""
        parsed = self.run_node(source)
        self.assertTrue(parsed["isLive"])
        self.assertTrue(parsed["gap"])
        self.assertEqual("bytes=120-419", parsed["range"])

    def test_hls_parser_attaches_encryption_to_initialization_map(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const text = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4,
part.m4s
#EXT-X-ENDLIST`;
const p = e.parseHlsPlaylist(text, 'https://example.test/v/index.m3u8');
console.log(JSON.stringify(p.map));
"""
        parsed = self.run_node(source)
        self.assertEqual("https://example.test/v/key.bin", parsed["key"]["url"])
        self.assertEqual("0x00000000000000000000000000000001", parsed["key"]["iv"])

    def test_dash_parser_expands_timeline_and_selects_tracks(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const text = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT10S">
  <BaseURL>cdn/</BaseURL>
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" initialization="v/$RepresentationID$/init.mp4" media="v/$RepresentationID$/$Time$.m4s">
        <SegmentTimeline><S t="0" d="2000" r="4"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="720" bandwidth="2000000" width="1280" height="720" codecs="avc1.64001f"/>
      <Representation id="1080" bandwidth="4000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="zh">
      <SegmentTemplate timescale="48000" duration="96000" startNumber="1" initialization="a/init.mp4" media="a/$Number%03d$.m4s"/>
      <Representation id="audio" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;
const p = e.parseDashManifest(text, 'https://example.test/path/manifest.mpd');
const selected = e.selectDashTracks(p, 720);
console.log(JSON.stringify({p, selected}));
"""
        result = self.run_node(source)
        manifest = result["p"]
        self.assertFalse(manifest["drm"])
        self.assertEqual(3, len(manifest["tracks"]))
        self.assertEqual(5, len(manifest["tracks"][0]["segments"]))
        self.assertEqual("https://example.test/path/cdn/v/720/2000.m4s", manifest["tracks"][0]["segments"][1]["url"])
        self.assertEqual("720", result["selected"][0]["id"])
        self.assertEqual("audio", result["selected"][1]["id"])
        self.assertEqual("https://example.test/path/cdn/a/001.m4s", result["selected"][1]["segments"][0]["url"])

    def test_dash_capture_index_maps_observed_requests_to_representations(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const text = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT10S">
  <BaseURL>cdn/</BaseURL>
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" initialization="v/$RepresentationID$/init.mp4" media="v/$RepresentationID$/$Time$.m4s">
        <SegmentTimeline><S t="0" d="2000" r="4"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="720" bandwidth="2000000" width="1280" height="720" codecs="avc1.64001f"/>
      <Representation id="1080" bandwidth="4000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="zh">
      <SegmentTemplate timescale="48000" duration="96000" startNumber="1" initialization="a/init.mp4" media="a/$Number%03d$.m4s"/>
      <Representation id="audio" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;
const index = e.dashCaptureIndex(e.parseDashManifest(text, 'https://example.test/path/manifest.mpd'));
console.log(JSON.stringify({
  trackCount: index.tracks.length,
  lowQuality: index.find('https://example.test/path/cdn/v/720/4000.m4s'),
  highQuality: index.find('https://example.test/path/cdn/v/1080/4000.m4s'),
  withToken: index.find('https://example.test/path/cdn/a/002.m4s?token=fresh'),
  initialization: index.find('https://example.test/path/cdn/a/init.mp4'),
  unrelated: index.find('https://other.test/ads/clip.m4s'),
  audioContentType: index.track('audio')?.contentType ?? null
}));
"""
        result = self.run_node(source)
        self.assertEqual(3, result["trackCount"])
        self.assertEqual({"trackId": "720", "index": 2, "kind": "segment"}, result["lowQuality"])
        self.assertEqual({"trackId": "1080", "index": 2, "kind": "segment"}, result["highQuality"])
        self.assertEqual({"trackId": "audio", "index": 1, "kind": "segment"}, result["withToken"])
        self.assertEqual("initialization", result["initialization"]["kind"])
        self.assertIsNone(result["unrelated"])
        self.assertEqual("audio", result["audioContentType"])

    def test_dash_capture_tracks_keep_positions_when_the_window_moves(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const previous = [{ id: 'v', contentType: 'video', segments: [
  { url: 'https://cdn.test/v/1.m4s' }, { url: 'https://cdn.test/v/2.m4s' }, { url: 'https://cdn.test/v/3.m4s' }
] }];
const refreshed = [{ id: 'v', contentType: 'video', segments: [
  { url: 'https://cdn.test/v/3.m4s' }, { url: 'https://cdn.test/v/4.m4s' }, { url: 'https://cdn.test/v/5.m4s' }
] }, { id: 'a', contentType: 'audio', segments: [{ url: 'https://cdn.test/a/1.m4s' }] }];
const merged = e.mergeDashCaptureTracks(previous, refreshed);
const index = e.dashCaptureIndex({ tracks: merged });
console.log(JSON.stringify({
  urls: merged[0].segments.map((item) => item.url),
  firstStillIndexZero: index.find('https://cdn.test/v/1.m4s'),
  newSegment: index.find('https://cdn.test/v/5.m4s'),
  audioKept: merged[1].segments.length
}));
"""
        result = self.run_node(source)
        # A rolling window must not renumber segments that were already saved.
        self.assertEqual(
            [f"https://cdn.test/v/{number}.m4s" for number in (1, 2, 3, 4, 5)],
            result["urls"],
        )
        self.assertEqual({"trackId": "v", "index": 0, "kind": "segment"}, result["firstStillIndexZero"])
        self.assertEqual({"trackId": "v", "index": 4, "kind": "segment"}, result["newSegment"])
        self.assertEqual(1, result["audioKept"])

    def test_dash_parser_collects_whole_file_subtitles_and_skips_segmented_text(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const text = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT10S">
  <BaseURL>cdn/</BaseURL>
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" initialization="v/init.mp4" media="v/$Number$.m4s" duration="2000" startNumber="1"/>
      <Representation id="v" bandwidth="900000" width="640" height="360"/>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="zh">
      <Representation id="sub-zh"><BaseURL>subs/zh.vtt</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="application/mp4" codecs="stpp" lang="en">
      <SegmentTemplate timescale="1000" initialization="t/init.mp4" media="t/$Number$.m4s" duration="2000"/>
      <Representation id="sub-en"/>
    </AdaptationSet>
  </Period>
</MPD>`;
const p = e.parseDashManifest(text, 'https://example.test/path/manifest.mpd');
console.log(JSON.stringify({
  subtitles: p.subtitles,
  trackIds: p.tracks.map((item) => item.id),
  captureTrackIds: e.dashCaptureIndex(p).tracks.map((item) => item.id)
}));
"""
        result = self.run_node(source)
        whole_file, segmented = result["subtitles"]
        self.assertEqual("https://example.test/path/cdn/subs/zh.vtt", whole_file["url"])
        self.assertEqual("zh", whole_file["language"])
        self.assertFalse(whole_file["segmented"])
        # Segmented text needs an stpp/wvtt extractor we do not have; it must be reported, not guessed at.
        self.assertTrue(segmented["segmented"])
        self.assertEqual("", segmented["url"])
        # Text adaptation sets must never end up as downloadable media tracks.
        self.assertEqual(["v"], result["trackIds"])
        self.assertEqual(["v"], result["captureTrackIds"])

    def test_dash_parser_detects_drm(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const text = `<MPD mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="video/mp4">
<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
<SegmentTemplate duration="2" media="$Number$.m4s"/><Representation id="v"/>
</AdaptationSet></Period></MPD>`;
console.log(JSON.stringify(e.parseDashManifest(text, 'https://example.test/a.mpd')));
"""
        parsed = self.run_node(source)
        self.assertTrue(parsed["drm"])

    def test_cmaf_merger_rewrites_audio_track_ids(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
function full(type, length, trackOffset, trackId) {
  const payload = new Uint8Array(length);
  if (trackOffset != null) new DataView(payload.buffer).setUint32(trackOffset, trackId);
  return e.makeMp4Box(type, [payload]);
}
function init(trackId) {
  const ftyp = e.makeMp4Box('ftyp', [new Uint8Array([105,115,111,54,0,0,0,1])]);
  const mvhd = full('mvhd', 100, 96, trackId + 1);
  const tkhd = full('tkhd', 100, 12, trackId);
  const trak = e.makeMp4Box('trak', [tkhd]);
  const trex = full('trex', 24, 4, trackId);
  const mvex = e.makeMp4Box('mvex', [trex]);
  return e.concatBytes([ftyp, e.makeMp4Box('moov', [mvhd, trak, mvex])]);
}
const merged = e.mergeCmafInitializations(init(1), init(1));
const tfhd = full('tfhd', 12, 4, 1);
const fragment = e.makeMp4Box('moof', [e.makeMp4Box('traf', [tfhd])]);
const patched = e.patchCmafFragmentTrackId(fragment, 1, merged.audioTrackId);
const moof = e.mp4Boxes(patched)[0];
const traf = e.mp4Boxes(patched, moof.dataStart, moof.end)[0];
const tfhdBox = e.mp4Boxes(patched, traf.dataStart, traf.end)[0];
const patchedId = new DataView(patched.buffer, patched.byteOffset, patched.byteLength).getUint32(tfhdBox.dataStart + 4);
console.log(JSON.stringify({audioTrackId: merged.audioTrackId, patchedId, mergedSize: merged.bytes.byteLength}));
"""
        result = self.run_node(source)
        self.assertEqual(2, result["audioTrackId"])
        self.assertEqual(2, result["patchedId"])
        self.assertGreater(result["mergedSize"], 200)

    def test_mp4_unknown_duration_is_replaced_with_playlist_duration(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
function full(type, length) { return e.makeMp4Box(type, [new Uint8Array(length)]); }
const mvhd = full('mvhd', 100);
const tkhd = full('tkhd', 84);
const mdhd = full('mdhd', 24);
const mdia = e.makeMp4Box('mdia', [mdhd]);
const trak = e.makeMp4Box('trak', [tkhd, mdia]);
const init = e.makeMp4Box('moov', [mvhd, trak]);
const view = new DataView(init.buffer);
let moov = e.mp4Boxes(init)[0];
let children = e.mp4Boxes(init, moov.dataStart, moov.end);
let mvhdBox = children.find((box) => box.type === 'mvhd');
view.setUint32(mvhdBox.dataStart + 12, 90000);
view.setUint32(mvhdBox.dataStart + 16, 0xffffffff);
let trakBox = children.find((box) => box.type === 'trak');
let trakChildren = e.mp4Boxes(init, trakBox.dataStart, trakBox.end);
let tkhdBox = trakChildren.find((box) => box.type === 'tkhd');
view.setUint32(tkhdBox.dataStart + 20, 0xffffffff);
let mdiaBox = trakChildren.find((box) => box.type === 'mdia');
let mdhdBox = e.mp4Boxes(init, mdiaBox.dataStart, mdiaBox.end)[0];
view.setUint32(mdhdBox.dataStart + 12, 48000);
view.setUint32(mdhdBox.dataStart + 16, 0xffffffff);
const patched = e.patchMp4InitDuration(init, 3680.575);
const patchedView = new DataView(patched.buffer);
console.log(JSON.stringify({
  movie: patchedView.getUint32(mvhdBox.dataStart + 16),
  track: patchedView.getUint32(tkhdBox.dataStart + 20),
  media: patchedView.getUint32(mdhdBox.dataStart + 16)
}));
"""
        result = self.run_node(source)
        self.assertEqual(round(3680.575 * 90000), result["movie"])
        self.assertEqual(round(3680.575 * 90000), result["track"])
        self.assertEqual(round(3680.575 * 48000), result["media"])

    def test_media_error_classification(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
console.log(JSON.stringify([
  e.classifyMediaError(new Error('HTTP 403')),
  e.classifyMediaError(new Error('HTTP 410')),
  e.classifyMediaError(new Error('HTTP 429')),
  e.classifyMediaError(new Error('DRM protected'))
]));
"""
        result = self.run_node(source)
        self.assertEqual(["AUTH_REQUIRED", "URL_EXPIRED", "RATE_LIMITED", "DRM_DETECTED"], result)

    def test_missing_timeline_groups_adjacent_segments(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const segments = Array.from({length: 6}, (_, i) => ({sequence: 10+i, startSeconds:i*4, endSeconds:(i+1)*4}));
console.log(JSON.stringify(e.missingTimeline(segments, new Set([10, 13, 15]))));
"""
        result = self.run_node(source)
        self.assertEqual(2, len(result))
        self.assertEqual({"sequenceFrom": 11, "sequenceTo": 12, "startSeconds": 4, "endSeconds": 12, "count": 2}, result[0])
        self.assertEqual(14, result[1]["sequenceFrom"])

    def test_missing_timeline_excludes_skippable_sequences(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const segments = Array.from({length: 5}, (_, i) => ({sequence: i, startSeconds:i*4, endSeconds:(i+1)*4}));
console.log(JSON.stringify(e.missingTimeline(segments, new Set([0, 2, 4]), new Set([1]))));
"""
        result = self.run_node(source)
        self.assertEqual(1, len(result))
        self.assertEqual(3, result[0]["sequenceFrom"])

    def test_transport_timestamp_continuity_assessment(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
function writePts(bytes, offset, pts) {
  bytes[offset] = 0x20 | (((pts / 0x40000000) & 7) << 1) | 1;
  bytes[offset + 1] = (pts >>> 22) & 0xff;
  bytes[offset + 2] = (((pts >>> 15) & 0x7f) << 1) | 1;
  bytes[offset + 3] = (pts >>> 7) & 0xff;
  bytes[offset + 4] = ((pts & 0x7f) << 1) | 1;
}
function tsWithPts(pts) {
  const packet = new Uint8Array(188);
  packet[0] = 0x47;
  packet[1] = 0x41; // payload start, pid 0x0100 high nibble-ish
  packet[2] = 0x00;
  packet[3] = 0x10;
  packet[4] = 0x00; packet[5] = 0x00; packet[6] = 0x01; packet[7] = 0xe0;
  packet[8] = 0x00; packet[9] = 0x00;
  packet[10] = 0x80; packet[11] = 0x80; packet[12] = 0x05;
  writePts(packet, 13, pts);
  const out = new Uint8Array(188 * 3);
  out.set(packet, 0);
  out.set(packet, 188);
  out.set(packet, 376);
  return out;
}
const prev = e.transportTimestamps(tsWithPts(90_000 * 10));
const nextClose = e.transportTimestamps(tsWithPts(90_000 * 10 + 3_000));
const nextGap = e.transportTimestamps(tsWithPts(90_000 * 14));
const skippable = e.assessSkippedSegmentContinuity({
  previousLastPts: prev.lastPts, nextFirstPts: nextClose.firstPts, expectedDurationSeconds: 4
});
const needed = e.assessSkippedSegmentContinuity({
  previousLastPts: prev.lastPts, nextFirstPts: nextGap.firstPts, expectedDurationSeconds: 4
});
console.log(JSON.stringify({ prevOk: prev.ok, skippable, needed }));
"""
        result = self.run_node(source)
        self.assertTrue(result["prevOk"])
        self.assertEqual("skippable", result["skippable"]["status"])
        self.assertEqual("needed", result["needed"]["status"])

    def test_adjacent_segment_continuity_detects_timeline_shift(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const ok = e.assessAdjacentSegmentContinuity({
  previousLastPts: 90_000 * 10, nextFirstPts: 90_000 * 10 + 3_000, previousDurationSeconds: 4
});
const reset = e.assessAdjacentSegmentContinuity({
  previousLastPts: 90_000 * 100, nextFirstPts: 90_000 * 2, previousDurationSeconds: 4
});
const jump = e.assessAdjacentSegmentContinuity({
  previousLastPts: 90_000 * 10, nextFirstPts: 90_000 * 40, previousDurationSeconds: 4
});
const marked = e.assessAdjacentSegmentContinuity({
  previousLastPts: 90_000 * 10, nextFirstPts: 90_000 * 2, previousDurationSeconds: 4, playlistDiscontinuity: true
});
console.log(JSON.stringify({ ok, reset, jump, marked }));
"""
        result = self.run_node(source)
        self.assertEqual("ok", result["ok"]["status"])
        self.assertEqual("shifted", result["reset"]["status"])
        self.assertEqual("shifted", result["jump"]["status"])
        self.assertEqual("ok", result["marked"]["status"])

    def test_segment_lookup_separates_query_only_urls_and_refuses_other_qualities(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const queryOnly = e.parseHlsPlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4,
chunk?id=1
#EXTINF:4,
chunk?id=2
#EXT-X-ENDLIST`, 'https://cdn.test/480p/index.m3u8');
const named = e.parseHlsPlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4,
seg_0.ts
#EXTINF:4,
seg_1.ts
#EXT-X-ENDLIST`, 'https://cdn.test/480p/index.m3u8');
const byQuery = e.segmentLookup(queryOnly.segments);
const byName = e.segmentLookup(named.segments);
console.log(JSON.stringify({
  exactQuery: byQuery.exact('https://cdn.test/480p/chunk?id=2')?.sequence ?? null,
  otherQuality: byQuery.find('https://cdn.test/720p/chunk?id=2'),
  otherQualitySameName: byName.find('https://cdn.test/720p/seg_1.ts'),
  freshToken: byName.find('https://cdn.test/480p/seg_1.ts?token=late')?.sequence ?? null,
  unlistedNeighbour: byName.find('https://cdn.test/480p/seg_1.ts')?.sequence ?? null
}));
"""
        result = self.run_node(source)
        self.assertEqual(1, result["exactQuery"])
        self.assertIsNone(result["otherQuality"])
        self.assertIsNone(result["otherQualitySameName"])
        self.assertEqual(1, result["freshToken"])
        self.assertEqual(1, result["unlistedNeighbour"])

    def test_protobuf_and_jwt_helpers_recover_the_subtitle_viewer_id(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const payload = 'U29tZUNpcGhlcg==';
const bytes = new Uint8Array([0x0a, payload.length, ...Buffer.from(payload)]);
const jwt = 'h.' + Buffer.from(JSON.stringify({ uid: 987654 })).toString('base64url') + '.s';
console.log(JSON.stringify({
  field: e.protobufStringField(bytes, 1),
  missingField: e.protobufStringField(bytes, 2),
  fromHeader: e.subtitleUserIdFromHeaders({ authorization: 'Bearer ' + jwt }),
  fromCookie: e.subtitleUserIdFromHeaders({ cookie: 'a=1; access_token=' + jwt }),
  none: e.subtitleUserIdFromHeaders({ cookie: 'a=1' })
}));
"""
        result = self.run_node(source)
        self.assertEqual("U29tZUNpcGhlcg==", result["field"])
        self.assertIsNone(result["missingField"])
        self.assertEqual("987654", result["fromHeader"])
        self.assertEqual("987654", result["fromCookie"])
        self.assertIsNone(result["none"])

    def test_subtitle_conversion_and_segmented_timeline(self) -> None:
        newline = chr(92) + "n"
        source = """
const e = require('./extension/media-engine.js');
const parts = [
  'WEBVTT@X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000@@00:00:01.000 --> 00:00:03.000@first',
  'WEBVTT@X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:1800000@@00:00:01.000 --> 00:00:03.000@second'
];
console.log(JSON.stringify({
  hans: e.convertSubtitleText('\u9019\u500b\u756b\u8cea\u5f88\u597d\uff0c\u8acb\u9ede\u9078', 'zh-hans'),
  hant: e.convertSubtitleText('\u8fd9\u4e2a\u753b\u8d28\u5f88\u597d', 'zh-hant'),
  us: e.convertSubtitleText('The Colour of the theatre', 'en-us'),
  gb: e.convertSubtitleText('The color of the theater', 'en-gb'),
  untouched: e.convertSubtitleText('unchanged text', 'none'),
  merged: e.mergeWebVttParts(parts)
}));
""".replace("@", newline)
        result = self.run_node(source)
        self.assertEqual("\u8fd9\u4e2a\u753b\u8d28\u5f88\u597d\uff0c\u8bf7\u70b9\u9009", result["hans"])
        self.assertEqual("\u9019\u500b\u756b\u8cea\u5f88\u597d", result["hant"])
        # Capitalisation must survive the spelling swap.
        self.assertEqual("The Color of the theater", result["us"])
        self.assertEqual("The colour of the theatre", result["gb"])
        self.assertEqual("unchanged text", result["untouched"])
        # The second part is anchored 10s later (MPEGTS delta 900000 / 90kHz), so its cue moves.
        self.assertIn("00:00:01.000 --> 00:00:03.000", result["merged"])
        self.assertIn("00:00:11.000 --> 00:00:13.000", result["merged"])
        self.assertNotIn("X-TIMESTAMP-MAP", result["merged"])

    def test_srt_conversion_and_unconverted_chinese_reporting(self) -> None:
        newline = chr(92) + "n"
        source = """
const e = require('./extension/media-engine.js');
const vtt = 'WEBVTT@@NOTE hi@@1@00:00:01.500 --> 00:00:03.250 align:start@<b>Hello</b> there@@00:01:02.000 --> 00:01:04.000@later';
console.log(JSON.stringify({
  srt: e.webVttToSrt(vtt),
  unmapped: e.unconvertedChineseCount('\u9019\u500b\u8996\u983b', 'zh-hans'),
  none: e.unconvertedChineseCount('\u9019\u500b', 'none')
}));
""".replace("@", newline)
        result = self.run_node(source)
        self.assertIn("00:00:01,500 --> 00:00:03,250", result["srt"])
        self.assertIn("Hello there", result["srt"])
        self.assertNotIn("align:start", result["srt"])
        self.assertNotIn("WEBVTT", result["srt"])
        self.assertTrue(result["srt"].startswith("1"))
        # The built-in table has no rule for these two, which is what the warning reports.
        self.assertEqual(2, result["unmapped"])
        self.assertEqual(0, result["none"])

    def test_subtitle_parts_merge_without_duplicates(self) -> None:
        # The player fetches the track in chunks that overlap at the seams and arrive in
        # whatever order the requests were recorded, so merging must dedupe and re-sort.
        newline = chr(92) + "n"
        source = """
const e = require('./extension/media-engine.js');
const later = 'WEBVTT@@00:05:00.000 --> 00:05:02.000@third@@00:02:30.000 --> 00:02:32.000@second';
const early = 'WEBVTT@@00:00:01.000 --> 00:00:02.000@first@@00:02:30.000 --> 00:02:32.000@second';
const merged = e.mergeVttDocuments([later, early]);
console.log(JSON.stringify({
  merged,
  headers: (merged.match(/WEBVTT/g) || []).length,
  seconds: (merged.match(/^second$/gm) || []).length,
  order: (merged.match(/^(?:first|second|third)$/gm) || [])
}));
""".replace("@", newline)
        result = self.run_node(source)
        self.assertEqual(1, result["headers"])
        self.assertEqual(1, result["seconds"])
        self.assertEqual(["first", "second", "third"], result["order"])

    def test_subtitle_paging_is_inferred_and_extrapolated(self) -> None:
        # Two recorded calls differ only in their window, which is what makes the rest of the
        # track requestable without replaying playback.
        source = r"""
const e = require('./extension/media-engine.js');
function varint(value) { const out = []; let rest = value; do { const part = rest % 128; rest = Math.floor(rest / 128); out.push(rest > 0 ? part | 0x80 : part); } while (rest > 0); return out; }
// field 1 = start (varint), field 2 = end (varint), field 3 = "vid" (string)
function body(start, end) { return Uint8Array.from([0x08, ...varint(start), 0x10, ...varint(end), 0x1a, 3, 118, 105, 100]); }
const paging = e.inferSubtitlePaging([body(0, 300), body(300, 600)]);
const next = paging.fields.reduce((bytes, field) => e.protobufSetVarint(bytes, field.field, field.max + paging.step), body(300, 600));
const framed = e.grpcWebFrame(next);
console.log(JSON.stringify({
  paging,
  // 300 needs two varint bytes where 0 needed one, so the message must have been rebuilt.
  fields: e.protobufVarintFields(next),
  id: e.protobufStringField(next, 3),
  framedPrefix: Array.from(framed.subarray(0, 5)),
  roundTrip: e.protobufVarintFields(e.grpcWebPayload(framed)),
  ambiguous: e.inferSubtitlePaging([body(0, 300), body(300, 900)]),
  single: e.inferSubtitlePaging([body(0, 300)])
}));
"""
        result = self.run_node(source)
        self.assertEqual(300, result["paging"]["step"])
        self.assertEqual([{"field": 1, "max": 300}, {"field": 2, "max": 600}], result["paging"]["fields"])
        self.assertEqual({"1": 600, "2": 900}, result["fields"])
        # Rebuilding the message must not disturb the other fields.
        self.assertEqual("vid", result["id"])
        # 1+2 (start) + 1+2 (end) + 1+1+3 (id) = 11 bytes, declared in the 5-byte gRPC-Web prefix.
        self.assertEqual([0, 0, 0, 0, 11], result["framedPrefix"])
        self.assertEqual({"1": 600, "2": 900}, result["roundTrip"])
        # Fields moving at different rates, or a single call, give nothing safe to extrapolate.
        self.assertIsNone(result["ambiguous"])
        self.assertIsNone(result["single"])

    def test_grpc_web_text_frames_are_decoded_when_concatenated(self) -> None:
        # grpc-web-text base64-encodes each frame separately, so "=" padding lands in the middle
        # and atob() over the whole string throws. Falling back to the raw text made a good
        # 241 kB reply look like an unknown format.
        source = r"""
const e = require('./extension/media-engine.js');
function field(number, text) { const body = Buffer.from(text, 'utf8'); return [number * 8 + 2, body.length, ...body]; }
function frame(bytes) { return [0, 0, 0, (bytes.length >>> 8) & 255, bytes.length & 255, ...bytes]; }
const one = Buffer.from(frame(field(1, 'first-message'))).toString('base64');
const two = Buffer.from(frame(field(1, 'second'))).toString('base64');
// Each frame is padded on its own; the concatenation is not valid base64.
const wire = Uint8Array.from(Buffer.from(one + two, 'utf8'));
console.log(JSON.stringify({
  padded: one.includes('=') || two.includes('='),
  values: e.grpcWebPayloads(wire).map((f) => e.protobufStringField(f, 1)),
  wholeStringFails: (() => { try { atob(one + two); return false; } catch { return true; } })()
}));
"""
        result = self.run_node(source)
        self.assertTrue(result["padded"], "the fixture must reproduce mid-string padding")
        self.assertTrue(result["wholeStringFails"], "the fixture must be undecodable in one atob call")
        self.assertEqual(["first-message", "second"], result["values"])

    def test_segment_index_is_a_well_formed_sidx(self) -> None:
        # A fragmented MP4 with no index forces a player to walk every fragment before it can
        # start, which on a network share is minutes. The box is parsed back the way a player
        # reads it, per ISO/IEC 14496-12 8.16.3 — the version-1 header is 40 bytes, and getting
        # that wrong is exactly the mistake this catches.
        source = r"""
const e = require('./extension/media-engine.js');
const refs = [{ size: 1000, duration: 180000 }, { size: 2500, duration: 90000 }, { size: 4096, duration: 90000 }];
const box = e.buildSidx(refs, { timescale: 90000, firstOffset: 252 });
const view = new DataView(box.buffer, box.byteOffset, box.byteLength);
const parsed = [];
const count = view.getUint16(38);
for (let i = 0; i < count; i += 1) {
  const at = 40 + i * 12;
  const word = view.getUint32(at);
  const flags = view.getUint32(at + 8);
  parsed.push({ type: word >>> 31, size: word & 0x7fffffff, duration: view.getUint32(at + 4), sap: flags >>> 31, sapType: (flags >>> 28) & 7 });
}
const free = e.buildFreeBox(64);
const plain = e.buildSidx(refs);
const plainView = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
console.log(JSON.stringify({
  name: String.fromCharCode.apply(null, Array.from(box.subarray(4, 8))),
  declared: view.getUint32(0),
  actual: box.byteLength,
  helper: e.sidxByteLength(refs.length),
  version: view.getUint8(8),
  timescale: view.getUint32(16),
  firstOffset: Number(view.getBigUint64(28)),
  defaultFirstOffset: Number(plainView.getBigUint64(28)),
  count,
  parsed,
  freeName: String.fromCharCode.apply(null, Array.from(free.subarray(4, 8))),
  freeSize: new DataView(free.buffer).getUint32(0)
}));
"""
        result = self.run_node(source)
        self.assertEqual("sidx", result["name"])
        self.assertEqual(result["actual"], result["declared"], "declared size must match the buffer")
        self.assertEqual(result["actual"], result["helper"], "reserved space must match what is written")
        self.assertEqual(40 + 3 * 12, result["actual"])
        self.assertEqual(1, result["version"])
        self.assertEqual(90000, result["timescale"])
        # Export pads a free box after sidx; first_offset must be that gap, not always 0.
        self.assertEqual(252, result["firstOffset"])
        self.assertEqual(0, result["defaultFirstOffset"])
        self.assertEqual(3, result["count"])
        self.assertEqual([1000, 2500, 4096], [item["size"] for item in result["parsed"]])
        self.assertEqual([180000, 90000, 90000], [item["duration"] for item in result["parsed"]])
        # reference_type 0 means media; every fragment starts at a keyframe (SAP type 1).
        self.assertEqual([0, 0, 0], [item["type"] for item in result["parsed"]])
        self.assertEqual([1, 1, 1], [item["sap"] for item in result["parsed"]])
        self.assertEqual([1, 1, 1], [item["sapType"] for item in result["parsed"]])
        self.assertEqual("free", result["freeName"])
        self.assertEqual(64, result["freeSize"])

    def test_streaming_reply_and_repeated_fields_are_read_whole(self) -> None:
        # A server-streaming gRPC-Web reply is several DATA frames in one response, and one frame
        # can repeat the payload field. Reading only the first of either truncates the track.
        source = r"""
const e = require('./extension/media-engine.js');
function field(number, text) { const body = Buffer.from(text, 'utf8'); return [number * 8 + 2, body.length, ...body]; }
function frame(bytes) { return [0, (bytes.length >>> 24) & 255, (bytes.length >>> 16) & 255, (bytes.length >>> 8) & 255, bytes.length & 255, ...bytes]; }
const first = [...field(1, 'alpha'), ...field(1, 'beta')];
const second = [...field(1, 'gamma')];
// Frames 1 and 2 carry data; the third is a trailer and must be skipped.
const trailer = [128, 0, 0, 0, 2, 65, 66];
const response = Uint8Array.from([...frame(first), ...frame(second), ...trailer]);
const frames = e.grpcWebPayloads(response);
console.log(JSON.stringify({
  frameCount: frames.length,
  repeated: frames.map((f) => e.protobufStringFields(f, 1)),
  firstOnly: e.protobufStringField(frames[0], 1),
  legacy: e.protobufStringField(e.grpcWebPayload(response), 1),
  notFramed: e.grpcWebPayloads(Uint8Array.from(field(1, 'plain'))).length
}));
"""
        result = self.run_node(source)
        self.assertEqual(2, result["frameCount"])
        self.assertEqual([["alpha", "beta"], ["gamma"]], result["repeated"])
        # The single-value accessors still behave as before, so existing callers are unaffected.
        self.assertEqual("alpha", result["firstOnly"])
        self.assertEqual("alpha", result["legacy"])
        # An unframed body is still returned as one payload rather than dropped.
        self.assertEqual(1, result["notFramed"])

    def test_single_call_yields_ordered_paging_probes(self) -> None:
        # With one recorded call there is nothing to difference, so the cursor has to be guessed
        # and then verified. The guesses must be ordered so the likeliest shape costs one request.
        source = r"""
const e = require('./extension/media-engine.js');
function varint(value) { const out = []; let rest = value; do { const part = rest % 128; rest = Math.floor(rest / 128); out.push(rest > 0 ? part | 0x80 : part); } while (rest > 0); return out; }
// field 1 = 0 (position), field 2 = 7 (some flag), field 3 = "vid"
const payload = Uint8Array.from([0x08, ...varint(0), 0x10, ...varint(7), 0x1a, 3, 118, 105, 100]);
const span = e.subtitleCueSpan('WEBVTT\n\n00:00:02.000 --> 00:00:04.000\na\n\n00:04:58.000 --> 00:05:02.000\nb');
console.log(JSON.stringify({
  span,
  probes: e.subtitlePagingProbes(payload, span),
  empty: e.subtitleCueSpan('WEBVTT').count
}));
"""
        result = self.run_node(source)
        self.assertEqual(2, result["span"]["start"])
        self.assertEqual(302, result["span"]["end"])
        self.assertEqual(2, result["span"]["count"])
        # A 300s chunk: seconds first, then milliseconds, then a plain page index, and the string
        # field is never probed because it cannot be a varint cursor.
        self.assertEqual([300, 300, 300000, 300000, 1, 1], [probe["step"] for probe in result["probes"]])
        self.assertEqual([1, 2, 1, 2, 1, 2], [probe["field"] for probe in result["probes"]])
        self.assertEqual([300, 307, 300000, 300007, 1, 8], [probe["value"] for probe in result["probes"]])
        self.assertEqual(0, result["empty"])

    def test_grpc_web_framing_is_unwrapped_before_protobuf(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const payload = 'QUJDREVGRw==';
const message = Buffer.concat([Buffer.from([0x0a, payload.length]), Buffer.from(payload)]);
const frame = Buffer.concat([Buffer.from([0x00, 0, 0, 0, message.length]), message]);
const trailer = Buffer.concat([Buffer.from([0x80, 0, 0, 0, 4]), Buffer.from('abcd')]);
const framed = new Uint8Array(Buffer.concat([frame, trailer]));
console.log(JSON.stringify({
  framed: e.protobufStringField(e.grpcWebPayload(framed), 1),
  rawFails: e.protobufStringField(framed, 1),
  plainStillWorks: e.protobufStringField(e.grpcWebPayload(new Uint8Array(message)), 1)
}));
"""
        result = self.run_node(source)
        self.assertEqual("QUJDREVGRw==", result["framed"])
        # Without unwrapping, the 5-byte header is read as a field and the value is lost.
        self.assertNotEqual("QUJDREVGRw==", result["rawFails"])
        self.assertEqual("QUJDREVGRw==", result["plainStillWorks"])

    def test_direct_candidate_prefers_complete_video_over_audio(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
const candidate = {
  directFiles: [
    {url:'https://cdn.test/audio.bin', contentType:'audio/mp4', contentLength:90000000, requestType:'media', fileName:'sound.m4a'},
    {url:'https://cdn.test/media.bin', contentType:'application/octet-stream', contentLength:80000000, requestType:'media', fileName:'correct-title.mp4'}
  ]
};
console.log(JSON.stringify({selected:e.directFile(candidate), extension:e.extensionForCandidate(candidate)}));
"""
        result = self.run_node(source)
        self.assertEqual("https://cdn.test/media.bin", result["selected"]["url"])
        self.assertEqual("mp4", result["extension"])

    def test_transport_stream_inspector_requires_a_video_program(self) -> None:
        source = r"""
const e = require('./extension/media-engine.js');
function packet(pid, start, payload) {
  const out = new Uint8Array(188); out.fill(0xff);
  out[0]=0x47; out[1]=(start?0x40:0)|((pid>>8)&0x1f); out[2]=pid&0xff; out[3]=0x10;
  out.set(payload, 4); return out;
}
const pat = packet(0, true, new Uint8Array([0, 0x00,0xb0,0x0d, 0,1, 0xc1,0,0, 0,1, 0xe1,0, 0,0,0,0]));
const pmt = packet(0x100, true, new Uint8Array([0, 0x02,0xb0,0x12, 0,1, 0xc1,0,0, 0xe1,1, 0xf0,0, 0x1b,0xe1,1,0xf0,0, 0,0,0,0]));
const filler = packet(0x101, false, new Uint8Array([0,0,0]));
const bytes = e.concatBytes([pat,pmt,filler]);
console.log(JSON.stringify(e.inspectTransportStream(bytes)));
"""
        result = self.run_node(source)
        self.assertEqual("mpegts", result["container"])
        self.assertTrue(result["hasVideo"])
        self.assertIn(0x1B, result["streamTypes"])


if __name__ == "__main__":
    unittest.main()
