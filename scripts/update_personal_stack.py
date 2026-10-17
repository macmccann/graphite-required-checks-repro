#!/usr/bin/env python3
"""Toggle reporter writes and submit the personal experiment stack."""
import argparse
import datetime
import json
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--reporter', choices=['on', 'off'], required=True)
parser.add_argument('--output', type=pathlib.Path, required=True, help='JSON output outside the checkout')
args = parser.parse_args()

def run(*cmd):
    return subprocess.check_output(cmd, text=True).strip()

repo = pathlib.Path(run('git', 'rev-parse', '--show-toplevel')).resolve()
out = args.output.resolve()
if out.is_relative_to(repo):
    raise SystemExit('Place capture metadata outside the checkout.')
remote = run('git', 'remote', 'get-url', 'origin')
if remote not in ['https://github.com/macmccann/graphite-required-checks-repro.git', 'git@github.com:macmccann/graphite-required-checks-repro.git']:
    raise SystemExit('Run this only in the personal reproduction repository.')
if run('git', 'status', '--porcelain'):
    raise SystemExit('Use a clean checkout.')
subprocess.run(['gt', 'checkout', 'slow-repro-base', '--no-interactive'], check=True)
for name in ['checks.yml', 'testing.yml']:
    path = repo / '.github/workflows' / name
    text = path.read_text()
    text = text.replace('# ci-aggregate-checks: v1', '# ci-aggregate-checks: disabled-for-control')
    if args.reporter == 'on':
        text = text.replace('# ci-aggregate-checks: disabled-for-control', '# ci-aggregate-checks: v1')
    path.write_text(text)
stamp = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
marker = repo / 'fixture/slow-base.txt'
with marker.open('a') as f:
    f.write(f'{stamp()} reporter={args.reporter}\n')
subprocess.run(['gt', 'modify', '-a', '--no-interactive'], check=True)
sha = run('git', 'rev-parse', 'slow-repro-top')
started = stamp()
subprocess.run(['gt', 'submit', '--stack', '--no-edit', '--no-ai', '--no-interactive'], check=True)
metadata = {'submit_started_at': started, 'submit_finished_at': stamp(), 'head_sha': sha, 'reporter': args.reporter}
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(metadata, indent=2)+'\n')
print(json.dumps(metadata), flush=True)
print('Capture the already-open child PR NOW, within ten seconds.', flush=True)
