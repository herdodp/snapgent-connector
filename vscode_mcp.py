#!/usr/bin/env python3
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import unquote, urlparse

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

IGNORED_DIRECTORIES = {
    ".git", ".hg", ".svn", ".venv", "venv", "node_modules",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".next", "dist", "build",
}
MAX_RESULTS = 500
MAX_FILE_CHARS = 200_000
SAFE_PROJECT_SCRIPTS = {"build", "check", "format", "lint", "test", "typecheck"}


def _lock_file_path() -> Path:
    # The lock file pins one workspace folder for the duration of a session so
    # switching to another VS Code window never silently changes the project a
    # running session operates on. Override with ZS_WORKSPACE_LOCK (the host app
    # uses this to keep the file inside its own data dir).
    override = os.environ.get("ZS_WORKSPACE_LOCK")
    if override:
        return Path(override)
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / ".snapgent_workspace.lock"
    return Path(__file__).resolve().parent / ".snapgent_workspace.lock"


def _read_workspace_lock() -> Optional[Path]:
    # Returns the locked folder only while it still exists on disk; an invalid
    # lock never blocks the tools - resolution just falls through to the next
    # source (and a missing folder therefore cannot lock the user out).
    lock_file = _lock_file_path()
    if not lock_file.is_file():
        return None
    try:
        data = json.loads(lock_file.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError):
        return None
    raw = data.get("path") if isinstance(data, dict) else None
    if not isinstance(raw, str) or not raw:
        return None
    try:
        candidate = Path(raw).expanduser().resolve()
    except (OSError, ValueError):
        return None
    if candidate.is_dir():
        return candidate
    return None


def _write_workspace_lock(root: Path) -> None:
    lock_file = _lock_file_path()
    payload = {"path": str(root), "locked_at": time.time()}
    tmp = lock_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, lock_file)


def _clear_workspace_lock() -> bool:
    lock_file = _lock_file_path()
    if not lock_file.is_file():
        return False
    try:
        lock_file.unlink()
    except OSError as error:
        raise RuntimeError(f"Could not remove the workspace lock: {error}") from error
    return True


def _parse_window_uri(uri: str) -> Optional[Path]:
    # VS Code stores window folders as file:// URIs in storage.json.
    try:
        parsed = urlparse(uri)
        path = unquote(parsed.path)
        if sys.platform == "win32" and re.match(r"^/[A-Za-z]:/", path):
            path = path[1:]
        candidate = Path(path).resolve()
    except (OSError, ValueError):
        return None
    return candidate if candidate.is_dir() else None


