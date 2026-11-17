import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import vscode_mcp


class VscodeMcpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.root_patch = patch.object(vscode_mcp, "get_root", return_value=self.workspace)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.addCleanup(self.temp.cleanup)

    def useRealRoot(self):
        # Session tests exercise the real resolution chain, not the setUp mock.
        self.root_patch.stop()

    def test_catalog_has_31_unique_tools(self):
        names = [tool["name"] for tool in vscode_mcp.TOOLS]
        self.assertEqual(len(names), 31)
        self.assertEqual(len(set(names)), 31)
        for name in ("delete_file", "apply_patch", "git_add", "git_commit",
                     "lock_workspace", "unlock_workspace", "list_vscode_windows"):
            self.assertIn(name, names)

    def test_delete_file_refuses_unsafe_targets(self):
        vscode_mcp.create_file("notes.txt", "x")
        (self.workspace / "folder").mkdir()
        (self.workspace / ".git").mkdir()
        (self.workspace / ".git" / "config").write_text("x", encoding="utf-8")
        self.assertIn("Deleted", vscode_mcp.delete_file("notes.txt"))
        self.assertFalse((self.workspace / "notes.txt").exists())
        with self.assertRaises(IsADirectoryError):
            vscode_mcp.delete_file("folder")
        with self.assertRaises(ValueError):
            vscode_mcp.delete_file(".git/config")
        with self.assertRaises(ValueError):
            vscode_mcp.delete_file(".")
        with self.assertRaises(ValueError):
            vscode_mcp.delete_file("../outside.txt")
        with self.assertRaises(FileNotFoundError):
            vscode_mcp.delete_file("missing.txt")

    def test_apply_patch_is_all_or_nothing(self):
        vscode_mcp.create_file("app.txt", "alpha beta gamma")
        vscode_mcp.apply_patch(
            "app.txt",
            [
                {"old_text": "alpha", "new_text": "one"},
                {"old_text": "gamma", "new_text": "three"},
            ],
        )
        self.assertEqual(vscode_mcp.read_file("app.txt"), "one beta three")
        with self.assertRaises(ValueError):
            vscode_mcp.apply_patch(
                "app.txt",
                [
                    {"old_text": "one", "new_text": "1"},
                    {"old_text": "missing", "new_text": "x"},
                ],
            )
        self.assertEqual(vscode_mcp.read_file("app.txt"), "one beta three")
        with self.assertRaises(ValueError):
            vscode_mcp.apply_patch("app.txt", [])

    def test_vscode_storage_paths_include_macos_installations(self):
        with patch.object(vscode_mcp.sys, "platform", "darwin"):
            paths = vscode_mcp._vscode_storage_paths()
        self.assertEqual(len(paths), 3)
        self.assertTrue(all(path.name == "storage.json" for path in paths))
        self.assertTrue(any("Code - Insiders" in str(path) for path in paths))

    def test_vscode_storage_paths_include_linux_installations(self):
        with patch.object(vscode_mcp.sys, "platform", "linux"), patch.dict(
            "os.environ", {"XDG_CONFIG_HOME": "/tmp/vscode-config"}
        ):
            paths = vscode_mcp._vscode_storage_paths()
        self.assertEqual(len(paths), 3)
        self.assertEqual(paths[0], Path("/tmp/vscode-config/Code/User/globalStorage/storage.json"))
        self.assertTrue(any("VSCodium" in str(path) for path in paths))

    def test_file_operations_stay_in_workspace(self):
        vscode_mcp.create_file("src/app.js", "export function start() {}\n")
        vscode_mcp.create_file(".github/workflows/check.yml", "name: check\n")
        self.assertIn("export function start", vscode_mcp.read_file("src/app.js"))
        outline = vscode_mcp.get_file_outline("src/app.js")
        self.assertEqual(outline, [{"name": "start", "line": 1}])
        vscode_mcp.edit_file("src/app.js", "start", "run")
        self.assertIn("function run", vscode_mcp.read_file("src/app.js"))
        self.assertEqual(vscode_mcp.find_files(".", "*.js"), ["src/app.js"])
        self.assertEqual(
            vscode_mcp.find_files(".", "*.yml"),
            [".github/workflows/check.yml"],
        )
        self.assertEqual(len(vscode_mcp.read_files(["src/app.js"])), 1)
        with self.assertRaises(ValueError):
            vscode_mcp.read_file("../outside.txt")

    def test_copy_and_move_do_not_overwrite(self):
        (self.workspace / "source.txt").write_text("content", encoding="utf-8")
        vscode_mcp.copy_file("source.txt", "copy.txt")
        self.assertEqual((self.workspace / "copy.txt").read_text(encoding="utf-8"), "content")
        with self.assertRaises(FileExistsError):
            vscode_mcp.copy_file("source.txt", "copy.txt")
        vscode_mcp.move_file("source.txt", "moved.txt")
        self.assertFalse((self.workspace / "source.txt").exists())
        self.assertTrue((self.workspace / "moved.txt").exists())

    def test_edit_requires_unique_snippet_by_default(self):
        (self.workspace / "duplicate.txt").write_text("same same", encoding="utf-8")
        with self.assertRaises(ValueError):
            vscode_mcp.edit_file("duplicate.txt", "same", "new")
        vscode_mcp.edit_file("duplicate.txt", "same", "new", replace_all=True)
        self.assertEqual(
            (self.workspace / "duplicate.txt").read_text(encoding="utf-8"),
            "new new",
        )

    # ── Session workspace lock ───────────────────────────────────────────────
    def setUpLock(self):
        # Point the lock at a temp file, clear app-level overrides and reset
        # the per-tab session registry so the resolution chain under test is
        # exactly the one the test drives.
        lock_patch = patch.object(
            vscode_mcp, "_lock_file_path",
            return_value=self.root / "test.lock.json",
        )
        lock_patch.start()
        self.addCleanup(lock_patch.stop)
        sessions_patch = patch.object(
            vscode_mcp, "_sessions_file_path",
            return_value=self.root / "test.sessions.json",
        )
        sessions_patch.start()
        self.addCleanup(sessions_patch.stop)
        env_patch = patch.dict("os.environ", {}, clear=False)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        os.environ.pop("ZS_WORKSPACE", None)
        os.environ.pop("ZS_WORKSPACE_LOCK", None)
        vscode_mcp._SESSION_WORKSPACES = {}
        vscode_mcp._SESSIONS_LOADED = True
        vscode_mcp._CURRENT_SESSION = None
        self.addCleanup(setattr, vscode_mcp, "_SESSIONS_LOADED", False)
        self.addCleanup(setattr, vscode_mcp, "_CURRENT_SESSION", None)
        return self.root / "test.lock.json"

    def test_lock_workspace_pins_active_folder_over_window_switch(self):
        lock_file = self.setUpLock()
        other_project = self.root / "other-project"
        other_project.mkdir()
        result = vscode_mcp.lock_workspace(str(self.workspace))
        self.assertTrue(result["locked"])
        self.assertEqual(result["name"], self.workspace.name)
        self.assertTrue(lock_file.is_file())
        # Even with a DIFFERENT VS Code window focused (what a user switching
        # windows produces), the session keeps the locked workspace.
        with patch.object(vscode_mcp, "_active_window_folder", return_value=other_project):
            self.assertEqual(vscode_mcp._vscode_active_folder(), self.workspace.resolve())
            self.assertEqual(vscode_mcp.get_root(), self.workspace.resolve())

    def test_lock_workspace_without_path_repins_to_current_window(self):
        # A new session must pin the window the user is looking at NOW, not the
        # folder a previous session left locked.
        self.setUpLock()
        old_project = self.root / "old-project"
        old_project.mkdir()
        new_project = self.root / "new-project"
        new_project.mkdir()
        vscode_mcp._write_workspace_lock(old_project)
        with patch.object(vscode_mcp, "_active_window_folder", return_value=new_project):
            result = vscode_mcp.lock_workspace()
        self.assertEqual(Path(result["path"]), new_project)
        self.assertEqual(vscode_mcp._read_workspace_lock(), new_project)

    def test_unlock_workspace_restores_active_window_following(self):
        self.setUpLock()
        focused = self.root / "focused"
        focused.mkdir()
        vscode_mcp.lock_workspace(str(self.workspace))
        self.assertEqual(vscode_mcp._read_workspace_lock(), self.workspace.resolve())
        result = vscode_mcp.unlock_workspace()
        self.assertFalse(result["locked"])
        self.assertTrue(result["removed"])
        self.assertIsNone(vscode_mcp._read_workspace_lock())
        with patch.object(vscode_mcp, "_active_window_folder", return_value=focused):
            self.assertEqual(vscode_mcp._vscode_active_folder(), focused)

    def test_unlock_without_lock_reports_not_removed(self):
        self.setUpLock()
        result = vscode_mcp.unlock_workspace()
        self.assertFalse(result["locked"])
        self.assertFalse(result["removed"])

    def test_invalid_lock_falls_through_to_active_window(self):
        # A lock pointing at a deleted folder must never lock the user out.
        self.setUpLock()
        gone = self.root / "gone-project"
        vscode_mcp._write_workspace_lock(gone)
        self.assertIsNone(vscode_mcp._read_workspace_lock())
        focused = self.root / "focused"
        focused.mkdir()
        with patch.object(vscode_mcp, "_active_window_folder", return_value=focused):
            self.assertEqual(vscode_mcp._vscode_active_folder(), focused)

    def test_app_override_wins_over_lock(self):
        self.setUpLock()
        app_project = self.root / "app-project"
        app_project.mkdir()
        vscode_mcp._write_workspace_lock(self.workspace)
        with patch.dict("os.environ", {"ZS_WORKSPACE": str(app_project)}):
            self.assertEqual(vscode_mcp._vscode_active_folder(), app_project)

    def test_lock_workspace_rejects_missing_directory(self):
        self.setUpLock()
        with self.assertRaises(FileNotFoundError):
            vscode_mcp.lock_workspace(str(self.root / "missing"))

    def test_get_workspace_info_reports_lock_state(self):
        self.setUpLock()
        info = vscode_mcp.get_workspace_info()
        self.assertFalse(info["workspace_locked"])
        self.assertEqual(info["workspace_source"], "vscode-window")
        vscode_mcp.lock_workspace(str(self.workspace))
        info = vscode_mcp.get_workspace_info()
        self.assertTrue(info["workspace_locked"])
        self.assertEqual(info["workspace_source"], "lock")

    # ── Per-tab session workspaces ───────────────────────────────────────────
    def test_session_pin_overrides_global_chain(self):
        self.setUpLock()
        self.useRealRoot()
        other_project = self.root / "other-project"
        other_project.mkdir()
        vscode_mcp._CURRENT_SESSION = "111"
        vscode_mcp.lock_workspace(str(self.workspace))
        with patch.object(vscode_mcp, "_active_window_folder", return_value=other_project):
            self.assertEqual(vscode_mcp.get_root(), self.workspace.resolve())
            self.assertEqual(vscode_mcp._workspace_source(), "session")

    def test_two_sessions_hold_different_projects(self):
        self.setUpLock()
        self.useRealRoot()
        project_a = self.root / "bpr"
        project_a.mkdir()
        project_b = self.root / "psak414"
        project_b.mkdir()
        vscode_mcp._CURRENT_SESSION = "111"
        vscode_mcp.lock_workspace(str(project_a))
        vscode_mcp._CURRENT_SESSION = "222"
        vscode_mcp.lock_workspace(str(project_b))
        vscode_mcp._CURRENT_SESSION = "111"
        self.assertEqual(vscode_mcp.get_root(), project_a.resolve())
        vscode_mcp._CURRENT_SESSION = "222"
        self.assertEqual(vscode_mcp.get_root(), project_b.resolve())
        # A session with no pin falls back to the global chain.
        vscode_mcp._CURRENT_SESSION = "333"
        with patch.object(vscode_mcp, "_active_window_folder", return_value=project_a):
            self.assertEqual(vscode_mcp.get_root(), project_a)

    def test_session_lock_does_not_write_global_lock(self):
        self.setUpLock()
        vscode_mcp._CURRENT_SESSION = "111"
        vscode_mcp.lock_workspace(str(self.workspace))
        self.assertFalse((self.root / "test.lock.json").exists())
        # Without a session the global lock file is written again.
        vscode_mcp._CURRENT_SESSION = None
        vscode_mcp.lock_workspace(str(self.workspace))
        self.assertTrue((self.root / "test.lock.json").exists())

    def test_session_unlock_only_clears_own_entry(self):
        self.setUpLock()
        vscode_mcp._CURRENT_SESSION = "111"
        vscode_mcp.lock_workspace(str(self.workspace))
        vscode_mcp._CURRENT_SESSION = None
        vscode_mcp.lock_workspace(str(self.workspace))  # global lock
        vscode_mcp._CURRENT_SESSION = "222"
        result = vscode_mcp.unlock_workspace()
        self.assertFalse(result["removed"])  # nothing of session 222's
        self.assertEqual(vscode_mcp._read_workspace_lock(), self.workspace.resolve())
        vscode_mcp._CURRENT_SESSION = "111"
        result = vscode_mcp.unlock_workspace()
        self.assertTrue(result["removed"])
        self.assertIsNone(vscode_mcp._session_workspace("111"))
        # The global lock survives a session unlock.
        self.assertEqual(vscode_mcp._read_workspace_lock(), self.workspace.resolve())

    def test_session_registry_persists_across_restart(self):
        self.setUpLock()
        self.useRealRoot()
        vscode_mcp._CURRENT_SESSION = "111"
        vscode_mcp.lock_workspace(str(self.workspace))
        # Simulate an MCP server restart: fresh globals, registry reloaded.
        vscode_mcp._SESSION_WORKSPACES = {}
        vscode_mcp._SESSIONS_LOADED = False
        self.assertEqual(vscode_mcp._session_workspace("111"), self.workspace.resolve())
        vscode_mcp._CURRENT_SESSION = "111"
        self.assertEqual(vscode_mcp.get_root(), self.workspace.resolve())

    def test_tools_gate_advertises_with_sessions_only(self):
        self.setUpLock()
        with patch.object(vscode_mcp, "_vscode_active_folder", return_value=None):
            vscode_mcp._SESSION_WORKSPACES = {}
            self.assertEqual(vscode_mcp._has_session_workspaces(), False)
            vscode_mcp._SESSION_WORKSPACES = {"111": str(self.workspace)}
            self.assertEqual(vscode_mcp._has_session_workspaces(), True)

    def test_list_vscode_windows_reads_storage_state(self):
        self.setUpLock()
        second = self.root / "second-project"
        second.mkdir()
        storage = self.root / "storage.json"
        storage.write_text(json.dumps({
            "windowsState": {
                "lastActiveWindow": {"folder": f"file://{self.workspace}"},
                "openedWindows": [
                    {"folder": f"file://{self.workspace}"},
                    {"folder": f"file://{second}"},
                    {},
                    {"folder": "file:///does/not/exist"},
                ],
            }
        }), encoding="utf-8")
        with patch.object(vscode_mcp, "_vscode_storage_paths", return_value=[storage]):
            windows = vscode_mcp.list_vscode_windows()
        self.assertEqual(
            windows,
            [
                {"name": self.workspace.name, "path": str(self.workspace.resolve()), "active": True},
                {"name": second.name, "path": str(second.resolve()), "active": False},
            ],
        )

    def test_list_vscode_windows_tolerates_unreadable_storage(self):
        self.setUpLock()
        storage = self.root / "storage.json"
        storage.write_text("not json at all", encoding="utf-8")
        with patch.object(vscode_mcp, "_vscode_storage_paths", return_value=[storage]):
            self.assertEqual(vscode_mcp.list_vscode_windows(), [])

    def test_handle_request_pops_session_key(self):
        self.setUpLock()
        second = self.root / "second-project"
        second.mkdir()
        captured = {}

        def fake_dispatch(name, args):
            captured["name"] = name
            captured["args"] = args
            captured["session"] = vscode_mcp._CURRENT_SESSION
            return "ok"

        sent = []
        with patch.object(vscode_mcp, "tool_dispatch", fake_dispatch), \
             patch.object(vscode_mcp, "send_message", lambda msg: sent.append(msg)):
            vscode_mcp.handle_request({
                "jsonrpc": "2.0", "id": 7, "method": "tools/call",
                "params": {"name": "get_workspace_info",
                           "arguments": {"path": ".", "__zs_session": "999"}},
            })
        self.assertEqual(captured["session"], "999")
        self.assertNotIn("__zs_session", captured["args"])
        # Reset after the request so no other test inherits a session.
        self.assertIsNone(vscode_mcp._CURRENT_SESSION)


if __name__ == "__main__":
    unittest.main()
