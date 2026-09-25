import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from test_backend import relay as backend

class MigrationTests(unittest.TestCase):
    def test_paths_and_cli_are_migrated_without_copying_workspaces(self):
        with tempfile.TemporaryDirectory() as folder:
            old = Path(folder) / "Magi"
            app = backend.Backend(old)
            ws = app.workspace_create("Retained task")["workspace"]
            app.install_cli()
            marker = Path(ws["path"]) / "keep.txt"
            marker.write_text("uncommitted work")
            inode = marker.stat().st_ino
            new = Path(folder) / "Relay"
            migrated = backend.Backend(new)
            installed = migrated.install_cli()
            restored = migrated.ws(ws["id"])
            self.assertEqual(restored["path"], str(new.resolve() / "workspaces" / ws["id"]))
            self.assertEqual((Path(restored["path"]) / "keep.txt").stat().st_ino, inode)
            self.assertTrue(old.is_symlink())
            self.assertEqual(Path(installed["path"]).name, "relay")
            self.assertEqual((new / "utils/bin/magi").read_text(), Path(installed["path"]).read_text())
            self.assertEqual(backend.Backend(new).ws(ws["id"]), restored)

    def test_existing_independent_roots_are_not_merged(self):
        with tempfile.TemporaryDirectory() as folder:
            old = backend.Backend(Path(folder) / "Magi")
            new = Path(folder) / "Relay"
            new.mkdir()
            backend.Backend(new)
            self.assertFalse(old.root.is_symlink())

    def test_current_sess_presets_are_discovered(self):
        with tempfile.TemporaryDirectory() as folder:
            preset = Path(folder) / 'sess.json'
            preset.write_text(json.dumps({'version': 1, 'host': 'qa-vm', 'hosts': ['qa-vm']}))
            with mock.patch.dict(os.environ, {'SESS_CONFIG': str(preset), 'SESS_DIR': str(folder)}):
                snapshot = backend.Backend(Path(folder) / 'data').snapshot()
            matches = [h for h in snapshot['sessRemotes'] if h['ssh'] == 'qa-vm']
            self.assertEqual(matches, [{'name': 'qa-vm', 'ssh': 'qa-vm', 'root': '~/relay'}])

    def test_legacy_sess_aliases_dedupe_against_presets(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'remote').write_text(
                'default.host=local-vm\nother.host=local-vm\nunique.host=qa-box\n'
            )
            preset = Path(folder) / 'sess.json'
            preset.write_text(json.dumps({'version': 1, 'host': 'local-vm', 'hosts': ['local-vm']}))
            with mock.patch.dict(os.environ, {'SESS_CONFIG': str(preset), 'SESS_DIR': str(folder)}):
                snapshot = backend.Backend(Path(folder) / 'data').snapshot()
            self.assertEqual(
                [(h['name'], h['ssh']) for h in snapshot['sessRemotes']],
                [('local-vm', 'local-vm'), ('unique', 'qa-box')],
            )