def _active_window_folder() -> Optional[Path]:
    if sys.platform == "win32":
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq Code.exe", "/NH"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError("Could not check whether VS Code is running.")
        if "Code.exe" not in result.stdout:
            return None

    for storage_path in _vscode_storage_paths():
        if not storage_path.is_file():
            continue
        try:
            data = json.loads(storage_path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Could not read VS Code workspace state: {error}") from error

        windows_state = data.get("windowsState") or {}
        uris = []
        last_folder = (windows_state.get("lastActiveWindow") or {}).get("folder")
        if last_folder:
            uris.append(last_folder)
        uris.extend(
            folder
            for window in (windows_state.get("openedWindows") or [])
            if (folder := (window or {}).get("folder"))
        )

        for uri in uris:
            candidate = _parse_window_uri(uri)
            if candidate is not None:
                return candidate
    return None


def list_vscode_windows() -> List[Dict[str, Any]]:
    # Every project folder VS Code currently has open, focused window first.
    # The extension offers these in its pre-start workspace picker so each chat
    # tab can bind to a DIFFERENT project before its session locks one in.
    # Tolerant by design: an unreadable storage.json yields fewer rows, never
    # an error that would block the picker.
    entries: List[Dict[str, Any]] = []
    seen = set()
    for storage_path in _vscode_storage_paths():
        if not storage_path.is_file():
            continue
        try:
            data = json.loads(storage_path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError):
            continue
        windows_state = data.get("windowsState") or {}
        windows = [windows_state.get("lastActiveWindow") or {}]
        windows.extend(window or {} for window in (windows_state.get("openedWindows") or []))
        for index, window in enumerate(windows):
            folder = window.get("folder")
            if not isinstance(folder, str) or not folder:
                continue
            candidate = _parse_window_uri(folder)
            if candidate is None or str(candidate) in seen:
                continue
            seen.add(str(candidate))
            entries.append({"name": candidate.name, "path": str(candidate), "active": index == 0})
    return entries


# ── Per-tab session workspaces ──────────────────────────────────────────────
# The bridge stamps every tool call from a chat tab with that tab's id
# (__zs_session). Each tab can pin its own workspace here, so two sessions in
# two tabs work on two different projects at the same time. The registry
# persists next to the lock file so it survives an MCP server restart.
_SESSION_WORKSPACES: Dict[str, str] = {}
_SESSIONS_LOADED = False
_CURRENT_SESSION: Optional[str] = None


def _sessions_file_path() -> Path:
    return _lock_file_path().parent / ".snapgent_sessions.json"


def _load_sessions() -> None:
    global _SESSION_WORKSPACES, _SESSIONS_LOADED
    if _SESSIONS_LOADED:
        return
    _SESSIONS_LOADED = True
    sessions_file = _sessions_file_path()
    if not sessions_file.is_file():
        return
    try:
        data = json.loads(sessions_file.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(data, dict):
        return
    recovered: Dict[str, str] = {}
    for key, value in data.items():
        raw = value.get("path") if isinstance(value, dict) else value
        if isinstance(raw, str) and raw:
            recovered[str(key)] = raw
    _SESSION_WORKSPACES = recovered


def _save_sessions() -> None:
    sessions_file = _sessions_file_path()
    try:
        tmp = sessions_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(_SESSION_WORKSPACES, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, sessions_file)
    except OSError:
        pass  # the in-memory registry still covers this run


def _session_workspace(session: Optional[str]) -> Optional[Path]:
    # The pinned folder only while it still exists - a deleted project can
    # never hold its session hostage (same rule as the global lock).
    if not session:
        return None
    _load_sessions()
    raw = _SESSION_WORKSPACES.get(str(session))
    if not isinstance(raw, str) or not raw:
        return None
    try:
        candidate = Path(raw).expanduser().resolve()
    except (OSError, ValueError):
        return None
    return candidate if candidate.is_dir() else None


def _set_session_workspace(session: str, root: Path) -> None:
    _load_sessions()
    _SESSION_WORKSPACES[str(session)] = str(root)
    _save_sessions()


def _clear_session_workspace(session: str) -> bool:
    _load_sessions()
    if str(session) not in _SESSION_WORKSPACES:
        return False
    _SESSION_WORKSPACES.pop(str(session))
    _save_sessions()
    return True


def _has_session_workspaces() -> bool:
    _load_sessions()
    return any(_session_workspace(key) is not None for key in list(_SESSION_WORKSPACES))


def _vscode_storage_paths() -> List[Path]:
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if not appdata:
            return []
        return [Path(appdata) / "Code" / "User" / "globalStorage" / "storage.json"]

    if sys.platform == "linux":
        config = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
        return [
            config / product / "User" / "globalStorage" / "storage.json"
            for product in ("Code", "Code - Insiders", "VSCodium")
        ]

    support = Path.home() / "Library" / "Application Support"
    return [
        support / product / "User" / "globalStorage" / "storage.json"
        for product in ("Code", "Code - Insiders", "VSCodium")
    ]


def _vscode_active_folder() -> Optional[Path]:
    # Resolution order: explicit ZS_WORKSPACE override (the standalone app's
    # picked folder), then the session lock, then the folder of the VS Code
    # window that is currently focused. The lock in the middle is what keeps a
    # running session on its project while the user browses other VS Code
    # windows.
    override = os.environ.get("ZS_WORKSPACE")
    if override:
        try:
            candidate = Path(override).expanduser().resolve()
        except (OSError, ValueError):
            return None
        if candidate.is_dir():
            return candidate
        return None
    locked = _read_workspace_lock()
    if locked is not None:
        return locked
    return _active_window_folder()


def _workspace_source() -> str:
    if _CURRENT_SESSION and _session_workspace(_CURRENT_SESSION) is not None:
        return "session"
    override = os.environ.get("ZS_WORKSPACE")
    if override and Path(override).expanduser().is_dir():
        return "app"
    if _read_workspace_lock() is not None:
        return "lock"
    return "vscode-window"


def get_root() -> Path:
    # Per-tab session first: each chat tab pins its own workspace through
    # lock_workspace (the bridge injects the tab id as __zs_session). Without a
    # session (or before that tab pinned anything) the global chain applies:
    # app-picked folder → global lock → focused VS Code window.
    session_ws = _session_workspace(_CURRENT_SESSION)
    if session_ws is not None:
        return session_ws
    active = _vscode_active_folder()
    if active is None:
        raise RuntimeError("Open a project folder in VS Code before using the VS Code MCP server.")
    return active.resolve()


def normalize_target(rel_or_abs: str, root: Path) -> Path:
    path = Path(rel_or_abs or ".")
    if not path.is_absolute():
        path = root / path
    target = path.resolve()
    try:
        target.relative_to(root)
    except ValueError as error:
        raise ValueError(f"Path escapes workspace root: {rel_or_abs}") from error
    return target


def _relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix() or "."


def _iter_files(base: Path) -> Iterable[Path]:
    if base.is_file():
        yield base
        return
    for current, dirs, names in os.walk(base):
        dirs[:] = sorted(
            name for name in dirs
            if name not in IGNORED_DIRECTORIES
        )
        for name in sorted(names):
            yield Path(current) / name


def _run_process(command: List[str], root: Path, timeout: int = 30) -> str:
    result = subprocess.run(
        command,
        cwd=str(root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
        timeout=timeout,
        check=False,
    )
    output = result.stdout.strip() or result.stderr.strip() or "(no output)"
    if result.returncode:
        raise RuntimeError(
            f"Command exited with status {result.returncode}:\n{output[:MAX_FILE_CHARS]}"
        )
    return output[:MAX_FILE_CHARS]


def get_workspace_info() -> Dict[str, Any]:
    root = get_root()
    source = _workspace_source()
    return {
        "name": root.name,
        "path": str(root),
        "is_git_repository": (root / ".git").exists(),
        "workspace_locked": source in ("session", "lock"),
        "workspace_source": source,
        "workspace_session": _CURRENT_SESSION if source == "session" else None,
    }


def lock_workspace(path: str = "") -> Dict[str, Any]:
    # Pin the workspace for this session. With no path, the folder VS Code
    # currently has focused is used - deliberately IGNORING any existing lock,
    # because "start a session" must re-pin to the window the user is looking
    # at right now, not to whatever a previous session left behind. A tab id
    # (__zs_session, injected by the bridge) pins THAT tab only, so several
    # chat tabs can each hold a different project at the same time.
    if isinstance(path, str) and path.strip():
        target = Path(path).expanduser()
        if not target.is_dir():
            raise FileNotFoundError(f"Not a directory: {path}")
        root = target.resolve()
    else:
        override = os.environ.get("ZS_WORKSPACE")
        root = None
        if override:
            try:
                root = Path(override).expanduser().resolve()
            except (OSError, ValueError):
                root = None
            if root is not None and not root.is_dir():
                root = None
        if root is None:
            root = _active_window_folder()
        if root is None:
            raise RuntimeError("No workspace to lock: open a project folder in VS Code, or pass an explicit path.")
    session = _CURRENT_SESSION
    if session:
        _set_session_workspace(session, root)
        return {"locked": True, "session": session, "name": root.name, "path": str(root)}
    _write_workspace_lock(root)
    return {"locked": True, "name": root.name, "path": str(root)}


def unlock_workspace() -> Dict[str, Any]:
    # A tab may only clear its OWN session pin; the global lock (and the
    # app-picked folder) belong to the machine, not to one chat tab.
    if _CURRENT_SESSION:
        removed = _clear_session_workspace(_CURRENT_SESSION)
        return {"locked": False, "session": _CURRENT_SESSION, "removed": removed}
    removed = _clear_workspace_lock()
    result: Dict[str, Any] = {"locked": False, "removed": removed}
    override = os.environ.get("ZS_WORKSPACE")
    if override:
        try:
            app_pinned = Path(override).expanduser().is_dir()
        except (OSError, ValueError):
            app_pinned = False
        if app_pinned:
            result["note"] = "The app-pinned workspace (ZS_WORKSPACE) still applies."
    return result


def get_project_info() -> Dict[str, Any]:
    root = get_root()
    info: Dict[str, Any] = {"workspace": root.name, "manifests": []}
    for filename in ("package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "*.sln"):
        candidates = sorted(root.glob(filename))[:10]
        for candidate in candidates:
            entry: Dict[str, Any] = {"path": _relative(candidate, root)}
            if candidate.name == "package.json":
                try:
                    package = json.loads(candidate.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as error:
                    entry["error"] = str(error)
                else:
                    entry["name"] = package.get("name")
                    entry["scripts"] = package.get("scripts", {})
            info["manifests"].append(entry)
    return info


def list_dir(path: str = ".") -> List[Dict[str, str]]:
    root = get_root()
    target = normalize_target(path, root)
    if not target.exists():
        raise FileNotFoundError(f"Directory not found: {path}")
    if not target.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    return [
        {
            "name": child.name,
            "path": _relative(child, root),
            "type": "directory" if child.is_dir() else "file",
        }
        for child in sorted(target.iterdir(), key=lambda item: (item.is_file(), item.name.lower()))
    ]


def list_tree(path: str = ".", max_depth: int = 3) -> List[Dict[str, Any]]:
    root = get_root()
    target = normalize_target(path, root)
    if not target.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    depth_limit = max(0, min(int(max_depth), 8))
    result: List[Dict[str, Any]] = []
    for current, dirs, files in os.walk(target):
        current_path = Path(current)
        depth = len(current_path.relative_to(target).parts)
        dirs[:] = sorted(
            name for name in dirs
            if name not in IGNORED_DIRECTORIES
        )
        for name in sorted(dirs) + sorted(files):
            entry_path = current_path / name
            result.append({
                "path": _relative(entry_path, root),
                "type": "directory" if entry_path.is_dir() else "file",
            })
            if len(result) >= MAX_RESULTS:
                return result
        if depth >= depth_limit:
            dirs[:] = []
    return result


def find_files(path: str = ".", pattern: str = "*") -> List[str]:
    root = get_root()
    base = normalize_target(path, root)
    if not base.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    if not base.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    matches = [
        _relative(file_path, root)
        for file_path in _iter_files(base)
        if fnmatch.fnmatch(file_path.name, pattern)
        or fnmatch.fnmatch(_relative(file_path, base), pattern)
    ]
    return matches[:MAX_RESULTS]


def search_files(path: str, query: str, file_pattern: str = "*", case_sensitive: bool = False) -> List[Dict[str, Any]]:
    root = get_root()
    target = normalize_target(path, root)
    if not target.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    if not query.strip():
        raise ValueError("Search query cannot be empty.")
    needle = query if case_sensitive else query.lower()
    matches: List[Dict[str, Any]] = []
    files = [target] if target.is_file() else _iter_files(target)
    for file_path in files:
        if not fnmatch.fnmatch(file_path.name, file_pattern):
            continue
        try:
            text = file_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            haystack = line if case_sensitive else line.lower()
            if needle in haystack:
                matches.append({
                    "path": _relative(file_path, root),
                    "line": line_number,
                    "text": line[:500],
                })
                if len(matches) >= MAX_RESULTS:
                    return matches
    return matches


def read_file(path: str) -> str:
    root = get_root()
    target = normalize_target(path, root)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    content = target.read_text(encoding="utf-8", errors="replace")
    if len(content) > MAX_FILE_CHARS:
        return content[:MAX_FILE_CHARS] + "\n[truncated]"
    return content


def read_files(paths: List[str]) -> List[Dict[str, str]]:
    if len(paths) > 50:
        raise ValueError("Read at most 50 files per request.")
    return [{"path": path, "content": read_file(path)} for path in paths]


def read_file_lines(path: str, start_line: int = 1, end_line: int = 200) -> str:
    if start_line < 1 or end_line < start_line:
        raise ValueError("Line numbers must be positive, and end_line must be >= start_line.")
    if end_line - start_line > 999:
        raise ValueError("Read at most 1000 lines per request.")
    lines = read_file(path).splitlines()
    return "\n".join(
        f"{number}: {lines[number - 1]}"
        for number in range(start_line, min(end_line, len(lines)) + 1)
    )


def get_file_info(path: str) -> Dict[str, Any]:
    root = get_root()
    target = normalize_target(path, root)
    if not target.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    stat = target.stat()
    return {
        "path": _relative(target, root),
        "type": "directory" if target.is_dir() else "file",
        "size_bytes": stat.st_size,
        "modified": stat.st_mtime,
        "suffix": target.suffix,
    }


def get_file_outline(path: str) -> List[Dict[str, Any]]:
    content = read_file(path)
    patterns = (
        r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)",
        r"^\s*class\s+([A-Za-z_]\w*)",
        r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)",
        r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)",
    )
    result = []
    for line_number, line in enumerate(content.splitlines(), start=1):
        for pattern in patterns:
            match = re.search(pattern, line)
            if match:
                result.append({"name": match.group(1), "line": line_number})
                break
    return result[:MAX_RESULTS]


def create_file(path: str, content: str = "") -> str:
    root = get_root()
    target = normalize_target(path, root)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with target.open("x", encoding="utf-8", newline="") as file:
            file.write(content)
    except FileExistsError as error:
        raise FileExistsError(f"File already exists: {path}") from error
    return f"Created {_relative(target, root)}"


def write_file(path: str, content: str) -> str:
    root = get_root()
    target = normalize_target(path, root)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"Saved {_relative(target, root)}"


def edit_file(path: str, old_text: str, new_text: str, replace_all: bool = False) -> str:
    if not old_text:
        raise ValueError("old_text cannot be empty.")
    root = get_root()
    target = normalize_target(path, root)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    content = target.read_text(encoding="utf-8", errors="replace")
    occurrences = content.count(old_text)
    if occurrences == 0:
        raise ValueError("The exact old_text was not found.")
    if not replace_all and occurrences != 1:
        raise ValueError(f"old_text occurs {occurrences} times; provide a unique snippet or set replace_all.")
    updated = content.replace(old_text, new_text) if replace_all else content.replace(old_text, new_text, 1)
    target.write_text(updated, encoding="utf-8")
    return f"Updated {_relative(target, root)} ({occurrences if replace_all else 1} replacement(s))"


def create_directory(path: str) -> str:
    root = get_root()
    target = normalize_target(path, root)
    target.mkdir(parents=True, exist_ok=True)
    return f"Directory ready: {_relative(target, root)}"


def move_file(source: str, destination: str) -> str:
    root = get_root()
    source_path = normalize_target(source, root)
    destination_path = normalize_target(destination, root)
    if not source_path.is_file():
        raise FileNotFoundError(f"File not found: {source}")
    if destination_path.exists():
        raise FileExistsError(f"Destination already exists: {destination}")
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.rename(destination_path)
    return f"Moved {_relative(source_path, root)} to {_relative(destination_path, root)}"


def copy_file(source: str, destination: str) -> str:
    root = get_root()
    source_path = normalize_target(source, root)
    destination_path = normalize_target(destination, root)
    if not source_path.is_file():
        raise FileNotFoundError(f"File not found: {source}")
    if destination_path.exists():
        raise FileExistsError(f"Destination already exists: {destination}")
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, destination_path)
    return f"Copied {_relative(source_path, root)} to {_relative(destination_path, root)}"


def git_status() -> str:
    root = get_root()
    return _run_process(["git", "status", "--short", "--branch"], root)


def git_diff(path: str = "") -> str:
    root = get_root()
    command = ["git", "diff", "--"]
    if path:
        command.append(_relative(normalize_target(path, root), root))
    return _run_process(command, root)


def git_log(limit: int = 10) -> str:
    if limit < 1 or limit > 50:
        raise ValueError("limit must be between 1 and 50.")
    return _run_process(["git", "log", f"-{limit}", "--oneline", "--decorate"], get_root())


def git_branches() -> str:
    return _run_process(
        ["git", "branch", "--format=%(refname:short)"],
        get_root(),
    )


def delete_file(path: str) -> str:
    root = get_root()
    target = normalize_target(path, root)
    if target == root or ".git" in target.relative_to(root).parts:
        raise ValueError(f"Refusing to delete protected path: {path}")
    if target.is_dir():
        raise IsADirectoryError(f"Not a file (directories are not deleted): {path}")
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    target.unlink()
    return f"Deleted {_relative(target, root)}"


def apply_patch(path: str, edits: List[Dict[str, Any]]) -> str:
    if not isinstance(edits, list) or not edits:
        raise ValueError("edits must be a non-empty list.")
    root = get_root()
    target = normalize_target(path, root)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    content = target.read_text(encoding="utf-8", errors="replace")
    for index, edit in enumerate(edits, start=1):
        if not isinstance(edit, dict):
            raise ValueError(f"Edit {index} must be an object with old_text and new_text.")
        old_text = edit.get("old_text")
        new_text = edit.get("new_text")
        if not isinstance(old_text, str) or not old_text or not isinstance(new_text, str):
            raise ValueError(f"Edit {index} needs a non-empty old_text and a string new_text.")
        occurrences = content.count(old_text)
        if occurrences != 1:
            raise ValueError(f"Edit {index}: old_text occurs {occurrences} times; it must match exactly once. No changes were written.")
        content = content.replace(old_text, new_text, 1)
    target.write_text(content, encoding="utf-8")
    return f"Patched {_relative(target, root)} ({len(edits)} edit(s))"


def git_add(paths: List[str]) -> str:
    if not isinstance(paths, list) or not paths:
        raise ValueError("paths must be a non-empty list.")
    root = get_root()
    relatives = [_relative(normalize_target(item, root), root) for item in paths]
    if "." in relatives:
        raise ValueError("Stage specific paths, not the whole workspace.")
    _run_process(["git", "add", "--", *relatives], root)
    return f"Staged {len(relatives)} path(s): " + ", ".join(relatives)


def git_commit(message: str) -> str:
    if not isinstance(message, str) or not message.strip():
        raise ValueError("Commit message cannot be empty.")
    return _run_process(["git", "commit", "-m", message.strip()], get_root(), timeout=120)


def run_command(command: str, args: Optional[List[str]] = None) -> str:
    if not command.strip():
        raise ValueError("Command cannot be empty.")
    root = get_root()
    extra_args = args or []
    if os.name == "nt":
        return _run_process(["cmd.exe", "/c", command, *extra_args], root, timeout=30)
    return _run_process([command, *extra_args], root, timeout=30)


def _package_script_command(script: str, root: Path) -> List[str]:
    if script not in SAFE_PROJECT_SCRIPTS:
        raise ValueError(f"Script must be one of: {', '.join(sorted(SAFE_PROJECT_SCRIPTS))}.")
    package_path = root / "package.json"
    if not package_path.is_file():
        raise FileNotFoundError("No package.json found in the workspace root.")
    try:
        package = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read package.json: {error}") from error
    if script not in (package.get("scripts") or {}):
        raise ValueError(f"package.json does not define the '{script}' script.")
    manager = "npm"
    if (root / "pnpm-lock.yaml").exists():
        manager = "pnpm"
    elif (root / "yarn.lock").exists():
        manager = "yarn"
    elif (root / "bun.lock").exists() or (root / "bun.lockb").exists():
        manager = "bun"
    if os.name == "nt":
        return ["cmd.exe", "/c", manager, "run", script]
    return [manager, "run", script]


def run_project_script(script: str) -> str:
    root = get_root()
    return _run_process(_package_script_command(script, root), root, timeout=300)


def run_tests() -> str:
    root = get_root()
    if (root / "package.json").is_file():
        return run_project_script("test")
    if (root / "pyproject.toml").is_file() or (root / "pytest.ini").is_file():
        return _run_process([sys.executable, "-m", "pytest"], root, timeout=300)
    if any(root.glob("*.sln")) or any(root.glob("*.csproj")):
        return _run_process(["dotnet", "test"], root, timeout=300)
    raise FileNotFoundError("No supported test setup found (package.json, pytest, or .NET project).")


def _property(name: str, schema: Dict[str, Any]) -> Dict[str, Any]:
    return {"name": name, **schema}


def _tool(name: str, description: str, properties: Dict[str, Any], required: Optional[List[str]] = None) -> Dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required or [],
        },
    }


