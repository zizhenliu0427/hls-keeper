"use strict";

const fs = require("fs");
const path = require("path");
const engine = require("../extension/media-engine.js");

const directory = process.argv[2];
if (!directory) throw new Error("Usage: node scripts/verify_dash_mux.js <sample-directory>");

const read = (name) => new Uint8Array(fs.readFileSync(path.join(directory, name)));
const videoPrefix = "bbb_30fps_320x180_200k_bbb_30fps_320x180_200k_";
const audioPrefix = "bbb_a64k_bbb_a64k_";
const initialization = engine.mergeCmafInitializations(read(`${videoPrefix}0.m4v`), read(`${audioPrefix}0.m4a`));
const parts = [initialization.bytes];

for (let index = 1; index <= 3; index += 1) {
  parts.push(read(`${videoPrefix}${index}.m4v`));
  parts.push(engine.patchCmafFragmentTrackId(read(`${audioPrefix}${index}.m4a`), initialization.oldAudioTrackId, initialization.audioTrackId));
}

const output = engine.concatBytes(parts);
const outputPath = path.join(directory, "webkeeper-dash-mux-smoke.mp4");
fs.writeFileSync(outputPath, output);
process.stdout.write(`${outputPath}\n${output.byteLength}\n`);
