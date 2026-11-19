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
            ), patch.object(
                setup_config, "_effectcraft_cli", return_value=None
            ), patch.object(setup_config, "_effectcraft_app", return_value=None), patch.object(
                setup_config, "_figcraft_cli", return_value=None
            ):
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

    def test_setup_does_not_open_effectcraft_by_default(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            cli = Path(temp_dir) / "effectcraft-cli"
            app = Path(temp_dir) / "effectcraft"
            config_path.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
            with patch.object(setup_config.sys, "platform", "linux"), patch.object(
                setup_config, "CONFIG_PATH", config_path
            ), patch.object(
                setup_config, "_roblox_studio_mcp", return_value=None
            ), patch.object(
                setup_config, "_effectcraft_cli", return_value=cli
            ), patch.object(
                setup_config, "_effectcraft_app", return_value=app
            ), patch.object(
                setup_config, "_figcraft_cli", return_value=None
            ), patch.object(
                setup_config, "_start_effectcraft_control"
            ) as start_app:
                result = setup_config.main()
            configured = json.loads(config_path.read_text(encoding="utf-8"))

        self.assertEqual(result, 0)
        self.assertEqual(
            configured["mcpServers"]["effectcraft"]["args"],
            ["mcp", "--bridge", str(setup_config.EFFECTCRAFT_PORT)],
        )
        start_app.assert_not_called()

    def test_manual_effectcraft_setup_starts_control_channel(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            cli = Path(temp_dir) / "effectcraft-cli"
            app = Path(temp_dir) / "effectcraft"
            config_path.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
            with patch.object(setup_config.sys, "platform", "linux"), patch.object(
                setup_config, "CONFIG_PATH", config_path
            ), patch.object(
                setup_config, "_roblox_studio_mcp", return_value=None
            ), patch.object(
                setup_config, "_effectcraft_cli", return_value=cli
            ), patch.object(
                setup_config, "_effectcraft_app", return_value=app
            ), patch.object(
                setup_config, "_figcraft_cli", return_value=None
            ), patch.object(
                setup_config, "_start_effectcraft_control"
            ) as start_app:
                result = setup_config.main(launch_effectcraft=True)
            configured = json.loads(config_path.read_text(encoding="utf-8"))

        self.assertEqual(result, 0)
        self.assertEqual(
            configured["mcpServers"]["effectcraft"]["args"],
            ["mcp", "--bridge", str(setup_config.EFFECTCRAFT_PORT)],
        )
        start_app.assert_called_once_with(app)

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

    def test_linux_figcraft_cli_is_discovered_from_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            cli = Path(temp_dir) / "figcraft-cli"
            cli.write_text("#!/bin/sh\n", encoding="utf-8")
            cli.chmod(0o755)
            with patch.object(setup_config.sys, "platform", "linux"), patch.dict(
                os.environ, {"PATH": temp_dir}
            ):
                detected = setup_config._figcraft_cli(None)
        self.assertEqual(detected, (cli.resolve(), ["mcp"]))

    def test_linux_figcraft_appimage_is_used_as_fallback(self):
        with tempfile.TemporaryDirectory() as home_dir, tempfile.TemporaryDirectory() as empty_path:
            apps = Path(home_dir) / "Applications"
            apps.mkdir()
            appimage = apps / "FigCraft.AppImage"
            appimage.write_text("#!/bin/sh\n", encoding="utf-8")
            appimage.chmod(0o755)
            with patch.object(setup_config.sys, "platform", "linux"), patch.dict(
                os.environ, {"PATH": empty_path}
            ), patch.object(setup_config.Path, "home", return_value=Path(home_dir)):
                detected = setup_config._figcraft_cli(None)
        self.assertEqual(detected, (appimage.resolve(), ["cli", "mcp"]))

    def test_figcraft_process_and_control_port_are_parsed(self):
        command = "/opt/FigCraft/FigCraft.AppImage --control 127.0.0.1:43125"
        self.assertTrue(setup_config._is_figcraft_process(command))
        self.assertEqual(setup_config._control_port(command), 43125)
        self.assertFalse(setup_config._is_figcraft_process("/usr/bin/figcraft-cli mcp"))
        self.assertFalse(
            setup_config._is_figcraft_process(
                "/opt/FigCraft/FigCraft.AppImage cli mcp --attach 43125",
                Path("/opt/FigCraft/FigCraft.AppImage"),
            )
        )

    def test_setup_attaches_to_running_figcraft_control_port(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            cli = Path(temp_dir) / "figcraft-cli"
            config_path.write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "figcraft": {
                                "command": str(cli),
                                "args": ["mcp", "--attach", "9333"],
                                "env": {"CUSTOM": "kept"},
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(setup_config.sys, "platform", "linux"), patch.object(
                setup_config, "CONFIG_PATH", config_path
            ), patch.object(
                setup_config, "_roblox_studio_mcp", return_value=None
            ), patch.object(
                setup_config, "_effectcraft_cli", return_value=None
            ), patch.object(
                setup_config, "_effectcraft_app", return_value=None
            ), patch.object(
                setup_config,
                "_figcraft_cli",
                return_value=(cli, ["mcp"]),
            ), patch.object(
                setup_config,
                "_figcraft_processes",
                return_value=[(123, "/opt/figcraft --control 43125")],
            ), patch.object(
                setup_config, "_port_listening", return_value=True
            ), patch.object(setup_config, "_start_figcraft_control") as start_app:
                result = setup_config.main()
            configured = json.loads(config_path.read_text(encoding="utf-8"))

        self.assertEqual(result, 0)
        self.assertEqual(
            configured["mcpServers"]["figcraft"]["args"],
            ["mcp", "--attach", "43125"],
        )
        self.assertEqual(configured["mcpServers"]["figcraft"]["env"], {"CUSTOM": "kept"})
        start_app.assert_not_called()

    def test_setup_does_not_restart_figcraft_without_control_channel(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            cli = Path(temp_dir) / "figcraft-cli"
            config_path.write_text(
                json.dumps({"mcpServers": {"figcraft": {"command": str(cli)}}}),
                encoding="utf-8",
            )
            with patch.object(setup_config.sys, "platform", "linux"), patch.object(
                setup_config, "CONFIG_PATH", config_path
            ), patch.object(
                setup_config, "_roblox_studio_mcp", return_value=None
            ), patch.object(
                setup_config, "_effectcraft_cli", return_value=None
            ), patch.object(
                setup_config, "_effectcraft_app", return_value=None
            ), patch.object(
                setup_config, "_figcraft_cli", return_value=(cli, ["mcp"])
            ), patch.object(
                setup_config, "_figcraft_app", return_value=Path(temp_dir) / "figcraft"
            ), patch.object(
                setup_config,
                "_figcraft_processes",
                return_value=[(123, "/opt/figcraft")],
            ), patch.object(
                setup_config, "_start_figcraft_control"
            ) as start_app:
                result = setup_config.main()
            configured = json.loads(config_path.read_text(encoding="utf-8"))

        self.assertEqual(result, 0)
        self.assertEqual(configured["mcpServers"]["figcraft"]["args"], ["mcp"])
        start_app.assert_not_called()

    def test_setup_starts_figcraft_on_a_dynamic_control_port(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            cli = Path(temp_dir) / "figcraft-cli"
            app = Path(temp_dir) / "figcraft"
            config_path.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
            with patch.object(setup_config.sys, "platform", "linux"), patch.object(
                setup_config, "CONFIG_PATH", config_path
            ), patch.object(
                setup_config, "_roblox_studio_mcp", return_value=None
            ), patch.object(
                setup_config, "_effectcraft_cli", return_value=None
            ), patch.object(
                setup_config, "_effectcraft_app", return_value=None
            ), patch.object(
                setup_config, "_figcraft_cli", return_value=(cli, ["mcp"])
            ), patch.object(
                setup_config, "_figcraft_app", return_value=app
            ), patch.object(
                setup_config, "_figcraft_processes", return_value=[]
            ), patch.object(
                setup_config, "_available_port", return_value=54231
            ), patch.object(
                setup_config, "_start_figcraft_control", return_value=True
            ) as start_app:
                result = setup_config.main(launch_figcraft=True)
            configured = json.loads(config_path.read_text(encoding="utf-8"))

        self.assertEqual(result, 0)
        self.assertEqual(
            configured["mcpServers"]["figcraft"]["args"],
            ["mcp", "--attach", "54231"],
        )
        start_app.assert_called_once_with(app, 54231)

    def test_setup_does_not_open_figcraft_by_default(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            cli = Path(temp_dir) / "figcraft-cli"
            app = Path(temp_dir) / "figcraft"
            config_path.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
            with patch.object(setup_config.sys, "platform", "linux"), patch.object(
                setup_config, "CONFIG_PATH", config_path
            ), patch.object(
                setup_config, "_roblox_studio_mcp", return_value=None
            ), patch.object(
                setup_config, "_effectcraft_cli", return_value=None
            ), patch.object(
                setup_config, "_effectcraft_app", return_value=None
            ), patch.object(
                setup_config, "_figcraft_cli", return_value=(cli, ["mcp"])
            ), patch.object(
                setup_config, "_figcraft_app", return_value=app
            ), patch.object(
                setup_config, "_figcraft_processes", return_value=[]
            ), patch.object(
                setup_config, "_start_figcraft_control"
            ) as start_app:
                result = setup_config.main()
            configured = json.loads(config_path.read_text(encoding="utf-8"))

        self.assertEqual(result, 0)
        self.assertEqual(configured["mcpServers"]["figcraft"]["args"], ["mcp"])
        start_app.assert_not_called()


if __name__ == "__main__":
    unittest.main()
