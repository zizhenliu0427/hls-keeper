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
