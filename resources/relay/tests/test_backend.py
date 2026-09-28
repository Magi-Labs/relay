import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1] / 'backend' / 'relay.py'
spec = importlib.util.spec_from_file_location('relay', BACKEND)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='relay-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.backend = relay.Backend(self.base / "Relay root's space")
        self.repos = {}
        for name in ('web', 'api'):
            p = self.base / name
            p.mkdir()
            self.git(p, 'init', '-b', 'main')
            self.git(p, 'config', 'user.name', 'Relay Test')
            self.git(p, 'config', 'user.email', 'relay-test@example.invalid')
            (p / 'hello.txt').write_text('initial\n')
            self.git(p, 'add', '.')
            self.git(p, 'commit', '-m', 'Initial')
            self.backend.repo_register(str(p), name)
            self.repos[name] = p

    def test_host_add_and_remove_roundtrip(self):
        with tempfile.TemporaryDirectory() as folder:
            service = relay.Backend(Path(folder))
            service.host_add('qa-box', 'user@host')
            self.assertIn('qa-box', [h['name'] for h in service.snapshot()['hosts']])
            service.host_remove('qa-box')
            self.assertNotIn('qa-box', [h['name'] for h in service.snapshot()['hosts']])
            with self.assertRaises(ValueError):
                service.host_remove('qa-box')

    def test_permanent_general_per_host_and_restart(self):
        general = self.backend.snapshot()['workspaces'][0]
        self.assertEqual((general['id'], general['name'], general['permanent']), ('genral', 'Genral', True))
        with self.assertRaisesRegex(ValueError, 'permanent'):
            self.backend.workspace_archive('genral')
        attached = self.backend.repo_attach('genral', 'web')
        restarted = relay.Backend(self.backend.root)
        self.assertEqual(restarted.ws('genral')['terminals'], general['terminals'])
        self.assertEqual(restarted.ws('genral')['repos'][0], attached)
        self.assertEqual(len([w for w in restarted.snapshot()['workspaces'] if w['id']=='genral']), 1)
        another = relay.Backend(self.base / 'another-host')
        self.assertNotEqual(another.ws('genral')['path'], general['path'])
        self.assertEqual(another.ws('genral')['repos'], [])
        task = restarted.workspace_create('Disposable task')['workspace']
        restarted.workspace_archive(task['id'])
        self.assertEqual([w['id'] for w in restarted.snapshot()['workspaces']], ['genral'])
        result = subprocess.run([sys.executable, str(BACKEND), '--root', str(self.backend.root), '--workspace', 'genral', 'workspace', 'archive', '--json'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('permanent', result.stdout)

    def git(self, p, *args, ok=(0,)):
        return relay.git(p, *args, ok=ok)

    def create(self, repos=None):
        return self.backend.workspace_create('Task', repos=([{'repo': 'web'}, {'repo': 'api'}] if repos is None else repos))['workspace']

    def test_two_repos_isolation_diffs_stage_and_commit(self):
        ws = self.create()
        self.assertEqual(len(ws['repos']), 2)
        web, api = (Path(r['path']) for r in ws['repos'])
        (web / 'hello.txt').write_text('web change\n')
        (api / 'hello.txt').write_text('api change\n')
        status = self.backend.status(ws['id'])
        self.assertEqual([len(r['files']) for r in status['repos']], [1, 1])
        self.assertEqual((self.repos['web'] / 'hello.txt').read_text(), 'initial\n')
        self.assertIn('+web change', self.backend.diff(ws['id'], 'web', 'hello.txt')['text'])
        self.assertNotIn('api change', self.backend.diff(ws['id'], 'web')['text'])
        self.backend.git_action(ws['id'], 'web', 'stage', 'hello.txt')
        self.assertIn('+web change', self.backend.diff(ws['id'], 'web', 'hello.txt', 'staged')['text'])
        self.backend.git_action(ws['id'], 'web', 'commit', message='Update web')
        self.assertEqual(self.backend.status(ws['id'])['repos'][0]['files'], [])
        self.assertIn('+web change', self.backend.diff(ws['id'], 'web', scope='branch')['text'])

    def test_branch_in_use_partial_failure_and_retry(self):
        result = self.backend.workspace_create('Partial', [{'repo':'web', 'branch':'main'}, {'repo':'api'}])
        self.assertEqual(len(result['errors']), 1)
        ws = result['workspace']
        self.assertEqual(len(ws['repos']), 1)
        self.assertEqual(ws['terminals'], [])
        attached = self.backend.repo_attach(ws['id'], 'web', new_branch='task/retry')
        self.assertEqual(attached, self.backend.repo_attach(ws['id'], 'web', new_branch='task/retry'))
        with self.assertRaises(ValueError): self.backend.repo_attach(ws['id'], 'web', new_branch='other')

    def test_existing_free_branch(self):
        self.git(self.repos['web'], 'branch', 'existing')
        ws = self.create([{'repo':'web', 'branch':'existing'}])
        self.assertEqual(ws['repos'][0]['branch'], 'existing')

    def test_blank_cli_lazy_attachment(self):
        ws = self.create([])
        p = subprocess.run([sys.executable, str(BACKEND), '--root', str(self.backend.root), '--workspace', ws['id'], 'repo', 'attach', 'web', '--new-branch', 'task/lazy', '--base', 'main', '--json'], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        self.assertTrue(Path(json.loads(p.stdout)['data']['path']).is_dir())
        self.assertEqual(len(self.backend.ws(ws['id'])['repos']), 1)
        self.assertIn('task/lazy', (self.backend.ws_path(ws['id'])/'AGENTS.md').read_text())

    def test_untracked_rename_unstage_and_special_filenames(self):
        ws = self.create([{'repo':'web'}]); p=Path(ws['repos'][0]['path'])
        unusual = 'line\nbreak " quote.txt'
        (p / unusual).write_text('new file\n')
        self.git(p, 'mv', 'hello.txt', 'renamed file.txt')
        status=self.backend.status(ws['id'])['repos'][0]['files']
        renamed=next(f for f in status if f['index']=='R')
        self.assertEqual(renamed['original'],'hello.txt')
        self.backend.git_action(ws['id'],'web','unstage','renamed file.txt')
        self.assertEqual(self.git(p,'diff','--cached'), b'')
        self.assertTrue(any(f['path']==unusual and f['untracked'] for f in status))
        self.assertEqual(self.backend.diff(ws['id'],'web',unusual)['text'],'new file\n')
        self.backend.git_action(ws['id'],'web','stage',unusual)
        self.backend.git_action(ws['id'],'web','unstage',unusual)
        self.assertTrue(any(f['path']==unusual and f['untracked'] for f in self.backend.status(ws['id'])['repos'][0]['files']))

    def test_conflict(self):
        p=self.repos['web'];self.git(p,'checkout','-b','other')
        (p/'hello.txt').write_text('other\n');self.git(p,'commit','-am','other');self.git(p,'checkout','main')
        ws=self.create([{'repo':'web'}]);p=Path(ws['repos'][0]['path'])
        (p/'hello.txt').write_text('task\n');self.git(p,'commit','-am','task');self.git(p,'merge','other',ok=(1,))
        self.assertTrue(self.backend.status(ws['id'])['repos'][0]['files'][0]['conflict'])

    def test_large_diff_is_bounded(self):
        ws=self.create([{'repo':'web'}]);p=Path(ws['repos'][0]['path'])
        (p/'hello.txt').write_text(('generated line content\n')*120000)
        result=self.backend.diff(ws['id'],'web','hello.txt')
        self.assertTrue(result['truncated'])
        self.assertLessEqual(len(result['text'].encode()),relay.MAX_TEXT)

    def test_appearance_preferences_persist_and_validate(self):
        self.assertEqual(self.backend.preferences_get()['theme'],'graphite')
        self.backend.preferences_set({'theme':'paper','font_size':17,'show_repos':False})
        other=relay.Backend(self.backend.root)
        self.assertEqual(other.preferences_get()['font_size'],17)
        self.assertFalse(other.preferences_get()['show_repos'])
        for values in ({'font_size':500},{'theme':'invalid'},{'show_repos':'false'},{'unknown':1},{'left_width':True}):
            with self.assertRaises(ValueError):other.preferences_set(values)
        self.assertEqual(other.preferences_get()['theme'],'paper')
        self.assertEqual(other.snapshot()['preferences']['font_size'],17)

    def test_clone_uses_gh_and_infers_name(self):
        real_run=relay.run
        calls=[]
        def fake_run(args,**kwargs):
            if args[:3]==['gh','repo','clone']:
                calls.append((args,kwargs))
                return real_run(['git','clone','--',str(self.repos['web']),args[4]])
            return real_run(args,**kwargs)
        with mock.patch.object(relay.shutil,'which',return_value='/usr/bin/gh'),mock.patch.object(relay,'run',side_effect=fake_run):
            repo=self.backend.repo_register(url='example/cloned.git')
        self.assertEqual(repo['id'],'cloned')
        self.assertEqual(calls[0][0][:4],['gh','repo','clone','example/cloned.git'])
        self.assertEqual(calls[0][1]['env']['GH_PROMPT_DISABLED'],'1')
        self.assertTrue(Path(repo['path']).is_dir())

    def test_gh_missing_is_actionable_and_keeps_registry(self):
        with mock.patch.object(relay.shutil,'which',return_value=None):
            with self.assertRaisesRegex(ValueError,'gh auth login'):self.backend.repo_register(url='example/clone')
        self.assertEqual(len(self.backend.config()['repos']),2)
        self.assertFalse((self.backend.root/'repos'/'clone').exists())

    def test_utility_and_path_safety(self):
        p=self.base/'mindmap';self.git(self.base,'clone',str(self.repos['web']),str(p))
        self.backend.repo_register(str(p),'mindmap',utility=True)
        ws=self.create([])
        self.assertTrue(self.backend.status(ws['id'])['repos'][0]['utility'])
        with self.assertRaises(ValueError):self.backend.repo_attach(ws['id'],'mindmap')
        with self.assertRaises(ValueError):self.backend.file(ws['id'],'mindmap','../../api/hello.txt')
        (p/'outside').symlink_to(self.base/'api'/'hello.txt')
        with self.assertRaises(ValueError):self.backend.file(ws['id'],'mindmap','outside')

    def test_concurrent_cli_attachments_preserve_manifest(self):
        ws=self.create([])
        def attach(repo):
            return subprocess.run([sys.executable,str(BACKEND),'--root',str(self.backend.root),'--workspace',ws['id'],'repo','attach',repo,'--json'],capture_output=True,text=True)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:results=list(pool.map(attach,['web','api']))
        self.assertEqual([r.returncode for r in results],[0,0],str(results))
        self.assertEqual(len(self.backend.ws(ws['id'])['repos']),2)

    def test_terminal_reuses_live_tmux_and_exports_cli(self):
        ws=self.create([]);t=ws['terminals'][0];session='relay-'+t['id']
        self.addCleanup(lambda:subprocess.run(['tmux','kill-session','-t','='+session],capture_output=True))
        prepared=self.backend.terminal_prepare(ws['id'],t['id'])
        target=relay.text(relay.run(['tmux','list-panes','-s','-t',session,'-F','#{pane_id}'])).splitlines()[0]
        first=relay.run(['tmux','display-message','-p','-t',target,'#{pane_pid}'])
        self.backend.terminal_prepare(ws['id'],t['id'])
        self.assertEqual(first,relay.run(['tmux','display-message','-p','-t',target,'#{pane_pid}']))
        self.assertEqual(prepared['env']['RELAY_WORKSPACE'],ws['id'])
        command='echo RELAY_READY; printf "%s\\n" "$RELAY_ROOT"; relay status --json'
        relay.run(['tmux','send-keys','-t',target,command,'Enter'])
        deadline=time.monotonic()+8
        content=''
        while time.monotonic()<deadline:
            content=relay.text(relay.run(['tmux','capture-pane','-p','-t',target,'-S','-100']))
            if '"ok": true' in content:break
            time.sleep(.1)
        self.assertIn('"ok": true',content)

    def test_rpc_multiple_requests_and_errors(self):
        reqs=[{'op':'snapshot'},{'op':'unknown'},{'op':'snapshot'}]
        p=subprocess.run([sys.executable,str(BACKEND),'--root',str(self.backend.root),'--rpc'],input=''.join(json.dumps(r)+'\n' for r in reqs),text=True,capture_output=True)
        self.assertEqual([json.loads(l)['ok'] for l in p.stdout.splitlines()],[True,False,True])


if __name__=='__main__':unittest.main()
