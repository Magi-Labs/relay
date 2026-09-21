import json
import subprocess
import sys
import unittest
from pathlib import Path
import test_backend

class ComparisonTests(unittest.TestCase):
    setUp = test_backend.WorkspaceTests.setUp
    git = test_backend.WorkspaceTests.git

    def attach(self):
        return Path(self.backend.repo_attach('genral', 'web')['path'])

    def test_combines_committed_staged_unstaged_untracked_and_deleted(self):
        path = self.attach()
        (path / 'committed.txt').write_text('committed\n')
        self.git(path, 'add', '.')
        self.git(path, 'commit', '-m', 'Worktree commit')
        (path / 'staged.txt').write_text('staged\n')
        self.git(path, 'add', 'staged.txt')
        (path / 'loose.txt').write_text('untracked\n')
        (path / 'hello.txt').unlink()
        row = self.backend.status('genral')['repos'][0]
        self.assertEqual(row['comparison']['ref'], 'main')
        changes = {f['path']: f['worktree'] for f in row['comparison']['files']}
        self.assertEqual(changes, {'committed.txt': 'A', 'staged.txt': 'A', 'loose.txt': 'A', 'hello.txt': 'D'})
        diff = self.backend.diff_content('genral', 'web', 'hello.txt', scope='comparison')
        self.assertEqual((diff['original'], diff['modified']), ('initial\n', ''))
        diff = self.backend.diff_content('genral', 'web', 'loose.txt', scope='comparison')
        self.assertEqual((diff['original'], diff['modified']), ('', 'untracked\n'))
        self.assertNotIn('committed.txt', [f['path'] for f in row['files']])

    def test_ref_validation_persistence_and_cli(self):
        path = self.attach()
        self.git(path, 'branch', 'dev')
        self.assertEqual(self.backend.status('genral')['repos'][0]['comparison']['ref'], 'dev')
        result = subprocess.run([sys.executable, str(test_backend.BACKEND), '--root', str(self.backend.root), '--workspace', 'genral', 'repo', 'compare', 'web', '--ref', 'main', '--json'], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['data']['ref'], 'main')
        self.assertEqual(self.backend.ws('genral')['comparisonRefs']['web'], 'main')
        with self.assertRaises(ValueError): self.backend.repo_compare('genral', 'web', '-oops')
        with self.assertRaises(ValueError): self.backend.repo_compare('genral', 'web', 'missing-ref')
        self.assertEqual(self.backend.ws('genral')['comparisonRefs']['web'], 'main')
        self.backend.repo_compare('genral', 'web', 'dev')
        self.git(path, 'branch', '-D', 'dev')
        row = self.backend.status('genral')['repos'][0]
        self.assertIsNone(row['error'])
        self.assertIn('does not resolve', row['comparison']['error'])

    def test_modified_content_and_unusual_names(self):
        path = self.attach()
        name = 'space\tand\nnewline.txt'
        (path / name).write_text('test\n')
        (path / 'hello.txt').write_text('changed\n')
        row = self.backend.status('genral')['repos'][0]
        self.assertIn(name, [f['path'] for f in row['comparison']['files']])
        diff = self.backend.diff_content('genral', 'web', 'hello.txt', scope='comparison', comparison_ref='main')
        self.assertEqual((diff['original'], diff['modified']), ('initial\n', 'changed\n'))
        with self.assertRaises(ValueError): self.backend.diff_content('genral', 'web', '../outside', scope='comparison')

    def test_inventory_includes_workspace_details_and_redacts_remote_credentials(self):
        path = self.attach()
        self.git(self.repos['web'], 'remote', 'add', 'origin', 'https://user:fake-token@example.invalid/org/repo.git?token=fake')
        rows = self.backend.repo_inventory()['repos']
        row = next(r for r in rows if r['id'] == 'web')
        self.assertEqual(row['remote'], 'https://example.invalid/org/repo.git')
        self.assertEqual(row['workspaces'][0]['path'], str(path))
        self.assertEqual(row['workspaces'][0]['name'], 'Genral')
        self.assertIsNone(row['error'])

    def test_cli_install_adds_documentation_without_overwriting_workspace_instructions(self):
        guide = Path(self.backend.ws('genral')['path']) / 'AGENTS.md'
        guide.write_text('Custom workspace instructions\n')
        self.backend.install_cli()
        self.backend.install_cli()
        content = guide.read_text()
        self.assertTrue(content.startswith('Custom workspace instructions\n'))
        self.assertEqual(content.count('https://github.com/DeepakSilaych/relay/blob/main/resources/relay/backend/RELAY-CLI.md'), 1)
