#!/usr/bin/env python3
"""Inspect and safely extract uploaded ZIP archives for camelAI agents."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


MAX_ENTRIES = 2_000
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_TOTAL_BYTES = 250 * 1024 * 1024
MAX_COMPRESSION_RATIO = 2_000
MAX_ENTRY_PATH_LENGTH = 1_024
MAX_READ_BYTES = 32 * 1024
MAX_LIST_LIMIT = 500
SUPPORTED_COMPRESSION = {
    zipfile.ZIP_STORED,
    zipfile.ZIP_DEFLATED,
    zipfile.ZIP_BZIP2,
    zipfile.ZIP_LZMA,
}


class ArchiveError(Exception):
    pass


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ArchiveError(f"{name} must be an integer") from error
    return max(minimum, min(maximum, value))


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _archive_path() -> Path:
    raw = _env("CAMELAI_ARCHIVE_PATH").strip()
    if not raw:
        raise ArchiveError("archive path is required")
    allowed_root = Path(_env("CAMELAI_ARCHIVE_ALLOWED_ROOT", "/uploads")).resolve()
    archive = Path(raw).resolve()
    if not _is_within(archive, allowed_root):
        raise ArchiveError("archive must be inside the read-only uploads mount")
    if not archive.is_file():
        raise ArchiveError("archive was not found in uploads")
    if not zipfile.is_zipfile(archive):
        raise ArchiveError("uploaded file is not a valid ZIP archive")
    return archive


def _normalize_member_path(filename: str) -> tuple[str, list[str]]:
    issues: list[str] = []
    if "\x00" in filename:
        return filename, ["path contains a NUL byte"]
    if any(ord(character) < 32 or ord(character) == 127 for character in filename):
        issues.append("control characters are not allowed in paths")

    portable = filename.replace("\\", "/")
    if portable.startswith("/") or re.match(r"^[A-Za-z]:", portable):
        issues.append("absolute paths are not allowed")

    raw_parts = portable.rstrip("/").split("/")
    if any(part == ".." for part in raw_parts):
        issues.append("parent traversal is not allowed")
    parts = [part for part in raw_parts if part not in ("", ".")]
    normalized = "/".join(parts)
    if not normalized:
        issues.append("entry has no usable path")
    if len(normalized) > MAX_ENTRY_PATH_LENGTH:
        issues.append(f"path exceeds {MAX_ENTRY_PATH_LENGTH} characters")
    return normalized, issues


def _entry_kind(info: zipfile.ZipInfo) -> tuple[str, list[str]]:
    if info.is_dir():
        return "directory", []
    if info.create_system != 3:
        return "file", []

    mode = info.external_attr >> 16
    kind = stat.S_IFMT(mode)
    if kind in (0, stat.S_IFREG):
        return "file", []
    if kind == stat.S_IFLNK:
        return "symlink", ["symbolic links are not allowed"]
    return "special", ["special filesystem entries are not allowed"]


def _compression_name(value: int) -> str:
    names = {
        zipfile.ZIP_STORED: "stored",
        zipfile.ZIP_DEFLATED: "deflate",
        zipfile.ZIP_BZIP2: "bzip2",
        zipfile.ZIP_LZMA: "lzma",
    }
    return names.get(value, f"unsupported-{value}")


def _manifest(archive: zipfile.ZipFile) -> tuple[list[dict[str, object]], list[str]]:
    entries: list[dict[str, object]] = []
    archive_issues: list[str] = []
    seen: set[str] = set()
    files: set[str] = set()
    directories: set[str] = set()
    total_bytes = 0

    infos = archive.infolist()
    if len(infos) > MAX_ENTRIES:
        archive_issues.append(f"archive has {len(infos)} entries; maximum is {MAX_ENTRIES}")

    for info in infos:
        path, issues = _normalize_member_path(info.filename)
        kind, kind_issues = _entry_kind(info)
        issues.extend(kind_issues)
        encrypted = bool(info.flag_bits & 0x1)
        if encrypted:
            issues.append("encrypted entries are not supported")
        if info.compress_type not in SUPPORTED_COMPRESSION:
            issues.append(f"compression method {info.compress_type} is not supported")
        if info.file_size > MAX_FILE_BYTES:
            issues.append(f"file exceeds the {MAX_FILE_BYTES}-byte per-file limit")
        if info.file_size > 1024 * 1024:
            ratio = info.file_size / max(info.compress_size, 1)
            if ratio > MAX_COMPRESSION_RATIO:
                issues.append("compression ratio is too high")

        if path in seen:
            issues.append("duplicate normalized path")
        elif path:
            seen.add(path)

        if path:
            parent_parts = PurePosixPath(path).parents
            if kind == "directory":
                if path in files:
                    issues.append("path conflicts with a file entry")
                directories.add(path)
            elif kind == "file":
                if path in directories:
                    issues.append("path conflicts with a directory entry")
                files.add(path)
            for parent in parent_parts:
                parent_text = str(parent)
                if parent_text == ".":
                    continue
                if parent_text in files:
                    issues.append(f"parent path {parent_text!r} is also a file")
                    break

        total_bytes += info.file_size
        entries.append(
            {
                "path": path,
                "type": kind,
                "size": info.file_size,
                "compressedSize": info.compress_size,
                "compression": _compression_name(info.compress_type),
                "encrypted": encrypted,
                "extractable": not issues,
                "issues": issues,
                "_info": info,
            }
        )

    # Detect file/parent conflicts independently of central-directory order.
    # For example, both "a/b.txt" and a regular file named "a" cannot be
    # materialized safely even when the child entry appears first in the ZIP.
    for entry in entries:
        path = str(entry["path"])
        issues = entry["issues"]
        assert isinstance(issues, list)
        if path:
            if entry["type"] == "directory" and path in files:
                if "path conflicts with a file entry" not in issues:
                    issues.append("path conflicts with a file entry")
            if entry["type"] == "file" and path in directories:
                if "path conflicts with a directory entry" not in issues:
                    issues.append("path conflicts with a directory entry")
            for parent in PurePosixPath(path).parents:
                parent_text = str(parent)
                if parent_text == ".":
                    continue
                issue = f"parent path {parent_text!r} is also a file"
                if parent_text in files and issue not in issues:
                    issues.append(issue)
                    break
        entry["extractable"] = not issues

    if total_bytes > MAX_TOTAL_BYTES:
        archive_issues.append(
            f"archive expands to {total_bytes} bytes; maximum is {MAX_TOTAL_BYTES}"
        )
    return entries, archive_issues


def _public_entry(entry: dict[str, object]) -> dict[str, object]:
    return {key: value for key, value in entry.items() if key != "_info"}


def _summary(entries: list[dict[str, object]], archive_issues: list[str]) -> dict[str, object]:
    entry_issues = [
        f"{entry['path'] or '<empty>'}: {issue}"
        for entry in entries
        for issue in entry["issues"]  # type: ignore[union-attr]
    ]
    return {
        "entryCount": len(entries),
        "fileCount": sum(entry["type"] == "file" for entry in entries),
        "directoryCount": sum(entry["type"] == "directory" for entry in entries),
        "uncompressedBytes": sum(int(entry["size"]) for entry in entries),
        "compressedBytes": sum(int(entry["compressedSize"]) for entry in entries),
        "extractable": not archive_issues and not entry_issues,
        "issues": (archive_issues + entry_issues)[:100],
        "issueCount": len(archive_issues) + len(entry_issues),
    }


def _list_archive(archive: zipfile.ZipFile) -> dict[str, object]:
    entries, archive_issues = _manifest(archive)
    offset = _int_env("CAMELAI_ARCHIVE_OFFSET", 0, 0, max(len(entries), 0))
    limit = _int_env("CAMELAI_ARCHIVE_LIMIT", 200, 1, MAX_LIST_LIMIT)
    selected = entries[offset : offset + limit]
    next_offset = offset + len(selected)
    return {
        "ok": True,
        "action": "list",
        "format": "zip",
        **_summary(entries, archive_issues),
        "entries": [_public_entry(entry) for entry in selected],
        "offset": offset,
        "limit": limit,
        "hasMore": next_offset < len(entries),
        "nextOffset": next_offset if next_offset < len(entries) else None,
    }


def _read_entry(archive: zipfile.ZipFile) -> dict[str, object]:
    requested = _env("CAMELAI_ARCHIVE_ENTRY")
    if not requested:
        raise ArchiveError("entry is required when reading an archive member")
    requested_path, requested_issues = _normalize_member_path(requested)
    if requested_issues:
        raise ArchiveError("entry path is unsafe: " + "; ".join(requested_issues))

    entries, archive_issues = _manifest(archive)
    matches = [entry for entry in entries if entry["path"] == requested_path]
    if not matches:
        raise ArchiveError(f"entry not found: {requested}")
    if len(matches) != 1:
        raise ArchiveError(f"entry is ambiguous because the archive contains duplicates: {requested}")
    entry = matches[0]
    if archive_issues:
        raise ArchiveError("archive is unsafe: " + "; ".join(archive_issues))
    if entry["issues"]:
        raise ArchiveError("entry is unsafe: " + "; ".join(entry["issues"]))  # type: ignore[arg-type]
    if entry["type"] != "file":
        raise ArchiveError("only regular file entries can be read")

    info = entry["_info"]
    assert isinstance(info, zipfile.ZipInfo)
    with archive.open(info, "r") as source:
        data = source.read(MAX_READ_BYTES + 1)
    truncated = len(data) > MAX_READ_BYTES
    data = data[:MAX_READ_BYTES]
    if b"\x00" in data[:8192]:
        raise ArchiveError("entry appears to be binary; extract it into a project to inspect it")
    try:
        content = data.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ArchiveError("entry is not UTF-8 text; extract it into a project to inspect it") from error

    return {
        "ok": True,
        "action": "read",
        "format": "zip",
        "entry": requested_path,
        "size": entry["size"],
        "content": content,
        "truncated": truncated,
        "maxReadBytes": MAX_READ_BYTES,
    }


def _destination_root(project_root: Path) -> tuple[Path, str]:
    raw = _env("CAMELAI_ARCHIVE_DESTINATION", ".").strip().replace("\\", "/")
    if raw in ("", "."):
        return project_root, "."
    if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        raise ArchiveError("destination must be relative to the project root")
    parts = raw.rstrip("/").split("/")
    if any(part == ".." for part in parts):
        raise ArchiveError("destination must not contain parent traversal")
    normalized = "/".join(part for part in parts if part not in ("", "."))
    if not normalized:
        return project_root, "."
    destination = (project_root / normalized).resolve()
    if not _is_within(destination, project_root):
        raise ArchiveError("destination escapes the project root")
    return destination, normalized


def _extract_archive(archive: zipfile.ZipFile) -> dict[str, object]:
    entries, archive_issues = _manifest(archive)
    summary = _summary(entries, archive_issues)
    if not summary["extractable"]:
        issues = summary["issues"]
        assert isinstance(issues, list)
        raise ArchiveError("archive is not safe to extract: " + "; ".join(str(issue) for issue in issues))

    project_root = Path.cwd().resolve()
    destination, destination_label = _destination_root(project_root)
    for entry in entries:
        target = (destination / str(entry["path"])).resolve()
        if not _is_within(target, project_root):
            raise ArchiveError(f"entry escapes the project root: {entry['path']}")
        if target.exists() and target.is_symlink():
            raise ArchiveError(f"entry would overwrite a symbolic link: {entry['path']}")
        if entry["type"] == "file" and target.exists() and target.is_dir():
            raise ArchiveError(f"file entry conflicts with an existing directory: {entry['path']}")
        if entry["type"] == "directory" and target.exists() and not target.is_dir():
            raise ArchiveError(f"directory entry conflicts with an existing file: {entry['path']}")

    scratch = Path(_env("SCRATCH", tempfile.gettempdir())).resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="camelai-archive-", dir=scratch))
    extracted_bytes = 0
    try:
        for entry in entries:
            relative = str(entry["path"])
            staged = staging / relative
            if entry["type"] == "directory":
                staged.mkdir(parents=True, exist_ok=True)
                continue
            staged.parent.mkdir(parents=True, exist_ok=True)
            info = entry["_info"]
            assert isinstance(info, zipfile.ZipInfo)
            with archive.open(info, "r") as source, staged.open("wb") as target:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    extracted_bytes += len(chunk)
                    if extracted_bytes > MAX_TOTAL_BYTES:
                        raise ArchiveError("archive exceeded its declared decompressed size limit")
                    target.write(chunk)
            staged.chmod(0o644)

        destination.mkdir(parents=True, exist_ok=True)
        for staged in sorted(staging.rglob("*"), key=lambda path: (path.is_file(), len(path.parts))):
            relative = staged.relative_to(staging)
            target = destination / relative
            if staged.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staged, target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    return {
        "ok": True,
        "action": "extract",
        "format": "zip",
        **summary,
        "destination": destination_label,
        "extractedBytes": extracted_bytes,
    }


def main() -> int:
    try:
        archive_path = _archive_path()
        action = _env("CAMELAI_ARCHIVE_ACTION", "list").strip().lower()
        with zipfile.ZipFile(archive_path, "r") as archive:
            if action == "list":
                result = _list_archive(archive)
            elif action == "read":
                result = _read_entry(archive)
            elif action == "extract":
                result = _extract_archive(archive)
            else:
                raise ArchiveError("action must be list, read, or extract")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ArchiveError, OSError, zipfile.BadZipFile, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
