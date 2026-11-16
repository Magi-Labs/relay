import unittest
from pathlib import Path
from unittest import mock
import test_backend

class FileLinkTests(unittest.TestCase):
    setUp = test_backend.WorkspaceTests.setUp
    git = test_backend.WorkspaceTests.git

    def test_general_files_and_external_terminal_cwd(self):
        ws = self.backend.ws('genral')
        folder = Path(ws['path'])
        (folder / 'notes.md').write_text('General notes')
        self.assertEqual(self.backend.file('genral', '@workspace', 'notes.md')['text'], 'General notes')
        self.assertIn('notes.md', [e['name'] for e in self.backend.files('genral', '@workspace')['entries']])
        result = self.backend.resolve_links('genral', ws['terminals'][0]['id'], ['notes.md', 'missing.md', '.'])
        self.assertEqual(result[0]['path'], str(folder / 'notes.md'))
        self.assertEqual(result[1:], [None, None])
        elsewhere = folder.parent / 'outside'
        elsewhere.mkdir()
        (elsewhere / 'with spaces.txt').write_text('Outside file')
        ws['terminals'][0]['started'] = True
        self.backend.save_ws(ws)
        with mock.patch.object(test_backend.relay.Backend, 'live_cwd', return_value=str(elsewhere)):
            result = self.backend.resolve_links('genral', ws['terminals'][0]['id'], ['with spaces.txt'])
        self.assertEqual(self.backend.file('genral', **result[0])['text'], 'Outside file')
        with self.assertRaises(ValueError): self.backend.file('genral', '@workspace', '../outside/with spaces.txt')

    def test_canonical_identity_and_external_tree(self):
        ws = self.backend.ws('genral')
        root = Path(ws['path'])
        (root / 'notes.md').write_text('notes')
        (root / 'alias.md').symlink_to('notes.md')
        first = self.backend.file_info('genral', '@workspace', 'notes.md')
        alias = self.backend.file_info('genral', '@workspace', 'alias.md')
        linked = self.backend.file_info('genral', '@files', str(root / 'notes.md'))
        self.assertEqual(first, alias)
        self.assertEqual(first, linked)
        self.assertEqual(self.backend.terminal_cwd('genral', ws['terminals'][0]['id'])['path'], str(root))
        external = root.parent / 'external'
        external.mkdir()
        (external / 'remote.md').write_text('remote')
        listing = self.backend.files('genral', '@files', str(external))
        self.assertEqual(listing['entries'][0]['path'], str(external / 'remote.md'))
        with self.assertRaises(ValueError): self.backend.files('genral', '@files', '../relative')
        with self.assertRaises(ValueError): self.backend.file_info('genral', '@workspace', '../escape')
