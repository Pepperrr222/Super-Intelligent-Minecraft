"""Recorder lifecycle and saved artifacts; real compatibility is checked on a server."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import zipfile

from sim_agent.evaluation.mc01.recording import ReplayRecording


class RecordingTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_rejects_unavailable_mod_and_stop_is_once(self):
        server = SimpleNamespace(command=AsyncMock(return_value="Unknown command"))
        recording = ReplayRecording(server)
        with self.assertRaisesRegex(RuntimeError, "录制启动失败"):
            await recording.start("Bot")
        self.assertIsNone(recording.started_at)
        server.command.return_value = "Successfully started 1 recordings"
        with patch("sim_agent.evaluation.mc01.recording.asyncio.sleep", new_callable=AsyncMock):
            await recording.start("Bot")
        server.command.return_value = "Successfully stopped 1 recordings"
        await recording.stop()
        await recording.stop()
        self.assertEqual(server.command.await_count, 3)
        self.assertIsNotNone(recording.stopped_at)

    async def test_manifest_does_not_call_a_partial_archive_saved(self):
        with TemporaryDirectory() as folder:
            server = SimpleNamespace(folder=Path(folder)/"server")
            server.folder.mkdir()
            recording = ReplayRecording(server)
            self.assertEqual(recording.save_manifest()["status"], "missing")
            replay = server.folder/"recordings/players/bot/run.mcpr"
            replay.parent.mkdir(parents=True)
            replay.write_bytes(b"unfinished zip")
            self.assertEqual(recording.save_manifest()["status"], "missing")
            with zipfile.ZipFile(replay, "w") as archive:
                archive.writestr("metaData.json", json.dumps({"mcversion":"1.21.1","duration":1500}))
                archive.writestr("recording.tmcpr", b"packets")
            manifest = recording.save_manifest()
            self.assertEqual(manifest["status"], "saved")
            self.assertEqual(manifest["files"][0]["metadata"]["duration"], 1500)
            self.assertEqual(manifest["files"][0]["path"], "server/recordings/players/bot/run.mcpr")
