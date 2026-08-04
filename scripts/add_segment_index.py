# -*- coding: utf-8 -*-
"""Adds a segment index (sidx) to an already-merged fragmented MP4.

A fragmented MP4 with no sidx forces a player to walk every moof in the file before it can report
a duration or seek. On a local disk that is unnoticeable; over a network share it is minutes of
waiting before playback starts.

A sidx has to sit before the fragments it indexes, and an existing file has no room for it, so the
file is rewritten: the same bytes with the index spliced in after moov. Nothing is decoded and
nothing is re-encoded, so this runs at whatever the storage can stream.

Usage:
    python scripts/add_segment_index.py FILE [FILE ...]
    python scripts/add_segment_index.py --check FILE      # report only, write nothing
"""
from __future__ import annotations

import argparse
import os
import shutil
import struct
import sys
import time
from pathlib import Path

COPY_CHUNK = 8 * 1024 * 1024
TIMESCALE = 90000


def read_box_header(handle):
    """Returns (name, header_size, box_size) or None at end of file."""
    start = handle.tell()
    header = handle.read(8)
    if len(header) < 8:
        return None
    size = struct.unpack(">I", header[:4])[0]
    name = header[4:8].decode("latin-1")
    header_size = 8
    if size == 1:
        extended = handle.read(8)
        if len(extended) < 8:
            return None
        size = struct.unpack(">Q", extended)[0]
        header_size = 16
    elif size == 0:
        size = handle.seek(0, 2) - start
        handle.seek(start + 8)
    return name, header_size, size


def scan(path: Path):
    """Walks the top-level boxes once, collecting where moov ends and the fragment layout."""
    fragments = []          # (offset, size) of each moof+mdat pair
    moov_end = None
    has_sidx = False
    with path.open("rb") as handle:
        total = handle.seek(0, 2)
        handle.seek(0)
        offset = 0
        pending = None      # a moof waiting for its mdat
        while offset < total:
            handle.seek(offset)
            box = read_box_header(handle)
            if box is None:
                break
            name, _, size = box
            if size <= 0:
                break
            if name == "sidx":
                has_sidx = True
            if name == "moov":
                moov_end = offset + size
            if name == "moof":
                if pending is not None:
                    fragments.append(pending)
                pending = (offset, size)
            elif name == "mdat" and pending is not None:
                fragments.append((pending[0], pending[1] + size))
                pending = None
            offset += size
        if pending is not None:
            fragments.append(pending)
    return {"total": total, "moov_end": moov_end, "fragments": fragments, "has_sidx": has_sidx}


def sidx_bytes(references, earliest=0, timescale=TIMESCALE):
    """ISO/IEC 14496-12 8.16.3, version 1 (64-bit times). Header is 40 bytes."""
    payload = bytearray(40 + len(references) * 12)
    struct.pack_into(">I", payload, 0, len(payload))
    payload[4:8] = b"sidx"
    payload[8] = 1                                   # version
    struct.pack_into(">I", payload, 12, 1)           # reference_ID
    struct.pack_into(">I", payload, 16, timescale)
    struct.pack_into(">Q", payload, 20, max(0, int(earliest)))
    struct.pack_into(">Q", payload, 28, 0)           # first_offset
    struct.pack_into(">H", payload, 36, 0)           # reserved
    struct.pack_into(">H", payload, 38, len(references))
    for index, (size, duration) in enumerate(references):
        at = 40 + index * 12
        struct.pack_into(">I", payload, at, int(size) & 0x7FFFFFFF)
        struct.pack_into(">I", payload, at + 4, max(0, int(duration)))
        struct.pack_into(">I", payload, at + 8, 0x90000000)   # starts_with_SAP, SAP type 1
    return bytes(payload)


def count_tracks(path: Path) -> int:
    """The remuxer emits one fragment per track per source segment, so the number of tracks is how
    many consecutive fragments cover the same slice of time. Indexing them individually would make
    the index claim twice as many seconds as the video has."""
    tracks = 0
    with path.open("rb") as handle:
        total = handle.seek(0, 2)
        handle.seek(0)
        offset = 0
        while offset < total:
            handle.seek(offset)
            box = read_box_header(handle)
            if box is None:
                break
            name, header_size, size = box
            if name == "moov":
                inner = offset + header_size
                stop = offset + size
                while inner < stop:
                    handle.seek(inner)
                    child = read_box_header(handle)
                    if child is None:
                        break
                    child_name, _, child_size = child
                    if child_name == "trak":
                        tracks += 1
                    if child_size <= 0:
                        break
                    inner += child_size
                break
            if size <= 0:
                break
            offset += size
    return max(1, tracks)


