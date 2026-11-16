import unittest
from unittest import mock
import test_backend

class LayoutTests(unittest.TestCase):
    setUp = test_backend.WorkspaceTests.setUp
    git = test_backend.WorkspaceTests.git

    def test_nested_split_pruning_and_persistence(self):
        ws = self.backend.workspace_create('Layout')['workspace']
        first = ws['terminals'][0]
        second = self.backend.terminal_split(ws['id'], first['id'])
        third = self.backend.terminal_split(ws['id'], second['id'], axis='rows')
        tree = self.backend.ws(ws['id'])['layouts'][first['id']]
        self.assertEqual(tree['axis'], 'columns')
        self.assertEqual(tree['second']['axis'], 'rows')
        self.assertEqual(third['tab_id'], first['id'])
        self.assertEqual(third['cwd'], first['cwd'])
        self.backend.terminal_resize(ws['id'], tree['id'], 0.7)
        self.assertEqual(test_backend.relay.Backend(self.backend.root).ws(ws['id'])['layouts'][first['id']]['ratio'], 0.7)
        with mock.patch.object(test_backend.relay, 'legacy_tmux_session', return_value=None), mock.patch.object(test_backend.relay.DtachSession, 'kill', autospec=True) as kill:
            self.backend.terminal_remove(ws['id'], second['id'])
            self.assertEqual(kill.call_args.args[0].base.name, second['id'])
            self.assertEqual(self.backend.ws(ws['id'])['layouts'][first['id']]['second'], {'terminal': third['id']})
            self.backend.terminal_remove(ws['id'], first['id'])
        self.assertEqual(self.backend.ws(ws['id'])['layouts'][first['id']], {'terminal': third['id']})

    def test_reorder_preserves_all_panes_and_rejects_stale_lists(self):
        a = self.backend.workspace_create('A')['workspace']
        b = self.backend.workspace_create('B')['workspace']
        self.backend.workspace_reorder([b['id'], 'genral', a['id']])
        self.assertEqual([w['id'] for w in self.backend.snapshot()['workspaces']], [b['id'], 'genral', a['id']])
        first = a['terminals'][0]
        split = self.backend.terminal_split(a['id'], first['id'])
        new = self.backend.terminal_new(a['id'])
        self.backend.terminal_reorder(a['id'], [new['id'], first['id']])
        self.assertEqual([t['id'] for t in self.backend.ws(a['id'])['terminals']], [new['id'], first['id'], split['id']])
        with self.assertRaises(ValueError): self.backend.terminal_reorder(a['id'], [first['id']])
        with self.assertRaises(ValueError): self.backend.workspace_reorder([a['id']])
        with self.assertRaises(ValueError): self.backend.terminal_split(a['id'], first['id'], axis='invalid')
        with self.assertRaises(ValueError): self.backend.terminal_resize(a['id'], 'missing', 0.5)
