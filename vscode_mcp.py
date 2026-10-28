#!/usr/bin/env python3
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
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


def _vscode_active_folder() -> Optional[Path]:
    if os.name == "nt":
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

    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    storage_path = Path(appdata) / "Code" / "User" / "globalStorage" / "storage.json"
    if not storage_path.is_file():
        return None
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
        try:
            parsed = urlparse(uri)
            path = unquote(parsed.path)
            if os.name == "nt" and re.match(r"^/[A-Za-z]:/", path):
                path = path[1:]
            candidate = Path(path).resolve()
        except (OSError, ValueError):
            continue
        if candidate.is_dir():
            return candidate
    return None


def get_root() -> Path:
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
    return {
        "name": root.name,
        "path": str(root),
        "is_git_repository": (root / ".git").exists(),
    }


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
]


def tool_dispatch(name: str, args: Dict[str, Any]) -> Any:
    handlers = {
        "get_workspace_info": lambda: get_workspace_info(),
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
    }
    handler = handlers.get(name)
    if handler is None:
        raise ValueError(f"Unknown tool: {name}")
    return handler()


def send_message(message: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_request(request: Dict[str, Any]) -> None:
    method = request.get("method")
    request_id = request.get("id")
    params = request.get("params") or {}

    if method in ("initialize", "ping"):
        result = {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "vscode-mcp", "version": "2.0.0"},
        } if method == "initialize" else {}
        send_message({"jsonrpc": "2.0", "id": request_id, "result": result})
        return

    if method == "tools/list":
        tools = TOOLS if _vscode_active_folder() is not None else []
        send_message({"jsonrpc": "2.0", "id": request_id, "result": {"tools": tools}})
        return

    if method == "tools/call":
        try:
            output = tool_dispatch(params.get("name", ""), params.get("arguments") or {})
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
