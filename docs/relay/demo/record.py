"""Run a local multi-repository CLI demo; writes a transcript of actual results."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

repo = Path(__file__).resolve().parents[3]
cli = repo / 'resources/relay/backend/relay.py'
steps = []
with tempfile.TemporaryDirectory(prefix='relay-demo-') as tmp:
    base = Path(tmp)
    root = base / 'workspace-data'
    def command(args):
        result = subprocess.run(args, text=True, capture_output=True, check=True)
        return result.stdout.strip()
    def relay(*args):
        return json.loads(command([sys.executable, str(cli), '--root', str(root), *args, '--json']))['data']
    for name in ['frontend', 'api']:
        p = base / name
        p.mkdir()
        command(['git', 'init', '-q', '-b', 'main', str(p)])
        (p / 'README.md').write_text(f'# {name}\n\nSample project for the Relay demo.\n')
        command(['git', '-C', str(p), 'add', 'README.md'])
        command(['git', '-C', str(p), '-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'Initial sample project'])
        result = relay('repo', 'register', str(p), '--name', name)
        steps.append({'command':f'relay repo register ./sample/{name} --name {name}', 'output':f'Registered repository: {result["name"]}'})
    ws = relay('workspace', 'create', 'Checkout', '--repo', 'frontend,api')
    assert not ws.get('errors'), ws
    ws = ws['workspace']
    wid = ws['id']
    steps.append({'command':'relay workspace create Checkout --repo frontend,api', 'output':'\n'.join(f'{r["id"]}: {r.get("branch", "")} (isolated worktree)' for r in ws['repos'])})
    for r in ws['repos']:
        (Path(r['path'])/'README.md').write_text(f'# {r["id"]}\n\nCheckout feature in progress.\n')
    steps.append({'command':'# Edit README.md in both sample worktrees', 'output':'Two sample files updated on disk.'})
    for name in ['frontend','api']:
        result = relay('--workspace',wid,'repo','compare',name,'--ref','main')
        steps.append({'command':f'relay --workspace CHECKOUT repo compare {name} --ref main','output':f'Comparison saved: {result["ref"]}'})
    result = relay('--workspace',wid,'status')
    steps.append({'command':'relay --workspace CHECKOUT status --json','output':'\n'.join(f'{r["id"]} against {r["comparison"]["ref"]}: '+', '.join(f'{f["worktree"]} {f["path"]}' for f in r['comparison']['files']) for r in result['repos'])})
Path(__file__).with_name('transcript.json').write_text(json.dumps(steps,indent=2)+'\n')
print(json.dumps(steps,indent=2))