STR = {"type": "string"}
TOOLS = [
    _tool("get_workspace_info", "Get the active VS Code workspace name, path, and Git status.", {}),
    _tool("list_vscode_windows", "List every project folder VS Code currently has open (focused window first) with name and path.", {}),
    _tool("lock_workspace", "Pin the session to one workspace folder so switching to another VS Code window does NOT change the workspace. Call with no arguments at session start to pin the folder VS Code currently has focused, or pass a path to pin that folder. Each chat tab pins its own workspace.", {"path": STR}),
    _tool("unlock_workspace", "Remove the workspace pin and follow the focused VS Code window again.", {}),
    _tool("get_project_info", "Inspect common project manifests and package scripts.", {}),
    _tool("list_dir", "List files and folders in the workspace.", {"path": STR}),
    _tool("list_tree", "List a bounded tree of workspace files and folders.", {"path": STR, "max_depth": {"type": "integer", "minimum": 0, "maximum": 8}}),
    _tool("find_files", "Find workspace files by glob pattern.", {"path": STR, "pattern": STR}),
    _tool("search_files", "Search text in workspace files.", {"path": STR, "query": STR, "file_pattern": STR, "case_sensitive": {"type": "boolean"}}, ["path", "query"]),
    _tool("read_file", "Read a UTF-8 text file in the workspace.", {"path": STR}, ["path"]),
    _tool("read_files", "Read up to 50 workspace files.", {"paths": {"type": "array", "items": STR}}, ["paths"]),
    _tool("read_file_lines", "Read a bounded line range from a workspace file.", {"path": STR, "start_line": {"type": "integer", "minimum": 1}, "end_line": {"type": "integer", "minimum": 1}}, ["path"]),
    _tool("get_file_info", "Get size, type, extension, and modification time for a workspace path.", {"path": STR}, ["path"]),
    _tool("get_file_outline", "List class and function declarations from a source file.", {"path": STR}, ["path"]),
    _tool("create_file", "Create a new file without overwriting an existing file.", {"path": STR, "content": STR}, ["path"]),
    _tool("write_file", "Write or replace a UTF-8 text file inside the workspace.", {"path": STR, "content": STR}, ["path", "content"]),
    _tool("edit_file", "Replace an exact text snippet; by default the snippet must be unique.", {"path": STR, "old_text": STR, "new_text": STR, "replace_all": {"type": "boolean"}}, ["path", "old_text", "new_text"]),
    _tool("create_directory", "Create a directory inside the workspace.", {"path": STR}, ["path"]),
    _tool("move_file", "Move a file inside the workspace without overwriting a destination.", {"source": STR, "destination": STR}, ["source", "destination"]),
    _tool("copy_file", "Copy a file inside the workspace without overwriting a destination.", {"source": STR, "destination": STR}, ["source", "destination"]),
    _tool("git_status", "Show the current Git branch and working-tree status.", {}),
    _tool("git_diff", "Show unstaged Git changes, optionally for one workspace path.", {"path": STR}),
    _tool("git_log", "Show recent Git commits.", {"limit": {"type": "integer", "minimum": 1, "maximum": 50}}),
    _tool("git_branches", "List local Git branches.", {}),
    _tool("run_command", "Run a command with the workspace as its working directory.", {"command": STR, "args": {"type": "array", "items": STR}}, ["command"]),
    _tool("run_project_script", "Run a named safe script (build, check, format, lint, test, typecheck) from package.json.", {"script": STR}, ["script"]),
    _tool("run_tests", "Run the workspace test script, pytest, or .NET tests when configured.", {}),
    _tool("delete_file", "Delete one file inside the workspace; directories, the workspace root, and .git are refused.", {"path": STR}, ["path"]),
    _tool("apply_patch", "Apply several exact text replacements to one file; each old_text must match exactly once and nothing is written if any edit fails.", {"path": STR, "edits": {"type": "array", "items": {"type": "object", "properties": {"old_text": STR, "new_text": STR}, "required": ["old_text", "new_text"]}}}, ["path", "edits"]),
    _tool("git_add", "Stage specific workspace paths; staging the whole workspace is refused.", {"paths": {"type": "array", "items": STR}}, ["paths"]),
    _tool("git_commit", "Commit the currently staged changes with a message; no auto-staging and no amend.", {"message": STR}, ["message"]),
]