def total_duration_ticks(path: Path, moov_end: int) -> int:
    """Reads mvhd for the presentation duration, so per-fragment durations can be apportioned."""
    with path.open("rb") as handle:
        handle.seek(0)
        total = handle.seek(0, 2)
        handle.seek(0)
        offset = 0
        while offset < total:
            handle.seek(offset)
            box = read_box_header(handle)
            if box is None:
                break
            name, header_size, size = box
            if name == "moov":
                inner = offset + header_size
                stop = offset + size
                while inner < stop:
                    handle.seek(inner)
                    child = read_box_header(handle)
                    if child is None:
                        break
                    child_name, child_header, child_size = child
                    if child_name == "mvhd":
                        handle.seek(inner + child_header)
                        version = handle.read(1)[0]
                        handle.seek(inner + child_header + 4)
                        if version == 1:
                            handle.read(16)
                            timescale = struct.unpack(">I", handle.read(4))[0]
                            duration = struct.unpack(">Q", handle.read(8))[0]
                        else:
                            handle.read(8)
                            timescale = struct.unpack(">I", handle.read(4))[0]
                            duration = struct.unpack(">I", handle.read(4))[0]
                        if timescale:
                            return int(duration * TIMESCALE / timescale)
                        return 0
                    if child_size <= 0:
                        break
                    inner += child_size
                break
            if size <= 0:
                break
            offset += size
    return 0


def retrofit(path: Path, dry_run: bool = False) -> bool:
    started = time.time()
    info = scan(path)
    fragments = info["fragments"]
    print(f"{path.name}")
    print(f"  {info['total'] / 1e9:.2f} GB, {len(fragments)} fragments, sidx present: {info['has_sidx']}")
    if info["has_sidx"]:
        print("  already indexed, nothing to do")
        return True
    if not fragments or info["moov_end"] is None:
        print("  not a fragmented MP4 (no moof chain) — nothing to add")
        return True

    duration_ticks = total_duration_ticks(path, info["moov_end"])
    tracks = count_tracks(path)
    # One index entry per slice of time, not per fragment: consecutive fragments of the different
    # tracks describe the same seconds and must be referenced together.
    groups = []
    for start in range(0, len(fragments), tracks):
        chunk = fragments[start:start + tracks]
        groups.append(sum(size for _, size in chunk))
    per_group = duration_ticks // len(groups) if duration_ticks and groups else 0
    if not per_group:
        print("  could not read a duration from mvhd; refusing to write a misleading index")
        return False
    print(f"  {tracks} tracks -> {len(groups)} indexed subsegments over {duration_ticks / TIMESCALE / 60:.1f} min")
    references = [(size, per_group) for size in groups]
    index = sidx_bytes(references)
    print(f"  index: {len(index) / 1e6:.2f} MB, {per_group / TIMESCALE:.3f}s per subsegment")
    if dry_run:
        return True

    free = shutil.disk_usage(path.parent).free
    if free < info["total"] + len(index) + 64 * 1024 * 1024:
        print(f"  not enough free space: need {(info['total'] + len(index)) / 1e9:.1f} GB, have {free / 1e9:.1f} GB")
        return False

    target = path.with_suffix(path.suffix + ".indexed")
    copied = 0
    with path.open("rb") as source, target.open("wb") as sink:
        head = source.read(info["moov_end"])
        sink.write(head)
        sink.write(index)
        while True:
            chunk = source.read(COPY_CHUNK)
            if not chunk:
                break
            sink.write(chunk)
            copied += len(chunk)
    backup = path.with_suffix(path.suffix + ".noindex")
    os.replace(path, backup)
    os.replace(target, path)
    elapsed = time.time() - started
    rate = (copied / 1e6 / elapsed) if elapsed else 0
    print(f"  done in {elapsed:.0f}s ({rate:.0f} MB/s). Original kept as {backup.name}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--check", action="store_true", help="report what would be done, write nothing")
    args = parser.parse_args()
    ok = True
    for path in args.files:
        if not path.is_file():
            print(f"{path}: not a file")
            ok = False
            continue
        try:
            ok = retrofit(path, dry_run=args.check) and ok
        except Exception as error:                     # noqa: BLE001 - report and continue
            print(f"{path.name}: failed — {error}")
            ok = False
        print()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
