(function (root) {
  const DIRECT_FILE_RE = /\.(mp4|webm|mkv|mov|m4v|mp3|m4a|flac|ogg|wav)(?:[?#]|$)/i;
  const HLS_RE = /\.m3u8(?:[?#]|$)/i;
  const DASH_RE = /\.mpd(?:[?#]|$)/i;

  function parseAttributeList(text) {
    const result = {};
    let token = "";
    let quoted = false;
    const parts = [];
    for (const char of String(text || "")) {
      if (char === '"') quoted = !quoted;
      if (char === "," && !quoted) { parts.push(token); token = ""; } else token += char;
    }
    if (token) parts.push(token);
    for (const part of parts) {
      const split = part.indexOf("=");
      if (split < 0) continue;
      const key = part.slice(0, split).trim();
      let value = part.slice(split + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      result[key] = value;
    }
    return result;
  }

  function normalizeByteRange(value, implicitOffset = 0) {
    if (!value) return null;
    const [lengthText, offsetText] = String(value).split("@");
    const length = Number(lengthText);
    const offset = offsetText == null || offsetText === "" ? Number(implicitOffset || 0) : Number(offsetText);
    if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(offset) || offset < 0) return null;
    return { length, offset, end: offset + length, value: `${length}@${offset}` };
  }

  function rangeHeader(value) {
    const range = typeof value === "object" ? value : normalizeByteRange(value);
    return range ? `bytes=${range.offset}-${range.end - 1}` : "";
  }

  function parseHlsPlaylist(text, playlistUrl) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const variants = [];
    const subtitles = [];
    const audios = [];
    const segments = [];
    let streamInfo = null;
    let duration = null;
    let rawByteRange = "";
    let key = null;
    let map = null;
    let mediaSequence = 0;
    let sequence = 0;
    let timelineSeconds = 0;
    let discontinuity = 0;
    let gap = false;
    let endList = false;
    let targetDuration = 0;
    let playlistType = "";
    let lastRangeUri = "";
    let lastRangeEnd = 0;
    let mapRangeUri = "";
    let mapRangeEnd = 0;
    for (const line of lines) {
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSequence = Number(line.slice(line.indexOf(":") + 1) || 0);
        sequence = mediaSequence;
      } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
        targetDuration = Number(line.slice(line.indexOf(":") + 1) || 0);
      } else if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
        playlistType = line.slice(line.indexOf(":") + 1).trim().toUpperCase();
      } else if (line.startsWith("#EXT-X-MEDIA:")) {
        const attrs = parseAttributeList(line.slice(line.indexOf(":") + 1));
        if (attrs.TYPE === "SUBTITLES" && attrs.URI) {
          subtitles.push({
            url: new URL(attrs.URI, playlistUrl).href,
            language: attrs.LANGUAGE || "und",
            label: attrs.NAME || attrs.LANGUAGE || "Subtitle",
            default: attrs.DEFAULT === "YES",
            forced: attrs.FORCED === "YES",
            groupId: attrs["GROUP-ID"] || ""
          });
        } else if (attrs.TYPE === "AUDIO" && attrs.URI) {
          audios.push({
            url: new URL(attrs.URI, playlistUrl).href,
            language: attrs.LANGUAGE || "und",
            label: attrs.NAME || attrs.LANGUAGE || "Audio",
            default: attrs.DEFAULT === "YES",
            autoselect: attrs.AUTOSELECT === "YES",
            groupId: attrs["GROUP-ID"] || ""
          });
        }
      } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
        streamInfo = parseAttributeList(line.slice(line.indexOf(":") + 1));
      } else if (line.startsWith("#EXTINF:")) {
        duration = Number(line.slice(8).split(",", 1)[0]);
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
        rawByteRange = line.slice(line.indexOf(":") + 1);
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const attrs = parseAttributeList(line.slice(line.indexOf(":") + 1));
        key = attrs.METHOD === "NONE" ? null : { method: attrs.METHOD || "", url: attrs.URI ? new URL(attrs.URI, playlistUrl).href : "", iv: attrs.IV || "", keyFormat: attrs.KEYFORMAT || "identity" };
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = parseAttributeList(line.slice(line.indexOf(":") + 1));
        if (attrs.URI) {
          const url = new URL(attrs.URI, playlistUrl).href;
          const normalized = normalizeByteRange(attrs.BYTERANGE || "", mapRangeUri === url ? mapRangeEnd : 0);
          if (normalized) { mapRangeUri = url; mapRangeEnd = normalized.end; }
          map = { url, byteRange: normalized?.value || "", key: key ? { ...key } : null };
        }
      } else if (line === "#EXT-X-DISCONTINUITY") {
        discontinuity += 1;
      } else if (line === "#EXT-X-GAP") {
        gap = true;
      } else if (line === "#EXT-X-ENDLIST") {
        endList = true;
      } else if (!line.startsWith("#")) {
        const url = new URL(line, playlistUrl).href;
        if (streamInfo) {
          variants.push({
            url,
            resolution: streamInfo.RESOLUTION || "auto",
            bandwidth: Number(streamInfo.BANDWIDTH || 0),
            averageBandwidth: Number(streamInfo["AVERAGE-BANDWIDTH"] || 0),
            codecs: streamInfo.CODECS || "",
            audioGroup: streamInfo.AUDIO || "",
            subtitleGroup: streamInfo.SUBTITLES || ""
          });
          streamInfo = null;
        } else {
          const normalized = normalizeByteRange(rawByteRange, lastRangeUri === url ? lastRangeEnd : 0);
          if (normalized) { lastRangeUri = url; lastRangeEnd = normalized.end; }
          const segmentDuration = Number.isFinite(duration) ? duration : targetDuration || 0;
          segments.push({
            sequence,
            url,
            duration: segmentDuration,
            startSeconds: timelineSeconds,
            endSeconds: timelineSeconds + segmentDuration,
            byteRange: normalized?.value || "",
            key: key ? { ...key } : null,
            map: map ? { ...map } : null,
            discontinuity,
            gap
          });
          sequence += 1;
          timelineSeconds += segmentDuration;
          duration = null;
          rawByteRange = "";
          gap = false;
        }
      }
    }
    return {
      url: playlistUrl,
      text,
      variants,
      subtitles,
      audios,
      segments,
      mediaSequence,
      targetDuration,
      playlistType,
      endList,
      isLive: !endList && playlistType !== "VOD",
      map,
      duration: timelineSeconds
    };
  }

  function decodeXml(value) {
    return String(value || "").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }

  function parseXmlAttributes(text) {
    const attributes = {};
    const pattern = /([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = pattern.exec(text))) attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
    return attributes;
  }

  function parseXml(source) {
    const root = { name: "#document", attrs: {}, children: [], text: "" };
    const stack = [root];
    const tokens = String(source || "").match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<[^>]+>|[^<]+/g) || [];
    for (const token of tokens) {
      if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!")) continue;
      if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
      if (token.startsWith("<")) {
        const selfClosing = /\/\s*>$/.test(token);
        const content = token.slice(1, selfClosing ? token.lastIndexOf("/") : -1).trim();
        const name = content.match(/^([^\s/>]+)/)?.[1] || "";
        if (!name) continue;
        const node = { name: name.split(":").pop(), attrs: parseXmlAttributes(content.slice(name.length)), children: [], text: "" };
        stack[stack.length - 1].children.push(node);
        if (!selfClosing) stack.push(node);
      } else if (token.trim()) {
        stack[stack.length - 1].text += decodeXml(token.trim());
      }
    }
    return root;
  }

  function xmlChildren(node, name) {
    return (node?.children || []).filter((child) => child.name === name);
  }

  function xmlChild(node, name) {
    return xmlChildren(node, name)[0] || null;
  }

  function isoDurationSeconds(value) {
    const match = String(value || "").match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
    if (!match) return 0;
    return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
  }

  function templateValue(template, representation, number, time) {
    return String(template || "")
      .replace(/\$\$/g, "\0")
      .replace(/\$RepresentationID\$/g, representation.id)
      .replace(/\$Bandwidth\$/g, String(representation.bandwidth || 0))
      .replace(/\$Number(?:%0(\d+)d)?\$/g, (_all, width) => String(number).padStart(Number(width || 0), "0"))
      .replace(/\$Time\$/g, String(time))
      .replace(/\0/g, "$");
  }

  function expandDashTimeline(entries, { periodDuration = 0, timescale = 1, maxSegments = 200000 } = {}) {
    const result = [];
    let current = 0;
    for (let index = 0; index < entries.length && result.length < maxSegments; index += 1) {
      const entry = entries[index];
      const duration = Number(entry.d || 0);
      if (!duration) continue;
      if (entry.t != null && entry.t !== "") current = Number(entry.t);
      let repeat = Number(entry.r || 0);
      if (repeat < 0) {
        const nextTime = entries.slice(index + 1).find((item) => item.t != null && item.t !== "")?.t;
        const limit = nextTime != null ? Number(nextTime) : Math.ceil(Number(periodDuration || 0) * timescale);
        repeat = limit > current ? Math.max(0, Math.ceil((limit - current) / duration) - 1) : 0;
      }
      for (let count = 0; count <= repeat && result.length < maxSegments; count += 1) {
        result.push({ time: current, duration, startSeconds: current / timescale, endSeconds: (current + duration) / timescale });
        current += duration;
      }
    }
    return result;
  }

  function inheritedBaseUrl(parentUrl, ...nodes) {
    let url = parentUrl;
    for (const node of nodes) {
      const value = xmlChild(node, "BaseURL")?.text;
      if (value) url = new URL(value, url).href;
    }
    return url;
  }

  function inheritedTemplate(...nodes) {
    const merged = { attrs: {}, timeline: [] };
    for (const node of nodes) {
      const template = xmlChild(node, "SegmentTemplate");
      if (!template) continue;
      Object.assign(merged.attrs, template.attrs);
      const timeline = xmlChild(template, "SegmentTimeline");
      if (timeline) merged.timeline = xmlChildren(timeline, "S").map((entry) => entry.attrs);
    }
    return Object.keys(merged.attrs).length ? merged : null;
  }

  function dashTrackFromRepresentation({ representationNode, adaptationNode, periodNode, manifestUrl, periodDuration }) {
    const attrs = { ...(adaptationNode?.attrs || {}), ...(representationNode?.attrs || {}) };
    const id = String(attrs.id || `${attrs.contentType || attrs.mimeType || "track"}-${attrs.bandwidth || 0}`);
    const mimeType = attrs.mimeType || "";
    const contentType = attrs.contentType || (mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio" : "unknown");
    const representation = {
      id,
      bandwidth: Number(attrs.bandwidth || 0),
      width: Number(attrs.width || 0),
      height: Number(attrs.height || 0),
      codecs: attrs.codecs || "",
      mimeType,
      contentType,
      language: attrs.lang || adaptationNode?.attrs?.lang || "und",
      baseUrl: inheritedBaseUrl(manifestUrl, periodNode, adaptationNode, representationNode),
      initializationUrl: "",
      segments: []
    };
    const template = inheritedTemplate(periodNode, adaptationNode, representationNode);
    if (template?.attrs?.media) {
      const timescale = Number(template.attrs.timescale || 1);
      const startNumber = Number(template.attrs.startNumber || 1);
      const presentationTimeOffset = Number(template.attrs.presentationTimeOffset || 0);
      let timeline = expandDashTimeline(template.timeline, { periodDuration, timescale });
      if (!timeline.length && Number(template.attrs.duration || 0) > 0 && periodDuration > 0) {
        const duration = Number(template.attrs.duration);
        const count = Math.min(200000, Math.ceil(periodDuration * timescale / duration));
        timeline = Array.from({ length: count }, (_item, index) => ({
          time: presentationTimeOffset + index * duration,
          duration,
          startSeconds: index * duration / timescale,
          endSeconds: (index + 1) * duration / timescale
        }));
      }
      representation.initializationUrl = template.attrs.initialization
        ? new URL(templateValue(template.attrs.initialization, representation, startNumber, presentationTimeOffset), representation.baseUrl).href
        : "";
      representation.segments = timeline.map((item, index) => ({
        sequence: startNumber + index,
        time: item.time,
        duration: item.duration,
        startSeconds: item.startSeconds,
        endSeconds: item.endSeconds,
        url: new URL(templateValue(template.attrs.media, representation, startNumber + index, item.time), representation.baseUrl).href
      }));
    } else {
      const segmentList = xmlChild(representationNode, "SegmentList") || xmlChild(adaptationNode, "SegmentList");
      if (segmentList) {
        const initialization = xmlChild(segmentList, "Initialization");
        representation.initializationUrl = initialization?.attrs?.sourceURL ? new URL(initialization.attrs.sourceURL, representation.baseUrl).href : "";
        representation.segments = xmlChildren(segmentList, "SegmentURL").map((item, index) => ({
          sequence: index + 1,
          time: index,
          duration: 0,
          startSeconds: 0,
          endSeconds: 0,
          url: new URL(item.attrs.media, representation.baseUrl).href,
          byteRange: item.attrs.mediaRange ? `${Number(item.attrs.mediaRange.split("-")[1]) - Number(item.attrs.mediaRange.split("-")[0]) + 1}@${Number(item.attrs.mediaRange.split("-")[0])}` : ""
        }));
      }
    }
    return representation;
  }

  function parseDashManifest(text, manifestUrl) {
    const document = parseXml(text);
    const mpd = xmlChild(document, "MPD");
    if (!mpd) throw new Error("Invalid MPD");
    const period = xmlChild(mpd, "Period");
    if (!period) throw new Error("MPD has no Period");
    const duration = isoDurationSeconds(period.attrs.duration || mpd.attrs.mediaPresentationDuration || "");
    const protectionNodes = [];
    const collectProtection = (node) => {
      for (const child of node?.children || []) {
        if (child.name === "ContentProtection") protectionNodes.push(child);
        collectProtection(child);
      }
    };
    collectProtection(period);
    const drm = protectionNodes.some((node) => /widevine|playready|fairplay|edef8ba9|9a04f079|urn:uuid/i.test(`${node.attrs.schemeIdUri || ""} ${node.attrs.value || ""}`));
    const tracks = [];
    const subtitles = [];
    const manifestBaseUrl = inheritedBaseUrl(manifestUrl, mpd);
    for (const adaptation of xmlChildren(period, "AdaptationSet")) {
      const adaptationAttrs = adaptation.attrs || {};
      const isText = adaptationAttrs.contentType === "text" || /^text\//i.test(adaptationAttrs.mimeType || "");
      if (isText) {
        for (const representationNode of xmlChildren(adaptation, "Representation")) {
          const attrs = { ...adaptationAttrs, ...(representationNode.attrs || {}) };
          // Segmented text (stpp/wvtt in fMP4) needs an extractor we do not have; only whole files are usable.
          if (inheritedTemplate(period, adaptation, representationNode) || xmlChild(representationNode, "SegmentList") || xmlChild(adaptation, "SegmentList")) {
            subtitles.push({ url: "", language: attrs.lang || "und", label: attrs.id || "", mimeType: attrs.mimeType || "", segmented: true });
            continue;
          }
          const url = inheritedBaseUrl(manifestBaseUrl, period, adaptation, representationNode);
          if (url === manifestBaseUrl) continue;
          subtitles.push({ url, language: attrs.lang || "und", label: attrs.id || "", mimeType: attrs.mimeType || "", segmented: false });
        }
        continue;
      }
      for (const representationNode of xmlChildren(adaptation, "Representation")) {
        const track = dashTrackFromRepresentation({ representationNode, adaptationNode: adaptation, periodNode: period, manifestUrl: manifestBaseUrl, periodDuration: duration });
        if (track.segments.length || track.initializationUrl) tracks.push(track);
      }
    }
    return { url: manifestUrl, text, type: mpd.attrs.type || "static", duration, minimumUpdatePeriod: isoDurationSeconds(mpd.attrs.minimumUpdatePeriod || ""), drm, tracks, subtitles };
  }

  function selectDashTracks(manifest, preferredHeight = 0) {
    const videos = manifest.tracks.filter((track) => track.contentType === "video").sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
    const audios = manifest.tracks.filter((track) => track.contentType === "audio").sort((a, b) => b.bandwidth - a.bandwidth);
    const video = videos.find((track) => preferredHeight && track.height === preferredHeight) || videos[0] || null;
    return [video, audios[0] || null].filter(Boolean);
  }

  function readUint32(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
  }

  function writeUint32(bytes, offset, value) {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value);
  }

  function writeUint64(bytes, offset, value) {
    const safe = Math.max(0, Math.round(Number(value || 0)));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(offset, Math.floor(safe / 4294967296));
    view.setUint32(offset + 4, safe >>> 0);
  }

  function mp4Boxes(bytes, start = 0, end = bytes.byteLength) {
    const result = [];
    let offset = start;
    while (offset + 8 <= end) {
      let size = readUint32(bytes, offset);
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      let headerSize = 8;
      if (size === 1) {
        const high = readUint32(bytes, offset + 8);
        const low = readUint32(bytes, offset + 12);
        size = high * 4294967296 + low;
        headerSize = 16;
      } else if (size === 0) size = end - offset;
      if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) break;
      result.push({ type, start: offset, size, headerSize, dataStart: offset + headerSize, end: offset + size });
      offset += size;
    }
    return result;
  }

  function concatBytes(parts) {
    const arrays = parts.filter(Boolean).map((item) => item instanceof Uint8Array ? item : new Uint8Array(item));
    const output = new Uint8Array(arrays.reduce((sum, item) => sum + item.byteLength, 0));
    let offset = 0;
    for (const item of arrays) { output.set(item, offset); offset += item.byteLength; }
    return output;
  }

  function makeMp4Box(type, parts) {
    const payload = concatBytes(parts);
    const output = new Uint8Array(8 + payload.byteLength);
    writeUint32(output, 0, output.byteLength);
    for (let index = 0; index < 4; index += 1) output[4 + index] = type.charCodeAt(index) || 32;
    output.set(payload, 8);
    return output;
  }

  // ISO/IEC 14496-12 sidx. One reference per fragment: its byte size and its duration, so a
  // player can map a timestamp to a file offset without reading anything in between.
  function buildSidx(references, { timescale = 90000, referenceId = 1, earliestPresentationTime = 0, firstOffset = 0 } = {}) {
    const count = references.length;
    const bytes = new Uint8Array(sidxByteLength(count));
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    bytes.set([0x73, 0x69, 0x64, 0x78], 4);           // "sidx"
    view.setUint8(8, 1);                               // version 1: 64-bit times
    view.setUint32(12, referenceId);
    view.setUint32(16, timescale);
    view.setBigUint64(20, BigInt(Math.max(0, Math.round(earliestPresentationTime))));
    // Distance from the end of this sidx to the first referenced subsegment. When a trailing
    // free box pads a reserved slot, that gap must be counted; 0 only means moof follows next.
    view.setBigUint64(28, BigInt(Math.max(0, Math.round(firstOffset))));
    view.setUint16(36, 0);                             // reserved
    view.setUint16(38, count);
    references.forEach((reference, index) => {
      const at = 40 + index * 12;
      // reference_type 0 (media), then the referenced byte size.
      view.setUint32(at, Math.max(0, Math.round(reference.size)) & 0x7fffffff);
      view.setUint32(at + 4, Math.max(0, Math.round(reference.duration)));
      // starts_with_SAP = 1, SAP_type = 1: every fragment begins at a keyframe.
      view.setUint32(at + 8, 0x90000000);
    });
    return bytes;
  }

  // A placeholder of the same size, so the real index can be written in place once the fragment
  // sizes are known. "free" is skipped by every parser.
  function buildFreeBox(length) {
    const bytes = new Uint8Array(Math.max(8, length));
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    bytes.set([0x66, 0x72, 0x65, 0x65], 4);            // "free"
    return bytes;
  }

  function sidxByteLength(referenceCount) {
    // 8 box header + 4 version/flags + 4 reference_ID + 4 timescale + 8 earliest_presentation_time
    // + 8 first_offset + 2 reserved + 2 reference_count, then 12 bytes per reference.
    return 40 + referenceCount * 12;
  }

  function patchMp4InitDuration(input, durationSeconds) {
    const output = (input instanceof Uint8Array ? input : new Uint8Array(input)).slice();
    const seconds = Number(durationSeconds || 0);
    if (!(seconds > 0) || !Number.isFinite(seconds)) return output;
    const moov = mp4Boxes(output).find((item) => item.type === "moov");
    if (!moov) return output;
    const moovChildren = mp4Boxes(output, moov.dataStart, moov.end);
    const mvhd = moovChildren.find((item) => item.type === "mvhd");
    let movieTimescale = 1000;
    if (mvhd) {
      const version = output[mvhd.dataStart];
      const timescaleOffset = mvhd.dataStart + (version === 1 ? 20 : 12);
      const durationOffset = mvhd.dataStart + (version === 1 ? 24 : 16);
      movieTimescale = readUint32(output, timescaleOffset) || movieTimescale;
      const duration = Math.round(seconds * movieTimescale);
      if (version === 1) writeUint64(output, durationOffset, duration);
      else writeUint32(output, durationOffset, Math.min(duration, 0xfffffffe));
    }
    for (const trak of moovChildren.filter((item) => item.type === "trak")) {
      const trakChildren = mp4Boxes(output, trak.dataStart, trak.end);
      const tkhd = trakChildren.find((item) => item.type === "tkhd");
      if (tkhd) {
        const version = output[tkhd.dataStart];
        const durationOffset = tkhd.dataStart + (version === 1 ? 28 : 20);
        const duration = Math.round(seconds * movieTimescale);
        if (version === 1) writeUint64(output, durationOffset, duration);
        else writeUint32(output, durationOffset, Math.min(duration, 0xfffffffe));
      }
      const mdia = trakChildren.find((item) => item.type === "mdia");
      if (!mdia) continue;
      const mdhd = mp4Boxes(output, mdia.dataStart, mdia.end).find((item) => item.type === "mdhd");
      if (!mdhd) continue;
      const version = output[mdhd.dataStart];
      const timescaleOffset = mdhd.dataStart + (version === 1 ? 20 : 12);
      const durationOffset = mdhd.dataStart + (version === 1 ? 24 : 16);
      const timescale = readUint32(output, timescaleOffset) || movieTimescale;
      const duration = Math.round(seconds * timescale);
      if (version === 1) writeUint64(output, durationOffset, duration);
      else writeUint32(output, durationOffset, Math.min(duration, 0xfffffffe));
    }
    return output;
  }

  function boxBytes(bytes, box) {
    return bytes.slice(box.start, box.end);
  }

  function trackIdFromTrak(trakBytes) {
    const trak = mp4Boxes(trakBytes)[0];
    const tkhd = mp4Boxes(trakBytes, trak.dataStart, trak.end).find((item) => item.type === "tkhd");
    if (!tkhd) return 0;
    const version = trakBytes[tkhd.dataStart];
    return readUint32(trakBytes, tkhd.dataStart + (version === 1 ? 20 : 12));
  }

  function patchTrakId(trakBytes, newTrackId) {
    const output = trakBytes.slice();
    const trak = mp4Boxes(output)[0];
    const tkhd = mp4Boxes(output, trak.dataStart, trak.end).find((item) => item.type === "tkhd");
    if (!tkhd) throw new Error("CMAF track has no tkhd box");
    const version = output[tkhd.dataStart];
    writeUint32(output, tkhd.dataStart + (version === 1 ? 20 : 12), newTrackId);
    return output;
  }

  function patchTrexId(trexBytes, newTrackId) {
    const output = trexBytes.slice();
    const trex = mp4Boxes(output)[0];
    if (!trex || trex.type !== "trex") throw new Error("Invalid trex box");
    writeUint32(output, trex.dataStart + 4, newTrackId);
    return output;
  }

  function patchMvhdNextTrackId(mvhdBytes, nextTrackId) {
    const output = mvhdBytes.slice();
    const mvhd = mp4Boxes(output)[0];
    if (!mvhd || mvhd.type !== "mvhd") return output;
    const version = output[mvhd.dataStart];
    const offset = mvhd.dataStart + (version === 1 ? 108 : 96);
    if (offset + 4 <= output.byteLength) writeUint32(output, offset, nextTrackId);
    return output;
  }

  function initParts(bytes) {
    const top = mp4Boxes(bytes);
    const ftyp = top.find((item) => item.type === "ftyp");
    const moov = top.find((item) => item.type === "moov");
    if (!moov) throw new Error("CMAF initialization has no moov box");
    const children = mp4Boxes(bytes, moov.dataStart, moov.end);
    return { ftyp: ftyp ? boxBytes(bytes, ftyp) : null, moov, children };
  }

  function mergeCmafInitializations(videoInput, audioInput) {
    const videoBytes = videoInput instanceof Uint8Array ? videoInput : new Uint8Array(videoInput);
    const audioBytes = audioInput instanceof Uint8Array ? audioInput : new Uint8Array(audioInput);
    const video = initParts(videoBytes);
    const audio = initParts(audioBytes);
    const videoTraks = video.children.filter((item) => item.type === "trak").map((item) => boxBytes(videoBytes, item));
    const audioTraks = audio.children.filter((item) => item.type === "trak").map((item) => boxBytes(audioBytes, item));
    if (!videoTraks.length || !audioTraks.length) throw new Error("CMAF initialization is missing a track");
    const videoTrackIds = videoTraks.map(trackIdFromTrak);
    const oldAudioTrackId = trackIdFromTrak(audioTraks[0]);
    const newAudioTrackId = Math.max(0, ...videoTrackIds, oldAudioTrackId) + 1;
    const patchedAudioTrak = patchTrakId(audioTraks[0], newAudioTrackId);
    const videoMvex = video.children.find((item) => item.type === "mvex");
    const audioMvex = audio.children.find((item) => item.type === "mvex");
    const mvexParts = [];
    if (videoMvex) {
      for (const child of mp4Boxes(videoBytes, videoMvex.dataStart, videoMvex.end)) mvexParts.push(boxBytes(videoBytes, child));
    }
    if (audioMvex) {
      for (const child of mp4Boxes(audioBytes, audioMvex.dataStart, audioMvex.end)) {
        if (child.type === "trex") mvexParts.push(patchTrexId(boxBytes(audioBytes, child), newAudioTrackId));
      }
    }
    const moovParts = [];
    let tracksInserted = false;
    for (const child of video.children) {
      if (child.type === "trak") {
        if (!tracksInserted) {
          moovParts.push(...videoTraks, patchedAudioTrak);
          tracksInserted = true;
        }
        continue;
      }
      if (child.type === "mvex") {
        if (mvexParts.length) moovParts.push(makeMp4Box("mvex", mvexParts));
        continue;
      }
      const bytes = boxBytes(videoBytes, child);
      moovParts.push(child.type === "mvhd" ? patchMvhdNextTrackId(bytes, newAudioTrackId + 1) : bytes);
    }
    if (!tracksInserted) moovParts.push(...videoTraks, patchedAudioTrak);
    if (!videoMvex && mvexParts.length) moovParts.push(makeMp4Box("mvex", mvexParts));
    return {
      bytes: concatBytes([video.ftyp || audio.ftyp, makeMp4Box("moov", moovParts)]),
      videoTrackId: videoTrackIds[0] || 1,
      oldAudioTrackId,
      audioTrackId: newAudioTrackId
    };
  }

  function patchCmafFragmentTrackId(input, oldTrackId, newTrackId) {
    const output = input instanceof Uint8Array ? input.slice() : new Uint8Array(input.slice(0));
    const visit = (start, end) => {
      for (const box of mp4Boxes(output, start, end)) {
        if (box.type === "moof" || box.type === "traf") visit(box.dataStart, box.end);
        else if (box.type === "tfhd" && readUint32(output, box.dataStart + 4) === oldTrackId) writeUint32(output, box.dataStart + 4, newTrackId);
        else if (box.type === "sidx" && readUint32(output, box.dataStart + 4) === oldTrackId) writeUint32(output, box.dataStart + 4, newTrackId);
      }
    };
    visit(0, output.byteLength);
    return output;
  }

  function classifyMediaError(error) {
    if (error?.code) return error.code;
    const status = Number(error?.status || String(error?.message || "").match(/HTTP\s+(\d{3})/i)?.[1] || 0);
    if (status === 401 || status === 403) return "AUTH_REQUIRED";
    if (status === 404 || status === 410) return "URL_EXPIRED";
    if (status === 429) return "RATE_LIMITED";
    if (/DRM/i.test(error?.message || "")) return "DRM_DETECTED";
    if (/range|范围/i.test(error?.message || "")) return "RANGE_UNSUPPORTED";
    if (/pause|暂停|AbortError/i.test(`${error?.name || ""} ${error?.message || ""}`)) return "PAUSED";
    return "NETWORK_ERROR";
  }

  function normalizeMediaUrl(value) {
    try {
      const url = new URL(value);
      url.hash = "";
      return url.href;
    } catch { return String(value || ""); }
  }

  function urlDirectory(value) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname.replace(/[^/]*$/, "")}`;
    } catch { return ""; }
  }

  function sequenceFromUrl(value) {
    try {
      const name = new URL(value).pathname.split("/").pop() || "";
      const match = name.match(/(?:^|[_-])(\d{1,10})(?:\.[a-z0-9]+)?$/i) || name.match(/(\d{1,10})/);
      return match ? Number(match[1]) : null;
    } catch { return null; }
  }

  function segmentLookup(segments = []) {
    const byUrl = new Map();
    const byPath = new Map();
    for (const item of segments) {
      byUrl.set(normalizeMediaUrl(item.url), item);
      let path = "";
      try { path = new URL(item.url).pathname; } catch { path = ""; }
      if (!path) continue;
      byPath.set(path, byPath.has(path) ? null : item);
    }
    const reference = segments.find((item) => item?.url)?.url || "";
    function exact(url) {
      let path = "";
      try { path = new URL(url).pathname; } catch { path = ""; }
      return byUrl.get(normalizeMediaUrl(url)) || (path ? byPath.get(path) : null) || null;
    }
    function sameLocation(url) {
      const directory = urlDirectory(url);
      return Boolean(directory) && directory === urlDirectory(reference);
    }
    function find(url) {
      const known = exact(url);
      if (known) return known;
      if (!sameLocation(url)) return null;
      const sequence = sequenceFromUrl(url);
      return sequence == null ? null : segments.find((item) => item.sequence === sequence) || null;
    }
    return { exact, sameLocation, find };
  }

  function mergeDashCaptureTracks(previousTracks = [], nextTracks = []) {
    const previousById = new Map(previousTracks.map((track) => [track.id, track]));
    const merged = nextTracks.map((track) => {
      const previous = previousById.get(track.id);
      if (!previous?.segments?.length) return track;
      const segments = [...previous.segments];
      const known = new Set(segments.map((segment) => normalizeMediaUrl(segment.url)));
      for (const segment of track.segments) {
        const key = normalizeMediaUrl(segment.url);
        if (known.has(key)) continue;
        known.add(key);
        segments.push(segment);
      }
      return { ...track, segments };
    });
    const carried = previousTracks.filter((track) => !merged.some((item) => item.id === track.id));
    return [...merged, ...carried];
  }

  function dashCaptureIndex(manifest) {
    const tracks = (manifest?.tracks || []).filter((track) => ["video", "audio"].includes(track.contentType) && track.segments.length);
    const byUrl = new Map();
    const byPath = new Map();
    const rememberPath = (url, entry) => {
      let path = "";
      try { path = new URL(url).pathname; } catch { path = ""; }
      if (!path) return;
      byPath.set(path, byPath.has(path) ? null : entry);
    };
    for (const track of tracks) {
      if (track.initializationUrl) {
        const entry = { trackId: track.id, index: -1, kind: "initialization" };
        byUrl.set(normalizeMediaUrl(track.initializationUrl), entry);
        rememberPath(track.initializationUrl, entry);
      }
      track.segments.forEach((segment, index) => {
        const entry = { trackId: track.id, index, kind: "segment" };
        byUrl.set(normalizeMediaUrl(segment.url), entry);
        rememberPath(segment.url, entry);
      });
    }
    function find(url) {
      const exact = byUrl.get(normalizeMediaUrl(url));
      if (exact) return exact;
      let path = "";
      try { path = new URL(url).pathname; } catch { path = ""; }
      return (path ? byPath.get(path) : null) || null;
    }
    function track(trackId) {
      return tracks.find((item) => item.id === trackId) || null;
    }
    return { tracks, find, track };
  }

  function readVarint(bytes, position) {
    let result = 0;
    let shift = 0;
    let cursor = position;
    while (cursor < bytes.length) {
      const byte = bytes[cursor];
      cursor += 1;
      result += (byte & 0x7f) * Math.pow(2, shift);
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return [result, cursor];
  }

  // Minimal protobuf reader: the payload only needs one length-delimited string field.
  // protobuf fields can repeat, and a single reply often carries one ciphertext chunk per entry.
  function protobufStringFields(input, fieldNumber) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    const values = [];
    let position = 0;
    while (position < bytes.length) {
      const [key, afterKey] = readVarint(bytes, position);
      position = afterKey;
      const wireType = key & 0x07;
      const number = Math.floor(key / 8);
      if (wireType === 0) position = readVarint(bytes, position)[1];
      else if (wireType === 1) position += 8;
      else if (wireType === 2) {
        const [length, afterLength] = readVarint(bytes, position);
        position = afterLength;
        if (number === fieldNumber) values.push(new TextDecoder().decode(bytes.subarray(position, position + length)));
        position += length;
      } else if (wireType === 5) position += 4;
      else return values;
    }
    return values;
  }

  function protobufStringField(input, fieldNumber) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    let position = 0;
    while (position < bytes.length) {
      const [key, afterKey] = readVarint(bytes, position);
      position = afterKey;
      const wireType = key & 0x07;
      const number = Math.floor(key / 8);
      if (wireType === 0) { position = readVarint(bytes, position)[1]; }
      else if (wireType === 1) { position += 8; }
      else if (wireType === 2) {
        const [length, afterLength] = readVarint(bytes, position);
        position = afterLength;
        const value = bytes.subarray(position, position + length);
        position += length;
        if (number === fieldNumber) return new TextDecoder().decode(value);
      } else if (wireType === 5) { position += 4; }
      else return null;
    }
    return null;
  }

  function jwtPayload(token) {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return {};
    try {
      const base = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(decodeURIComponent(escape(atob(base + "=".repeat((4 - base.length % 4) % 4)))));
    } catch { return {}; }
  }

  // The subtitle IV is the viewer's own numeric id, taken from the JWT the page already sends.
  function subtitleUserIdFromHeaders(headers = {}) {
    const tokens = [];
    for (const [name, value] of Object.entries(headers)) {
      const lower = String(name).toLowerCase();
      if (lower === "authorization" && value) tokens.push(String(value).replace(/^Bearer\s+/i, ""));
      if (lower === "cookie" && value) {
        for (const part of String(value).split(";")) {
          const [cookieName, cookieValue] = part.split("=").map((item) => (item || "").trim());
          if (["authorization", "token", "access_token"].includes(String(cookieName).toLowerCase()) && cookieValue) {
            tokens.push(cookieValue.replace(/^Bearer\s+/i, ""));
          }
        }
      }
    }
    for (const token of tokens) {
      const payload = jwtPayload(token);
      for (const field of ["uid", "Identity", "identity", "id", "user_id"]) {
        const value = payload?.[field];
        if (value != null && String(value).trim()) return String(value).trim();
      }
    }
    return null;
  }

  const SUBTITLE_MODES = ["none", "zh-hans", "zh-hant", "en-us", "en-gb"];
  const ZH_T2S_PHRASES = {"影片": "影片", "繁體": "繁体", "繁體中文": "简体中文", "臺灣": "台湾", "軟體": "软件", "香港": "香港"};
  const ZH_S2T_PHRASES = {"台湾": "臺灣", "影片": "影片", "简体中文": "繁體中文", "繁体": "繁體", "软件": "軟體", "香港": "香港"};
  const ZH_T2S_CHARS = {"來": "来", "個": "个", "們": "们", "傳": "传", "出": "出", "吧": "吧", "呢": "呢", "問": "问", "嗎": "吗", "器": "器", "國": "国", "妳": "你", "學": "学", "實": "实", "對": "对", "常": "常", "後": "后", "從": "从", "愛": "爱", "態": "态", "應": "应", "換": "换", "擇": "择", "於": "于", "時": "时", "書": "书", "會": "会", "樂": "乐", "標": "标", "檔": "档", "權": "权", "氣": "气", "沒": "没", "瀏": "浏", "為": "为", "現": "现", "理": "理", "畫": "画", "異": "异", "發": "发", "示": "示", "簡": "简", "給": "给", "網": "网", "線": "线", "習": "习", "聲": "声", "聽": "听", "腦": "脑", "與": "与", "處": "处", "號": "号", "裏": "里", "裡": "里", "見": "见", "覽": "览", "訊": "讯", "話": "话", "該": "该", "認": "认", "誤": "误", "說": "说", "請": "请", "證": "证", "讓": "让", "質": "质", "載": "载", "轉": "转", "這": "这", "進": "进", "過": "过", "選": "选", "還": "还", "那": "那", "錯": "错", "長": "长", "門": "门", "開": "开", "間": "间", "關": "关", "雲": "云", "電": "电", "音": "音", "頁": "页", "頭": "头", "題": "题", "顯": "显", "體": "体", "麼": "么", "點": "点"};
  const ZH_S2T_CHARS = {"与": "與", "个": "個", "为": "為", "么": "麼", "乐": "樂", "习": "習", "书": "書", "于": "於", "云": "雲", "从": "從", "们": "們", "会": "會", "传": "傳", "体": "體", "你": "你", "关": "關", "发": "發", "号": "號", "后": "後", "吗": "嗎", "听": "聽", "国": "國", "声": "聲", "处": "處", "头": "頭", "学": "學", "实": "實", "对": "對", "应": "應", "开": "開", "异": "異", "态": "態", "择": "擇", "换": "換", "时": "時", "显": "顯", "权": "權", "来": "來", "标": "標", "档": "檔", "气": "氣", "没": "沒", "浏": "瀏", "点": "點", "爱": "愛", "现": "現", "电": "電", "画": "畫", "简": "簡", "线": "線", "给": "給", "网": "網", "脑": "腦", "见": "見", "览": "覽", "认": "認", "让": "讓", "讯": "訊", "证": "證", "话": "話", "该": "該", "误": "誤", "说": "說", "请": "請", "质": "質", "转": "轉", "载": "載", "过": "過", "还": "還", "这": "這", "进": "進", "选": "選", "里": "裡", "错": "錯", "长": "長", "门": "門", "问": "問", "间": "間", "页": "頁", "题": "題"};
  const EN_GB_TO_US = {"analyse": "analyze", "analysed": "analyzed", "analysing": "analyzing", "behaviour": "behavior", "behaviours": "behaviors", "cancelled": "canceled", "cancelling": "canceling", "centre": "center", "centres": "centers", "colour": "color", "colours": "colors", "defence": "defense", "favour": "favor", "favourite": "favorite", "favourites": "favorites", "favours": "favors", "grey": "gray", "honour": "honor", "honours": "honors", "licence": "license", "litre": "liter", "litres": "liters", "metre": "meter", "metres": "meters", "organise": "organize", "organised": "organized", "organising": "organizing", "programme": "program", "realise": "realize", "realised": "realized", "realising": "realizing", "recognise": "recognize", "recognised": "recognized", "recognising": "recognizing", "theatre": "theater", "theatres": "theaters", "travelled": "traveled", "travelling": "traveling"};
  const EN_US_TO_GB = {"analyze": "analyse", "analyzed": "analysed", "analyzing": "analysing", "behavior": "behaviour", "behaviors": "behaviours", "canceled": "cancelled", "canceling": "cancelling", "center": "centre", "centers": "centres", "color": "colour", "colors": "colours", "defense": "defence", "favor": "favour", "favorite": "favourite", "favorites": "favourites", "favors": "favours", "gray": "grey", "honor": "honour", "honors": "honours", "license": "licence", "liter": "litre", "liters": "litres", "meter": "metre", "meters": "metres", "organize": "organise", "organized": "organised", "organizing": "organising", "program": "programme", "realize": "realise", "realized": "realised", "realizing": "realising", "recognize": "recognise", "recognized": "recognised", "recognizing": "recognising", "theater": "theatre", "theaters": "theatres", "traveled": "travelled", "traveling": "travelling"};

  function replacePhrases(text, phrases) {
    let result = String(text);
    for (const [from, to] of Object.entries(phrases)) result = result.split(from).join(to);
    return result;
  }

  function translateChars(text, table) {
    let result = "";
    for (const character of String(text)) result += table[character] ?? character;
    return result;
  }

  // Preserve the original capitalisation so "Colour" does not become "color" mid-sentence.
  function convertEnglishSpelling(text, mapping) {
    return String(text).replace(/[A-Za-z]+/g, (word) => {
      const replacement = mapping[word.toLowerCase()];
      if (!replacement) return word;
      if (word === word.toUpperCase()) return replacement.toUpperCase();
      if (word[0] === word[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
      return replacement;
    });
  }

  // Counts CJK characters the hand-written tables could not map, so callers can warn honestly.
  function unconvertedChineseCount(text, mode) {
    if (!["zh-hans", "zh-hant"].includes(mode)) return 0;
    const table = mode === "zh-hans" ? ZH_T2S_CHARS : ZH_S2T_CHARS;
    const reverse = mode === "zh-hans" ? ZH_S2T_CHARS : ZH_T2S_CHARS;
    let unmapped = 0;
    for (const character of String(text)) {
      if (!/[\u4e00-\u9fff]/.test(character)) continue;
      // Already in the target form when it appears as a value of the opposite table.
      if (table[character] || Object.prototype.hasOwnProperty.call(reverse, character)) continue;
      unmapped += 1;
    }
    return unmapped;
  }

  function convertSubtitleText(text, mode = "none") {
    if (!SUBTITLE_MODES.includes(mode) || mode === "none") return String(text);
    if (mode === "zh-hans") return translateChars(replacePhrases(text, ZH_T2S_PHRASES), ZH_T2S_CHARS);
    if (mode === "zh-hant") return translateChars(replacePhrases(text, ZH_S2T_PHRASES), ZH_S2T_CHARS);
    if (mode === "en-us") return convertEnglishSpelling(text, EN_GB_TO_US);
    return convertEnglishSpelling(text, EN_US_TO_GB);
  }

  function parseVttTimestamp(value) {
    const parts = String(value).trim().split(":");
    if (parts.length < 2) return 0;
    const seconds = Number(parts.pop().replace(",", ".")) || 0;
    const minutes = Number(parts.pop()) || 0;
    const hours = Number(parts.pop() || 0) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function formatVttTimestamp(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
  }

  // Each segmented part times its cues from its own LOCAL anchor; without applying the
  // MPEGTS offset the merged file drifts further out of sync with every part.
  function timestampMapOffset(header, baseMpegts) {
    const local = /LOCAL:\s*([0-9:.]+)/i.exec(header || "");
    const mpegts = /MPEGTS:\s*(\d+)/i.exec(header || "");
    if (!local || !mpegts) return null;
    return { mpegts: Number(mpegts[1]), offset: (Number(mpegts[1]) - baseMpegts) / 90000 - parseVttTimestamp(local[1]) };
  }

  function shiftVttCues(text, offset) {
    if (!offset) return text;
    return String(text).replace(/([0-9:.]+)\s+-->\s+([0-9:.]+)/g, (whole, from, to) =>
      `${formatVttTimestamp(parseVttTimestamp(from) + offset)} --> ${formatVttTimestamp(parseVttTimestamp(to) + offset)}`);
  }

  function mergeWebVttParts(parts, mode = "none") {
    const cues = [];
    let baseMpegts = null;
    for (const part of parts) {
      const lines = String(part).replace(/^\uFEFF/, "").split(/\r?\n/);
      let index = (lines[0] || "").startsWith("WEBVTT") ? 1 : 0;
      let offset = 0;
      while (index < lines.length && (lines[index].startsWith("X-TIMESTAMP-MAP") || lines[index].trim() === "")) {
        if (lines[index].startsWith("X-TIMESTAMP-MAP")) {
          const parsed = timestampMapOffset(lines[index], baseMpegts ?? 0);
          if (parsed) {
            if (baseMpegts == null) { baseMpegts = parsed.mpegts; offset = 0; }
            else offset = parsed.offset;
          }
        }
        index += 1;
      }
      const body = lines.slice(index).join("\n").trim();
      if (body) cues.push(shiftVttCues(body, offset));
    }
    const merged = `WEBVTT\n\n${cues.join("\n\n")}\n`;
    return convertSubtitleText(merged, mode);
  }

  // WebVTT and SubRip differ in the header, the decimal separator, cue settings and numbering.
  function webVttToSrt(text) {
    const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
    const blocks = [];
    let current = [];
    for (const line of lines) {
      if (line.trim() === "") {
        if (current.length) blocks.push(current);
        current = [];
        continue;
      }
      current.push(line);
    }
    if (current.length) blocks.push(current);

    const output = [];
    let index = 0;
    for (const block of blocks) {
      const timingLine = block.findIndex((line) => line.includes("-->"));
      if (timingLine < 0) continue;
      const header = block[0];
      if (/^(WEBVTT|NOTE|STYLE|REGION)\b/i.test(header) && timingLine === 0) continue;
      const timing = block[timingLine].replace(/\s+(align|line|position|size|vertical|region):\S+/gi, "").trim();
      const match = /([0-9:.,]+)\s*-->\s*([0-9:.,]+)/.exec(timing);
      if (!match) continue;
      const toSrtTime = (value) => {
        const seconds = parseVttTimestamp(value);
        const whole = Math.floor(seconds);
        const millis = Math.round((seconds - whole) * 1000);
        const hours = Math.floor(whole / 3600);
        const minutes = Math.floor((whole % 3600) / 60);
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
      };
      const body = block.slice(timingLine + 1)
        .map((line) => line.replace(/<[^>]+>/g, ""))
        .filter((line) => line.trim() !== "");
      if (!body.length) continue;
      index += 1;
      output.push(`${index}\n${toSrtTime(match[1])} --> ${toSrtTime(match[2])}\n${body.join("\n")}`);
    }
    return `${output.join("\n\n")}\n`;
  }

  // gRPC-Web puts a 5-byte frame in front of each message: a compression flag and a big-endian
  // length. Parsing the protobuf from offset zero reads that header as a field and fails.
  // A gRPC-Web reply may be server-streaming: one HTTP response, many DATA frames. Returning only
  // the first is how a whole track can look like its opening few minutes.
  // "=" padding appears wherever one encoded frame ends, so the whole string is not valid base64.
  // Decode each padded run separately and join the results.
  function decodeConcatenatedBase64(text) {
    const clean = String(text || "").replace(/\s+/g, "");
    if (!clean) return null;
    const pieces = [];
    let start = 0;
    const padding = /=+/g;
    let match;
    while ((match = padding.exec(clean))) {
      pieces.push(clean.slice(start, match.index + match[0].length));
      start = match.index + match[0].length;
    }
    if (start < clean.length) pieces.push(clean.slice(start));
    const chunks = [];
    let total = 0;
    for (const piece of pieces) {
      if (!piece) continue;
      let decoded;
      try { decoded = atob(piece); }
      catch { return null; }
      const chunk = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index += 1) chunk[index] = decoded.charCodeAt(index);
      chunks.push(chunk);
      total += chunk.length;
    }
    if (!total) return null;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  function grpcWebPayloads(input) {
    const frames = grpcWebFrames(input);
    return frames.length ? frames : [input instanceof Uint8Array ? input : new Uint8Array(input || 0)];
  }

  function grpcWebPayload(input) {
    return grpcWebPayloads(input)[0];
  }

  function grpcWebFrames(input) {
    let bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    // grpc-web-text delivers the same frames base64 encoded, one encoding per frame, concatenated.
    const asText = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64)));
    if (/^[A-Za-z0-9+/=\s]+$/.test(asText) && bytes.length > 8) {
      const converted = decodeConcatenatedBase64(new TextDecoder().decode(bytes));
      if (converted && converted.length > 5 && converted[0] <= 1) bytes = converted;
    }
    const frames = [];
    let position = 0;
    while (position + 5 <= bytes.length) {
      const flag = bytes[position];
      const length = (bytes[position + 1] << 24 >>> 0) + (bytes[position + 2] << 16) + (bytes[position + 3] << 8) + bytes[position + 4];
      if (flag > 1 || length <= 0 || position + 5 + length > bytes.length) break;
      // Flag bit 7 marks the trailer frame, which carries status headers rather than a message.
      if ((flag & 0x80) === 0) frames.push(bytes.subarray(position + 5, position + 5 + length));
      position += 5 + length;
    }
    return frames.length ? frames : [bytes];
  }

  // Subtitle chunks arrive separately and overlap at the seams, so merge on cue identity.

  function mergeVttDocuments(documents) {

    const seen = new Set();

    const cues = [];

    for (const document of documents) {

      const blocks = String(document || "").replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/);

      for (const block of blocks) {

        const body = block.trim();

        if (!body || /^WEBVTT/i.test(body)) continue;

        const timing = /([0-9:.,]+)\s*-->\s*([0-9:.,]+)/.exec(body);

        if (!timing) continue;

        const key = `${parseVttTimestamp(timing[1]).toFixed(3)}|${body.replace(/\s+/g, " ")}`;

        if (seen.has(key)) continue;

        seen.add(key);

        cues.push({ start: parseVttTimestamp(timing[1]), text: body });

      }

    }

    cues.sort((a, b) => a.start - b.start);

    return `WEBVTT\n\n${cues.map((cue) => cue.text).join("\n\n")}\n`;

  }



  // The last cue end tells how much of the video a subtitle really covers, which is the only

  // way to notice that a chunked track stopped where playback stopped.

  function subtitleCoverageSeconds(text) {

    let last = 0;

    const pattern = /-->\s*([0-9:.,]+)/g;

    let match;

    while ((match = pattern.exec(String(text || "")))) last = Math.max(last, parseVttTimestamp(match[1]));

    return last;

  }



  function writeVarint(value) {

    const bytes = [];

    let rest = Math.max(0, Math.floor(Number(value) || 0));

    do {

      const part = rest % 128;

      rest = Math.floor(rest / 128);

      bytes.push(rest > 0 ? part | 0x80 : part);

    } while (rest > 0);

    return Uint8Array.from(bytes);

  }



  // Only the plain-integer fields matter here: a paging cursor is never a string in practice,

  // and guessing at length-delimited fields would corrupt the request.

  function protobufVarintFields(input) {

    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);

    const fields = {};

    let position = 0;

    while (position < bytes.length) {

      const [key, afterKey] = readVarint(bytes, position);

      position = afterKey;

      const wireType = key & 0x07;

      const number = Math.floor(key / 8);

      if (wireType === 0) {

        const [value, afterValue] = readVarint(bytes, position);

        position = afterValue;

        fields[number] = value;

      } else if (wireType === 1) position += 8;

      else if (wireType === 2) {

        const [length, afterLength] = readVarint(bytes, position);

        position = afterLength + length;

      } else if (wireType === 5) position += 4;

      else return fields;

    }

    return fields;

  }



  // Re-encodes one varint field. The new value can be a different byte length, so the message is

  // rebuilt rather than patched in place.

  function protobufSetVarint(input, fieldNumber, value) {

    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);

    const pieces = [];

    let position = 0;

    let replaced = false;

    while (position < bytes.length) {

      const start = position;

      const [key, afterKey] = readVarint(bytes, position);

      position = afterKey;

      const wireType = key & 0x07;

      const number = Math.floor(key / 8);

      if (wireType === 0) {

        const [, afterValue] = readVarint(bytes, position);

        position = afterValue;

        if (number === fieldNumber) {

          pieces.push(bytes.subarray(start, afterKey), writeVarint(value));

          replaced = true;

          continue;

        }

      } else if (wireType === 1) position += 8;

      else if (wireType === 2) {

        const [length, afterLength] = readVarint(bytes, position);

        position = afterLength + length;

      } else if (wireType === 5) position += 4;

      else return null;

      pieces.push(bytes.subarray(start, position));

    }

    if (!replaced) return null;

    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);

    const out = new Uint8Array(total);

    let offset = 0;

    for (const piece of pieces) { out.set(piece, offset); offset += piece.length; }

    return out;

  }



  function grpcWebFrame(payload) {

    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload || 0);

    const framed = new Uint8Array(bytes.length + 5);

    framed[0] = 0;

    framed[1] = (bytes.length >>> 24) & 0xff;

    framed[2] = (bytes.length >>> 16) & 0xff;

    framed[3] = (bytes.length >>> 8) & 0xff;

    framed[4] = bytes.length & 0xff;

    framed.set(bytes, 5);

    return framed;

  }



  // Two or more recorded calls expose the paging parameter by differencing: whatever integer

  // fields moved between them are the cursor, and their spacing is the page size. A start/end

  // pair moves together, which is why several fields are allowed as long as the step matches.

  // One call, or fields moving at different rates, means there is nothing safe to extrapolate.

  function inferSubtitlePaging(payloads) {

    const maps = (payloads || []).map(protobufVarintFields);

    if (maps.length < 2) return null;

    const numbers = new Set();

    for (const map of maps) for (const key of Object.keys(map)) numbers.add(Number(key));

    const fields = [];

    let step = 0;

    for (const number of numbers) {

      if (!maps.every((map) => map[number] != null)) continue;

      const values = Array.from(new Set(maps.map((map) => map[number]))).sort((a, b) => a - b);

      if (values.length < 2) continue;

      const gaps = values.slice(1).map((value, index) => value - values[index]);

      const smallest = Math.min(...gaps);

      if (!(smallest > 0)) return null;

      if (step && smallest !== step) return null;

      step = smallest;

      fields.push({ field: number, max: values[values.length - 1] });

    }

    if (!fields.length || !step) return null;

    return { fields, step };

  }



  function subtitleCueSpan(text) {

    let start = Infinity;

    let end = 0;

    let count = 0;

    const pattern = /([0-9:.,]+)\s*-->\s*([0-9:.,]+)/g;

    let match;

    while ((match = pattern.exec(String(text || "")))) {

      start = Math.min(start, parseVttTimestamp(match[1]));

      end = Math.max(end, parseVttTimestamp(match[2]));

      count += 1;

    }

    return { start: count ? start : 0, end, count };

  }



  // With a single recorded call there is nothing to difference, but the cursor can still be found

  // by experiment: change one integer field, ask again, and see whether the reply moved forward.

  // Ordered so the likeliest shapes go first — a position in seconds, then milliseconds, then a

  // plain page index — because every probe costs one request.

  function subtitlePagingProbes(payload, span) {

    const fields = protobufVarintFields(payload);

    const chunk = Math.max(1, Math.round((span?.end || 0) - (span?.start || 0)));

    const probes = [];

    for (const step of [chunk, chunk * 1000, 1]) {

      for (const [key, value] of Object.entries(fields)) {

        const field = Number(key);

        if (probes.some((probe) => probe.field === field && probe.step === step)) continue;

        probes.push({ field, step, value: value + step });

      }

    }

    return probes;

  }



  // Describes a protobuf message without interpreting it, for diagnostics. String values are

  // reduced to a length and a short ASCII preview: these bodies carry session tokens and must

  // never be reproduced in full into something the user might paste elsewhere.

  function protobufShape(input) {

    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);

    const parts = [];

    let position = 0;

    while (position < bytes.length) {

      const [key, afterKey] = readVarint(bytes, position);

      position = afterKey;

      const wireType = key & 0x07;

      const number = Math.floor(key / 8);

      if (wireType === 0) {

        const [value, afterValue] = readVarint(bytes, position);

        position = afterValue;

        parts.push(`${number}=int:${value}`);

      } else if (wireType === 1) { parts.push(`${number}=fixed64`); position += 8; }

      else if (wireType === 2) {

        const [length, afterLength] = readVarint(bytes, position);

        position = afterLength;

        const preview = new TextDecoder().decode(bytes.subarray(position, position + Math.min(length, 8))).replace(/[^\x20-\x7e]/g, ".");

        position += length;

        parts.push(`${number}=bytes[${length}]:${preview}`);

      } else if (wireType === 5) { parts.push(`${number}=fixed32`); position += 4; }

      else { parts.push(`${number}=wire${wireType}?`); break; }

    }

    return parts.join(", ") || "(empty)";

  }



  // A request carrying nothing but an identifier has no cursor to advance, so whatever comes back

  // is everything the site offers for that video. Saying "the cursor might be a string token"

  // in that case sends the user chasing something that does not exist.

  function subtitlePagingAbsent(payload) {

    const shape = protobufShape(payload);

    const fieldCount = shape === "(empty)" ? 0 : shape.split(", ").length;

    return Object.keys(protobufVarintFields(payload)).length <= 1 && fieldCount <= 2;

  }



  function missingTimeline(segments, savedSequences, skippableSequences) {
    const saved = savedSequences instanceof Set ? savedSequences : new Set(savedSequences || []);
    const skippable = skippableSequences instanceof Set ? skippableSequences : new Set(skippableSequences || []);
    const missing = (segments || []).filter((item) => !item.gap && !saved.has(item.sequence) && !skippable.has(item.sequence)).sort((a, b) => a.sequence - b.sequence);
    const ranges = [];
    for (const segment of missing) {
      const previous = ranges[ranges.length - 1];
      if (previous && segment.sequence === previous.sequenceTo + 1) {
        previous.sequenceTo = segment.sequence;
        previous.endSeconds = Number(segment.endSeconds || previous.endSeconds || 0);
        previous.count += 1;
      } else {
        ranges.push({ sequenceFrom: segment.sequence, sequenceTo: segment.sequence, startSeconds: Number(segment.startSeconds || 0), endSeconds: Number(segment.endSeconds || segment.startSeconds || 0), count: 1 });
      }
    }
    return ranges;
  }

  function findTsSync(source) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source || 0);
    const limit = Math.min(bytes.byteLength, 188);
    for (let offset = 0; offset < limit; offset += 1) {
      if (bytes[offset] !== 0x47) continue;
      if (offset + 376 <= bytes.byteLength && bytes[offset + 188] === 0x47 && bytes[offset + 376] === 0x47) return offset;
      if (offset + 188 <= bytes.byteLength && bytes[offset + 188] === 0x47) return offset;
      if (offset + 188 <= bytes.byteLength) return offset;
    }
    return -1;
  }

  function readPts33(bytes, offset) {
    if (offset + 5 > bytes.byteLength) return null;
    const pts = (
      ((bytes[offset] >> 1) & 0x07) * 0x40000000
      + (bytes[offset + 1] << 22)
      + (((bytes[offset + 2] >> 1) & 0x7f) << 15)
      + (bytes[offset + 3] << 7)
      + ((bytes[offset + 4] >> 1) & 0x7f)
    );
    return Number.isFinite(pts) ? pts : null;
  }

  function readPcrBase(bytes, packetOffset) {
    const flags = bytes[packetOffset + 3];
    const adaptation = (flags >> 4) & 3;
    if (adaptation !== 2 && adaptation !== 3) return null;
    const adaptationLength = bytes[packetOffset + 4];
    if (!adaptationLength || packetOffset + 5 >= bytes.byteLength) return null;
    const adaptationFlags = bytes[packetOffset + 5];
    if (!(adaptationFlags & 0x10) || packetOffset + 11 >= bytes.byteLength) return null;
    return (
      bytes[packetOffset + 6] * 0x2000000
      + bytes[packetOffset + 7] * 0x20000
      + bytes[packetOffset + 8] * 0x200
      + bytes[packetOffset + 9] * 2
      + (bytes[packetOffset + 10] >> 7)
    );
  }

  function transportTimestamps(input) {
    const source = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    const sync = findTsSync(source);
    if (sync < 0) return { ok: false, firstPts: null, lastPts: null, firstPcr: null, lastPcr: null, ptsCount: 0 };
    const bytes = source.subarray(sync);
    let firstPts = null;
    let lastPts = null;
    let firstPcr = null;
    let lastPcr = null;
    let ptsCount = 0;
    for (let offset = 0; offset + 188 <= bytes.byteLength; offset += 188) {
      if (bytes[offset] !== 0x47) break;
      const pcr = readPcrBase(bytes, offset);
      if (pcr != null) {
        if (firstPcr == null) firstPcr = pcr;
        lastPcr = pcr;
      }
      if (!(bytes[offset + 1] & 0x40)) continue;
      const payload = transportPayload(bytes, offset);
      if (payload == null || payload + 9 > offset + 188) continue;
      if (bytes[payload] !== 0x00 || bytes[payload + 1] !== 0x00 || bytes[payload + 2] !== 0x01) continue;
      const streamId = bytes[payload + 3];
      if (streamId < 0xbd || streamId === 0xbe || streamId === 0xbf || streamId === 0xf0) continue;
      const ptsDtsFlags = (bytes[payload + 7] >> 6) & 0x03;
      if (ptsDtsFlags !== 2 && ptsDtsFlags !== 3) continue;
      const pts = readPts33(bytes, payload + 9);
      if (pts == null) continue;
      if (firstPts == null) firstPts = pts;
      lastPts = pts;
      ptsCount += 1;
    }
    return { ok: firstPts != null || firstPcr != null, firstPts, lastPts, firstPcr, lastPcr, ptsCount };
  }

  function ptsDeltaSeconds(fromPts, toPts) {
    if (fromPts == null || toPts == null || !Number.isFinite(fromPts) || !Number.isFinite(toPts)) return null;
    let delta = Number(toPts) - Number(fromPts);
    const MOD = 0x200000000; // 2^33
    if (delta < -MOD / 2) delta += MOD;
    if (delta > MOD / 2) delta -= MOD;
    return delta / 90000;
  }

  function assessSkippedSegmentContinuity({
    previousLastPts = null,
    nextFirstPts = null,
    previousLastPcr = null,
    nextFirstPcr = null,
    expectedDurationSeconds = 0
  } = {}) {
    const expected = Math.max(0.05, Number(expectedDurationSeconds) || 0);
    let deltaSeconds = ptsDeltaSeconds(previousLastPts, nextFirstPts);
    let clock = "pts";
    if (deltaSeconds == null) {
      deltaSeconds = ptsDeltaSeconds(previousLastPcr, nextFirstPcr);
      clock = "pcr";
    }
    if (deltaSeconds == null) return { status: "unknown", reason: "NO_TIMESTAMPS", deltaSeconds: null, expectedSeconds: expected, clock };
    // Neighbors already abut: the skipped slice carried no media timeline.
    if (deltaSeconds <= Math.max(0.35, expected * 0.25)) {
      return { status: "skippable", reason: "NEIGHBORS_CONTINUOUS", deltaSeconds, expectedSeconds: expected, clock };
    }
    // Gap roughly matches the playlist duration for the skipped item: real content is missing.
    if (Math.abs(deltaSeconds - expected) <= Math.max(0.75, expected * 0.4)) {
      return { status: "needed", reason: "GAP_MATCHES_DURATION", deltaSeconds, expectedSeconds: expected, clock };
    }
    if (deltaSeconds > Math.max(expected * 0.5, 0.8)) {
      return { status: "needed", reason: "GAP_TOO_LARGE", deltaSeconds, expectedSeconds: expected, clock };
    }
    return { status: "unknown", reason: "AMBIGUOUS_GAP", deltaSeconds, expectedSeconds: expected, clock };
  }

  function assessAdjacentSegmentContinuity({
    previousLastPts = null,
    nextFirstPts = null,
    previousLastPcr = null,
    nextFirstPcr = null,
    previousDurationSeconds = 0,
    playlistDiscontinuity = false
  } = {}) {
    if (playlistDiscontinuity) return { status: "ok", reason: "PLAYLIST_DISCONTINUITY", deltaSeconds: null, expectedSeconds: Number(previousDurationSeconds) || 0, clock: null };
    const expected = Math.max(0.05, Number(previousDurationSeconds) || 0);
    let deltaSeconds = ptsDeltaSeconds(previousLastPts, nextFirstPts);
    let clock = "pts";
    if (deltaSeconds == null) {
      deltaSeconds = ptsDeltaSeconds(previousLastPcr, nextFirstPcr);
      clock = "pcr";
    }
    if (deltaSeconds == null) return { status: "unknown", reason: "NO_TIMESTAMPS", deltaSeconds: null, expectedSeconds: expected, clock };
    // Normal join: slight overlap/backstep or a short forward step is fine.
    if (deltaSeconds >= -0.75 && deltaSeconds <= Math.max(1.25, expected * 0.4)) {
      return { status: "ok", reason: "CONTINUOUS", deltaSeconds, expectedSeconds: expected, clock };
    }
    // New session / re-encode often resets PTS near zero relative to the previous tail.
    if (deltaSeconds < -1.5) {
      return { status: "shifted", reason: "PTS_RESET_OR_JUMP_BACK", deltaSeconds, expectedSeconds: expected, clock };
    }
    // A forward jump far beyond the previous segment duration means the clocks no longer match.
    if (deltaSeconds > Math.max(expected * 1.8, expected + 2.5, 3)) {
      return { status: "shifted", reason: "PTS_FORWARD_JUMP", deltaSeconds, expectedSeconds: expected, clock };
    }
    return { status: "unknown", reason: "AMBIGUOUS_JOIN", deltaSeconds, expectedSeconds: expected, clock };
  }

  function mp4TrackTypes(bytes) {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    const types = [];
    const moov = mp4Boxes(source).find((box) => box.type === "moov");
    if (!moov) return types;
    for (const trak of mp4Boxes(source, moov.dataStart, moov.end).filter((box) => box.type === "trak")) {
      const mdia = mp4Boxes(source, trak.dataStart, trak.end).find((box) => box.type === "mdia");
      if (!mdia) continue;
      const hdlr = mp4Boxes(source, mdia.dataStart, mdia.end).find((box) => box.type === "hdlr");
      if (!hdlr || hdlr.dataStart + 12 > source.byteLength) continue;
      const handler = String.fromCharCode(...source.subarray(hdlr.dataStart + 8, hdlr.dataStart + 12));
      if (handler === "vide") types.push("video");
      else if (handler === "soun") types.push("audio");
      else if (handler) types.push(handler);
    }
    return types;
  }

  function transportPayload(bytes, packetOffset) {
    const flags = bytes[packetOffset + 3];
    const adaptation = (flags >> 4) & 3;
    if (adaptation === 0 || adaptation === 2) return null;
    let offset = packetOffset + 4;
    if (adaptation === 3) offset += 1 + bytes[offset];
    return offset < packetOffset + 188 ? offset : null;
  }

  function transportSection(bytes, wantedPid, tableId) {
    for (let offset = 0; offset + 188 <= bytes.byteLength; offset += 188) {
      if (bytes[offset] !== 0x47) continue;
      const pid = ((bytes[offset + 1] & 0x1f) << 8) | bytes[offset + 2];
      if (pid !== wantedPid || !(bytes[offset + 1] & 0x40)) continue;
      let payload = transportPayload(bytes, offset);
      if (payload == null) continue;
      payload += 1 + bytes[payload];
      if (payload + 3 <= offset + 188 && bytes[payload] === tableId) return payload;
    }
    return -1;
  }

  function inspectTransportStream(input) {
    const source = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    let sync = -1;
    for (let offset = 0; offset < Math.min(188, source.byteLength); offset += 1) {
      if (source[offset] === 0x47 && source[offset + 188] === 0x47 && source[offset + 376] === 0x47) { sync = offset; break; }
    }
    if (sync < 0) return { container: "unknown", hasVideo: false, hasAudio: false, streamTypes: [] };
    const bytes = source.subarray(sync);
    const pat = transportSection(bytes, 0, 0x00);
    let pmtPid = -1;
    if (pat >= 0) {
      const sectionLength = ((bytes[pat + 1] & 0x0f) << 8) | bytes[pat + 2];
      const end = Math.min(bytes.byteLength, pat + 3 + sectionLength - 4);
      for (let cursor = pat + 8; cursor + 4 <= end; cursor += 4) {
        const program = (bytes[cursor] << 8) | bytes[cursor + 1];
        if (program) { pmtPid = ((bytes[cursor + 2] & 0x1f) << 8) | bytes[cursor + 3]; break; }
      }
    }
    const streamTypes = [];
    if (pmtPid >= 0) {
      const pmt = transportSection(bytes, pmtPid, 0x02);
      if (pmt >= 0) {
        const sectionLength = ((bytes[pmt + 1] & 0x0f) << 8) | bytes[pmt + 2];
        const end = Math.min(bytes.byteLength, pmt + 3 + sectionLength - 4);
        const programInfoLength = ((bytes[pmt + 10] & 0x0f) << 8) | bytes[pmt + 11];
        for (let cursor = pmt + 12 + programInfoLength; cursor + 5 <= end;) {
          streamTypes.push(bytes[cursor]);
          const infoLength = ((bytes[cursor + 3] & 0x0f) << 8) | bytes[cursor + 4];
          cursor += 5 + infoLength;
        }
      }
    }
    const videoTypes = new Set([0x01, 0x02, 0x10, 0x1b, 0x24, 0x42, 0xd1, 0xea]);
    const audioTypes = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);
    return {
      container: "mpegts",
      hasVideo: streamTypes.some((type) => videoTypes.has(type)),
      hasAudio: streamTypes.some((type) => audioTypes.has(type)),
      streamTypes
    };
  }

  function inspectMediaBytes(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(256, bytes.byteLength))).trimStart().toLowerCase();
    if (prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || prefix.startsWith("{") || prefix.startsWith("[")) {
      return { container: "document", hasVideo: false, hasAudio: false, trackTypes: [] };
    }
    const top = mp4Boxes(bytes);
    if (top.some((box) => ["ftyp", "styp", "moov", "moof"].includes(box.type))) {
      const trackTypes = mp4TrackTypes(bytes);
      return { container: "mp4", hasVideo: trackTypes.includes("video"), hasAudio: trackTypes.includes("audio"), trackTypes };
    }
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return { container: "webm", hasVideo: null, hasAudio: null, trackTypes: [] };
    }
    return inspectTransportStream(bytes);
  }

  function directFileScore(item = {}) {
    const type = String(item.contentType || "").toLowerCase();
    const name = String(item.fileName || item.url || "").toLowerCase();
    let score = Math.log2(Math.max(1, Number(item.contentLength || 0)));
    if (type.startsWith("video/")) score += 1000;
    if (type.startsWith("audio/")) score -= 1000;
    if (/\.(?:mp4|webm|mkv|mov|m4v)(?:[?#]|$)/i.test(name)) score += 500;
    if (/\.(?:mp3|m4a|aac|flac|ogg|wav)(?:[?#]|$)/i.test(name)) score -= 500;
    if (item.requestType === "media") score += 100;
    return score;
  }

  function directFile(candidate) {
    const files = (candidate?.directFiles || []).filter((item) => item?.url);
    if (files.length) return [...files].sort((a, b) => directFileScore(b) - directFileScore(a) || Number(b.contentLength || 0) - Number(a.contentLength || 0) || Number(b.lastSeen || 0) - Number(a.lastSeen || 0))[0];
    const url = candidate?.directUrl || (DIRECT_FILE_RE.test(candidate?.lastUrl || "") ? candidate.lastUrl : "");
    return url ? { url, contentType: candidate?.contentType || "", contentLength: candidate?.contentLength || 0, fileName: candidate?.fileName || "", headers: candidate?.headers || {} } : null;
  }

  const providers = [
    {
      id: "browser-assisted",
      priority: 100,
      matches(candidate, mode) { return mode === "browser-assisted"; }
    },
    {
      id: "direct-file",
      priority: 90,
      matches(candidate, mode) {
        return mode === "direct" && Boolean(directFile(candidate));
      }
    },
    {
      id: "hls",
      priority: 80,
      matches(candidate, mode) {
        return mode === "direct" && Boolean(candidate?.playlistUrl || HLS_RE.test(candidate?.lastUrl || "") || /\.(ts|m4s|aac)(?:[?#]|$)/i.test(candidate?.segmentUrl || ""));
      }
    },
    {
      id: "dash",
      priority: 70,
      matches(candidate, mode) {
        return mode === "direct" && Boolean(candidate?.manifestUrl || DASH_RE.test(candidate?.lastUrl || ""));
      }
    }
  ];

  function selectProvider(candidate, mode) {
    return [...providers].sort((a, b) => b.priority - a.priority).find((provider) => provider.matches(candidate, mode)) || null;
  }

  function registerProvider(provider) {
    if (!provider?.id || typeof provider.matches !== "function") throw new TypeError("provider requires id and matches()");
    const existing = providers.findIndex((item) => item.id === provider.id);
    if (existing >= 0) providers.splice(existing, 1, provider); else providers.push(provider);
  }

  function extensionFromUrl(url, fallback = "mp4") {
    try { return new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1].toLowerCase() || fallback; }
    catch { return fallback; }
  }

  function extensionForCandidate(candidate, fallback = "mp4") {
    const selected = directFile(candidate);
    const fromUrl = `${selected?.fileName || ""} ${selected?.url || ""}`.match(DIRECT_FILE_RE)?.[1]?.toLowerCase() || "";
    if (fromUrl) return fromUrl;
    return ({
      "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv",
      "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/webm": "webm", "audio/flac": "flac",
      "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav"
    })[String(selected?.contentType || candidate?.contentType || "").toLowerCase()] || fallback;
  }

  function directFileUrl(candidate) {
    return directFile(candidate)?.url || "";
  }

  const api = {
    providers, selectProvider, registerProvider,
    parseAttributeList, normalizeByteRange, rangeHeader, parseHlsPlaylist,
    isoDurationSeconds, expandDashTimeline, parseDashManifest, selectDashTracks,
    mp4Boxes, concatBytes, makeMp4Box, mergeCmafInitializations, patchCmafFragmentTrackId, patchMp4InitDuration, buildSidx, buildFreeBox, sidxByteLength,
    mp4TrackTypes, inspectTransportStream, inspectMediaBytes, transportTimestamps,
    ptsDeltaSeconds, assessSkippedSegmentContinuity, assessAdjacentSegmentContinuity,
    classifyMediaError, missingTimeline, convertSubtitleText, mergeWebVttParts, mergeVttDocuments, subtitleCoverageSeconds, protobufVarintFields, protobufSetVarint, grpcWebFrame, inferSubtitlePaging, subtitleCueSpan, subtitlePagingProbes, webVttToSrt, unconvertedChineseCount, shiftVttCues, SUBTITLE_MODES, protobufStringField, protobufStringFields, protobufShape, subtitlePagingAbsent, grpcWebPayload, grpcWebPayloads, decodeConcatenatedBase64, jwtPayload, subtitleUserIdFromHeaders, normalizeMediaUrl, sequenceFromUrl, segmentLookup, dashCaptureIndex, mergeDashCaptureTracks,
    extensionFromUrl, extensionForCandidate, directFile, directFileUrl
  };
  root.WebKeeperMediaEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
