"""CLI: python -m agent run <cases_dir> --out ANSWERS [--model claude-sonnet-5] [--workers 8]"""
import argparse
import json
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from . import llm
from .agent import safe_run
from .loader import discover, load_case
from .render import answer_md, reasoning_md
from .tools import CaseEnv


def process(path, args, client, prefix):
    cid = path.name if path.is_dir() else path.stem
    out_dir, trace_path = Path(args.out) / cid, Path(args.logs) / f'{cid}.jsonl'
    if args.skip_existing and (out_dir / 'ANSWER.md').exists():
        return {'case': cid, 'skipped': True}
    out_dir.mkdir(parents=True, exist_ok=True)
    trace_path.parent.mkdir(parents=True, exist_ok=True)
    with open(trace_path, 'w') as tf:
        def log(e):
            tf.write(json.dumps({'ts': datetime.now(timezone.utc).isoformat(timespec='seconds'), **e}, ensure_ascii=False, default=str) + '\n')
            tf.flush()
        try:
            case = load_case(path, args.cut.get(cid, args.cut.get('*')))
        except Exception as e:  # loader is tolerant, but never let one case kill the run
            case = {'id': cid, 'files': [str(path)], 'notes': [f'case failed to load: {e}'], 'text': '', 'blocks': []}
        log({'type': 'case_loaded', 'case': cid, 'files': case['files'], 'notes': case['notes'],
             'text_chars': len(case['text']), 'binary_blocks': sum(b['type'] != 'text' for b in case['blocks'])})
        if not case['text'] and not case['blocks']:
            env, meta = CaseEnv(''), {'error': 'no readable content in case', 'turns': 0, 'cost_usd': 0, 'duration_s': 0}
        else:
            env, meta = safe_run(case, client, prefix, args.model, not args.no_thinking, log)
        for name, fn in (('ANSWER.md', lambda: answer_md(case, env, meta)),
                         ('REASONING.md', lambda: reasoning_md(case, env, meta, args.model, trace_path))):
            try:
                text = fn()
            except Exception:
                text = f'# Case {cid}\n\nRendering failed; see trace `{trace_path}`.\n\n```\n{traceback.format_exc()[-1500:]}\n```\n'
            (out_dir / name).write_text(text)
        summary = {'case': cid, 'decision': (env.final or {}).get('decision_type', 'FALLBACK_ESCALATE'),
                   'confidence': (env.final or {}).get('confidence'), 'actions': [a['tool'] for a in env.actions if a['status'] == 'committed'],
                   **{k: meta.get(k) for k in ('turns', 'cost_usd', 'duration_s', 'error', 'stopped')}}
        log({'type': 'summary', **summary})
    return summary


def parse_cut(s):
    """'5' -> all cases cut at event 5; '001:4,022:3' -> per case."""
    if not s:
        return {}
    if ':' not in s:
        return {'*': int(s)}
    return {k.strip(): int(v) for k, v in (p.split(':') for p in s.split(','))}


def main(argv=None):
    load_dotenv()
    ap = argparse.ArgumentParser(prog='agent')
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('run', help='process every case in a folder')
    r.add_argument('cases_dir')
    r.add_argument('--out', default='ANSWERS')
    r.add_argument('--logs', default='logs')
    r.add_argument('--model', default='claude-sonnet-5')
    r.add_argument('--workers', type=int, default=8)
    r.add_argument('--only', help='comma-separated case ids')
    r.add_argument('--skip-existing', action='store_true', help='resume: skip cases that already have ANSWER.md')
    r.add_argument('--no-thinking', action='store_true')
    r.add_argument('--cut-at-event', dest='cut', type=parse_cut, default={},
                   help='dev replay: keep only the first N history events ("N" or "001:4,022:3")')
    args = ap.parse_args(argv)

    cases = discover(args.cases_dir)
    if args.only:
        keep = {c.strip() for c in args.only.split(',')}
        cases = [c for c in cases if (c.name if c.is_dir() else c.stem) in keep]
    if not cases:
        sys.exit(f'no cases found in {args.cases_dir}')
    client, prefix = llm.make_client()
    print(f'{len(cases)} case(s), model {args.model}, {args.workers} workers', flush=True)
    t0 = time.time()

    def one(p):
        try:
            s = process(p, args, client, prefix)
        except Exception as e:  # last-resort guard; process() already handles expected failures
            s = {'case': p.name, 'error': f'{type(e).__name__}: {e}'}
        print(json.dumps(s, default=str), flush=True)
        return s

    with ThreadPoolExecutor(args.workers) as ex:
        rows = list(ex.map(one, cases))
    done = [r for r in rows if not r.get('skipped')]
    failed = [r['case'] for r in done if r.get('error') or r.get('decision') == 'FALLBACK_ESCALATE']
    total = sum(r.get('cost_usd') or 0 for r in done)
    run = {'finished_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'cases_dir': Path(args.cases_dir).name,
           'model': args.model, 'cases': len(done), 'failed': failed, 'cost_usd': round(total, 3),
           'wall_s': round(time.time() - t0, 1), 'rows': rows}
    Path(args.logs).mkdir(parents=True, exist_ok=True)
    (Path(args.logs) / 'run_summary.json').write_text(json.dumps(run, indent=1, default=str))
    print(f"\n{len(done)} processed, {len(failed)} fallback/failed {failed or ''}, est. cost ${total:.2f}, {run['wall_s']}s")
