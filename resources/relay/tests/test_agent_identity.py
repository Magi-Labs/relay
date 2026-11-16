import unittest
from unittest import mock
import test_backend

class AgentIdentityTests(unittest.TestCase):
    def test_executables_and_runtime_entrypoints(self):
        cases = {
            '/opt/bin/claude --resume abc': 'claude',
            '/home/user/.local/share/claude/versions/2.1.2': 'claude',
            '/opt/bin/codex --model test': 'codex',
            'node /opt/node_modules/@google/gemini-cli/dist/index.js': 'gemini',
            'node /opt/node_modules/@anthropic-ai/claude-code/cli.js': 'claude',
            'bun /opt/bin/opencode': 'opencode',
            'python3 -m aider.main': 'aider',
            'amp': 'amp', 'droid': 'droid', 'copilot': 'copilot', 'cursor-agent': 'cursor', 'pi': 'pi',
            'echo codex': None, 'rg claude src': None, 'node -e "codex"': None,
            'python3 app.py --agent gemini': None, 'zsh -c "claude"': None,
        }
        for command, expected in cases.items():
            with self.subTest(command=command): self.assertEqual(test_backend.relay.agent_command(command), expected)

    def test_foreground_identity_ignores_background_and_other_sessions(self):
        panes = 'relay-a\t100\nrelay-b\t200\nother\t300'
        table = '\n'.join([
            '100 1 100 110 /bin/zsh',
            '110 100 110 110 node /opt/node_modules/@google/gemini-cli/dist/index.js',
            '111 110 110 110 git status',
            '120 100 120 110 claude',
            '200 1 200 200 /bin/zsh',
            '210 200 210 200 codex',
            '300 1 300 300 aider',
        ])
        result = test_backend.relay.foreground_agents(panes, table, [{'id':'a'}, {'id':'b'}])
        self.assertEqual(result, {'a':'gemini', 'b':None})
        self.assertEqual(test_backend.relay.foreground_agents(panes, '100 1 100 100 /bin/zsh', [{'id':'a'}]), {'a':None})

    def test_unavailable_probe_does_not_claim_exit(self):
        with mock.patch.object(test_backend.relay, 'run', side_effect=ValueError('unreachable')):
            self.assertIsNone(test_backend.relay.Backend.terminal_agents(mock.Mock(root='/nonexistent'), [{'id':'a','started':True}]))
