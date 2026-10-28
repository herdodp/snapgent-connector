import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("setup-config.py")
SPEC = importlib.util.spec_from_file_location("setup_config", MODULE_PATH)
setup_config = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup_config)


class SetupConfigTests(unittest.TestCase):
    def test_linux_setup_writes_local_vscode_configuration(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            with patch.object(setup_config.sys, "platform", "linux"), patch.object(
                setup_config, "CONFIG_PATH", config_path
            ), patch.object(
                setup_config, "_roblox_studio_mcp", return_value=None
            ), patch.object(setup_config, "_effectcraft_cli", return_value=None):
                result = setup_config.main()
            self.assertEqual(result, 0)
            config = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertEqual(
            config["mcpServers"]["vscode"]["args"],
            [str(setup_config.VSCODE_MCP)],
        )

    def test_linux_effectcraft_cli_is_discovered_from_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            cli = Path(temp_dir) / "effectcraft-cli"
            cli.write_text("#!/bin/sh\n", encoding="utf-8")
            cli.chmod(0o755)
            with patch.object(setup_config.sys, "platform", "linux"), patch.dict(
                os.environ, {"PATH": temp_dir}
            ):
                detected = setup_config._effectcraft_cli(None)
        self.assertEqual(detected, cli.resolve())

    def test_linux_studio_mcp_requires_explicit_override(self):
        with patch.object(setup_config.sys, "platform", "linux"), patch.dict(
            os.environ, {}, clear=True
        ):
            self.assertIsNone(setup_config._roblox_studio_mcp())
        with tempfile.TemporaryDirectory() as temp_dir:
            binary = Path(temp_dir) / "StudioMCP"
            binary.write_text("#!/bin/sh\n", encoding="utf-8")
            binary.chmod(0o755)
            with patch.object(setup_config.sys, "platform", "linux"), patch.dict(
                os.environ, {"ZS_STUDIO_MCP_PATH": str(binary)}
            ):
                self.assertEqual(setup_config._roblox_studio_mcp(), binary.resolve())


if __name__ == "__main__":
    unittest.main()
