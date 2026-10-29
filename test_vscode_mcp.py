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

    def test_catalog_has_28_unique_tools(self):
        names = [tool["name"] for tool in vscode_mcp.TOOLS]
        self.assertEqual(len(names), 28)
        self.assertEqual(len(set(names)), 28)
        for name in ("delete_file", "apply_patch", "git_add", "git_commit"):
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


if __name__ == "__main__":
    unittest.main()
