"""Regression for ordinary Windows terminals without Node on PATH."""
from dataclasses import replace
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from sim_agent.adapters.mineflayer import ExecutorClient
from sim_agent.adapters.node_runtime import resolve_node
from sim_agent.app.config import load_config
from sim_agent.domain.errors import ConfigError, TransportError
from test_planner import make_config

ROOT = Path(__file__).resolve().parents[1]


class NodeRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def test_configured_runtime_and_environment_work_without_path(self):
        with patch.dict(os.environ, {"PATH": "", "SIM_NODE": ""}):
            self.assertEqual(Path(resolve_node(sys.executable)).resolve(), Path(sys.executable).resolve())
            with self.assertRaisesRegex(TransportError, "node_executable"):
                resolve_node()
            with patch.dict(os.environ, {"SIM_NODE": sys.executable}):
                self.assertEqual(Path(resolve_node()).resolve(), Path(sys.executable).resolve())
                with self.assertRaises(TransportError):
                    resolve_node("missing-configured-node-binary")

    def test_local_runtime_path_is_relative_to_config_and_validated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            data = json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
            data["node_executable"] = "tools/node.exe"
            path = root / "config.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            self.assertEqual(load_config(path).node_executable, str(root / "tools/node.exe"))
            data["node_executable"] = True
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_config(path)

    async def test_missing_runtime_fails_before_spawning(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = replace(make_config(Path(tmp)), node_executable="missing-node-binary")
            client = ExecutorClient(config)
            with patch.dict(os.environ, {"PATH": "", "SIM_NODE": ""}):
                with self.assertRaisesRegex(TransportError, "找不到 Node.js"):
                    await client.start()
            self.assertIsNone(client._proc)
            await client.shutdown()
