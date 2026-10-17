#!/usr/bin/env python3
"""Capture GitHub's requirements, current results, and historical status events."""
import argparse
import collections
import datetime
import json
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('repo', help='owner/repository')
parser.add_argument('pr', type=int)
parser.add_argument('--all-checks', action='store_true', help='Include every check and status, not only required names')
args = parser.parse_args()

def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{args.repo}/{path}']))

def pages(path, key=None):
    result = []
    for page in range(1, 100):
        value = api(f'{path}{"&" if "?" in path else "?"}per_page=100&page={page}')
        batch = value[key] if key else value
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise RuntimeError('Pagination limit reached')

pr = api(f'pulls/{args.pr}')
sha = pr['head']['sha']
checks = pages(f'commits/{sha}/check-runs?filter=all', 'check_runs')
statuses = pages(f'commits/{sha}/statuses')
combined = pages(f'commits/{sha}/status', 'statuses')
rules = api('rules/branches/dev')
names = {'frontend-checks', 'backend-checks'}
print(json.dumps({
    'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'repo': args.repo, 'pr': args.pr, 'head_sha': sha,
    'base': pr['base']['ref'], 'mergeable_state': pr['mergeable_state'],
    'required_check_rules_on_dev': [r for r in rules if r['type'] == 'required_status_checks'],
    'check_runs': [{k: c[k] for k in ['id', 'name', 'status', 'conclusion', 'started_at', 'completed_at', 'html_url']} | {'app_id': c['app']['id'], 'app_slug': c['app']['slug']} for c in checks if args.all_checks or c['name'] in names],
    'current_statuses': [{k: s[k] for k in ['id', 'context', 'state', 'updated_at', 'target_url']} for s in combined if args.all_checks or s['context'] in names],
    'status_history_counts': dict(collections.Counter(s['context'] for s in statuses if args.all_checks or s['context'] in names)),
    'status_history': [{k: s[k] for k in ['id', 'context', 'state', 'created_at', 'target_url']} for s in statuses if args.all_checks or s['context'] in names],
}, indent=2))