def tool_dispatch(name: str, args: Dict[str, Any]) -> Any:
    handlers = {
        "get_workspace_info": lambda: get_workspace_info(),
        "list_vscode_windows": lambda: list_vscode_windows(),
        "lock_workspace": lambda: lock_workspace(args.get("path", "")),
        "unlock_workspace": lambda: unlock_workspace(),
        "get_project_info": lambda: get_project_info(),
        "list_dir": lambda: list_dir(args.get("path", ".")),
        "list_tree": lambda: list_tree(args.get("path", "."), args.get("max_depth", 3)),
        "find_files": lambda: find_files(args.get("path", "."), args.get("pattern", "*")),
        "search_files": lambda: search_files(args["path"], args["query"], args.get("file_pattern", "*"), args.get("case_sensitive", False)),
        "read_file": lambda: read_file(args["path"]),
        "read_files": lambda: read_files(args["paths"]),
        "read_file_lines": lambda: read_file_lines(args["path"], args.get("start_line", 1), args.get("end_line", 200)),
        "get_file_info": lambda: get_file_info(args["path"]),
        "get_file_outline": lambda: get_file_outline(args["path"]),
        "create_file": lambda: create_file(args["path"], args.get("content", "")),
        "write_file": lambda: write_file(args["path"], args["content"]),
        "edit_file": lambda: edit_file(args["path"], args["old_text"], args["new_text"], args.get("replace_all", False)),
        "create_directory": lambda: create_directory(args["path"]),
        "move_file": lambda: move_file(args["source"], args["destination"]),
        "copy_file": lambda: copy_file(args["source"], args["destination"]),
        "git_status": lambda: git_status(),
        "git_diff": lambda: git_diff(args.get("path", "")),
        "git_log": lambda: git_log(args.get("limit", 10)),
        "git_branches": lambda: git_branches(),
        "run_command": lambda: run_command(args["command"], args.get("args", [])),
        "run_project_script": lambda: run_project_script(args["script"]),
        "run_tests": lambda: run_tests(),
        "delete_file": lambda: delete_file(args["path"]),
        "apply_patch": lambda: apply_patch(args["path"], args["edits"]),
        "git_add": lambda: git_add(args["paths"]),
        "git_commit": lambda: git_commit(args["message"]),
    }
    handler = handlers.get(name)
    if handler is None:
        raise ValueError(f"Unknown tool: {name}")
    return handler()


