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
    def test_linux_setup_writes_repo_entry_with_workspace_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            with patch.object(setup_config.sys, "platform", "linux"), patch.object(
                setup_config, "CONFIG_PATH", config_path
            ), patch.dict(
                os.environ, {"ZS_WORKSPACE_ROOT": temp_dir}, clear=False
            ):
                result = setup_config.main()
            self.assertEqual(result, 0)
            config = json.loads(config_path.read_text(encoding="utf-8"))
        entry = config["mcpServers"]["repo"]
        self.assertEqual(entry["args"], [str(setup_config.WORKSPACE_MCP)])
        self.assertEqual(entry["env"]["ZS_WORKSPACE_ROOT"], temp_dir)

    def test_non_linux_setup_is_refused(self):
        with patch.object(setup_config.sys, "platform", "darwin"):
            self.assertEqual(setup_config.main(), 1)


if __name__ == "__main__":
    unittest.main()
