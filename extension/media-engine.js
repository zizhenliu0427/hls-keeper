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
    const manifestBaseUrl = inheritedBaseUrl(manifestUrl, mpd);
    for (const adaptation of xmlChildren(period, "AdaptationSet")) {
      for (const representationNode of xmlChildren(adaptation, "Representation")) {
        const track = dashTrackFromRepresentation({ representationNode, adaptationNode: adaptation, periodNode: period, manifestUrl: manifestBaseUrl, periodDuration: duration });
        if (track.segments.length || track.initializationUrl) tracks.push(track);
      }
    }
    return { url: manifestUrl, text, type: mpd.attrs.type || "static", duration, minimumUpdatePeriod: isoDurationSeconds(mpd.attrs.minimumUpdatePeriod || ""), drm, tracks };
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

  function missingTimeline(segments, savedSequences) {
    const saved = savedSequences instanceof Set ? savedSequences : new Set(savedSequences || []);
    const missing = (segments || []).filter((item) => !item.gap && !saved.has(item.sequence)).sort((a, b) => a.sequence - b.sequence);
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
    mp4Boxes, concatBytes, makeMp4Box, mergeCmafInitializations, patchCmafFragmentTrackId, patchMp4InitDuration,
    mp4TrackTypes, inspectTransportStream, inspectMediaBytes,
    classifyMediaError, missingTimeline, normalizeMediaUrl, sequenceFromUrl, segmentLookup, dashCaptureIndex, mergeDashCaptureTracks,
    extensionFromUrl, extensionForCandidate, directFile, directFileUrl
  };
  root.WebKeeperMediaEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