def send_message(message: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_request(request: Dict[str, Any]) -> None:
    global _CURRENT_SESSION
    method = request.get("method")
    request_id = request.get("id")
    params = request.get("params") or {}

    if method in ("initialize", "ping"):
        result = {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "vscode-mcp", "version": "2.1.0"},
        } if method == "initialize" else {}
        send_message({"jsonrpc": "2.0", "id": request_id, "result": result})
        return

    if method == "tools/list":
        # Also advertise when only per-tab session pins exist: a locked session
        # must keep its tools even with no VS Code window focused (or open).
        tools = TOOLS if (_vscode_active_folder() is not None or _has_session_workspaces()) else []
        send_message({"jsonrpc": "2.0", "id": request_id, "result": {"tools": tools}})
        return

    if method == "tools/call":
        try:
            arguments = dict(params.get("arguments") or {})
            # Reserved session key injected by the bridge from the calling
            # chat tab. Popped here so tools never see it in their arguments.
            session = arguments.pop("__zs_session", None)
            _CURRENT_SESSION = str(session) if session is not None and str(session) else None
            output = tool_dispatch(params.get("name", ""), arguments)
            text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
            send_message({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "content": [{"type": "text", "text": text}],
                    "structuredContent": {"result": output},
                },
            })
        except Exception as error:
            send_message({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32603, "message": str(error)},
            })
        finally:
            _CURRENT_SESSION = None
        return

    if method == "notifications/initialized":
        return
    send_message({
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    })


if __name__ == "__main__":
    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            request = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(request, dict):
            handle_request(request)
