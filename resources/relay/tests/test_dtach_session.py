import os
import time
import unittest
import test_backend

relay = test_backend.relay


class ScreenRenderTests(unittest.TestCase):
    def test_cursor_redraws_collapse_to_final_frame(self):
        frames = b'$ claude\r\n\xe2\x8f\xba thinking 1\r\nstatus\r\n' + b'\x1b[2A\r\x1b[2K\xe2\x8f\xba done\r\n\x1b[2Kready\r\n'
        self.assertEqual(relay.render_screen(frames, 80, 24), ['$ claude', '⏺ done', 'ready', ''])

    def test_alternate_screen_is_shown_while_active_and_discarded_after(self):
        data = b'before\r\n\x1b[?1049h\x1b[H\x1b[2Jeditor'
        self.assertEqual(relay.render_screen(data, 20, 3)[0], 'editor')
        self.assertEqual(relay.render_screen(data + b'\x1b[?1049lafter', 20, 3), ['before', 'after'])

    def test_wraps_at_terminal_width_and_ignores_colors(self):
        self.assertEqual(relay.render_screen(b'\x1b[31mabcdef\x1b[0m', 4, 5), ['abcd', 'ef'])

    def test_replay_strips_queries_that_xterm_would_answer(self):
        data = b'a\x1b[c b\x1b[6n c\x1b]11;?\x07 d\x1b[>0q e\x1b[?u f\x1b[31m'
        self.assertEqual(relay.TERMINAL_QUERY.sub(b'', data), b'a b c d e f\x1b[31m')


class DtachSessionTests(unittest.TestCase):
    setUp = test_backend.WorkspaceTests.setUp
    git = test_backend.WorkspaceTests.git

    def test_long_roots_fall_back_to_private_socket_directory(self):
        session = relay.DtachSession(self.base / ('x' * 120), 'abcdef123456')
        self.assertLessEqual(len(str(session.sock)), 100)
        self.assertEqual(session.sock.parent.stat().st_mode & 0o077, 0)
        self.assertTrue(str(session.log).startswith(str(self.base)))

    def test_missing_dtach_is_reported(self):
        ws = self.backend.workspace_create('No dtach')['workspace']
        with test_backend.mock.patch.object(relay.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(ValueError, 'dtach is required'):
                self.backend.terminal_prepare(ws['id'], ws['terminals'][0]['id'])

    @unittest.skipUnless(relay.shutil.which('dtach'), 'dtach is not installed')
    def test_session_survives_and_reports_cwd_and_foreground_agent(self):
        ws = self.backend.workspace_create('Live')['workspace']
        t = self.backend.terminal_run(ws['id'], 'mkdir -p deeper && cd deeper && exec -a codex sleep 30')['terminal']
        session = relay.DtachSession(self.backend.root, t['id'])
        self.addCleanup(session.kill)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and not (session.pid() and session.cwd().endswith('/deeper')):
            time.sleep(.05)
        self.assertTrue(self.backend.terminal_cwd(ws['id'], t['id'])['path'].endswith('/deeper'))
        agents = None
        while time.monotonic() < deadline and not agents:
            agents = self.backend.terminal_agents(self.backend.ws(ws['id'])['terminals'])
            agents = agents and agents.get(t['id'])
            time.sleep(.05)
        self.assertEqual(agents, 'codex')
        self.assertEqual(self.backend.terminal_prepare(ws['id'], t['id'])['args'][1:2], ['--attach'])


class ChangeTrackingTests(unittest.TestCase):
    setUp = test_backend.WorkspaceTests.setUp
    git = test_backend.WorkspaceTests.git

    def test_fingerprint_moves_on_edits_and_holds_for_reads(self):
        first = self.backend.changes()['fingerprint']
        self.assertEqual(self.backend.snapshot()['fingerprint'], first)
        ws = self.backend.workspace_create('Agent made')['workspace']
        second = self.backend.changes()['fingerprint']
        self.assertNotEqual(first, second)
        self.backend.status(ws['id'])
        self.backend.snapshot()
        self.assertEqual(self.backend.changes()['fingerprint'], second)
        time.sleep(.01)
        self.backend.terminal_new(ws['id'], name='Agent tab')
        self.assertNotEqual(self.backend.changes()['fingerprint'], second)

    def test_terminal_state_reports_exit_only_after_start(self):
        ws = self.backend.workspace_create('States')['workspace']
        t = ws['terminals'][0]['id']
        self.assertEqual(self.backend.terminal_state(ws['id'], t)['state'], 'live')
        data = self.backend.ws(ws['id'])
        data['terminals'][0]['started'] = True
        self.backend.save_ws(data)
        with test_backend.mock.patch.object(relay, 'legacy_tmux_session', return_value=None):
            self.assertEqual(self.backend.terminal_state(ws['id'], t)['state'], 'exited')
