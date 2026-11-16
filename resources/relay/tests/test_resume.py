import unittest
from unittest import mock
import test_backend

class ImportedResumeTests(unittest.TestCase):
    setUp = test_backend.WorkspaceTests.setUp
    git = test_backend.WorkspaceTests.git

    def test_resume_command_is_argv_quoted_and_only_started_once(self):
        ws = self.backend.workspace_create('Imported')['workspace']
        terminal = ws['terminals'][0]
        terminal['agent_resume'] = {'agent': 'codex', 'session_id': '01a08f66-bec8-7ab2-9cac-ab819d0b5f64'}
        self.backend.save_ws(ws)
        missing = mock.Mock(returncode=1, stderr=b"can't find session")
        with mock.patch.object(test_backend.relay.shutil, 'which', return_value='/usr/bin/dtach'), mock.patch.object(test_backend.relay.subprocess, 'run', return_value=missing), mock.patch.object(test_backend.relay, 'run') as run:
            self.backend.terminal_prepare(ws['id'], terminal['id'])
            command = run.call_args_list[0].args[0]
            self.assertIn('codex resume 01a08f66-bec8-7ab2-9cac-ab819d0b5f64; exec ', command[-1])
            with self.assertRaisesRegex(ValueError, 'exited'):
                self.backend.terminal_prepare(ws['id'], terminal['id'])
            self.assertEqual(len([c for c in run.call_args_list if c.args[0][:2]==['dtach', '-n']]), 1)
