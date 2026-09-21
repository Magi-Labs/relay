import unittest
from pathlib import Path
import test_backend

class FileEditTests(unittest.TestCase):
    setUp = test_backend.WorkspaceTests.setUp
    git = test_backend.WorkspaceTests.git

    def test_save_and_conflict_preserve_contents_and_mode(self):
        p = Path(self.backend.ws('genral')['path']) / 'note.txt'
        p.write_bytes(b'original\r\n')
        p.chmod(0o640)
        before = self.backend.file('genral', '@workspace', p.name)
        saved = self.backend.dispatch('file_save', dict(workspace='genral', repo='@workspace', path=p.name, text='edited\r\n', version=before['version']))
        self.assertEqual(p.read_bytes(), b'edited\r\n')
        self.assertEqual(p.stat().st_mode & 0o777, 0o640)
        p.write_text('agent edit')
        with self.assertRaisesRegex(ValueError, 'changed on disk'):
            self.backend.file_save('genral', '@workspace', p.name, 'stale', saved['version'])
        self.assertEqual(p.read_text(), 'agent edit')

    def test_encoding_and_traversal(self):
        p = Path(self.backend.ws('genral')['path']) / 'note.txt'
        p.write_bytes(b'\xff\xfe')
        self.assertTrue(self.backend.file('genral', '@workspace', p.name)['binary'])
        with self.assertRaises(ValueError):
            self.backend.file_save('genral', '@workspace', '../outside', 'oops', 'hash')
