"""Build webapp/sim.html — a focused view of simulation runs. usage: python3 viz.py"""
import json, os, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import sim

CFGS = [('opus5_playbook', 'Opus 5', 'rules prompt'), ('sonnet5_bare', 'Sonnet 5', 'plain prompt'),
        ('sonnet5_v2', 'Sonnet 5', 'tuned prompt'), ('haiku45_playbook', 'Haiku 4.5', 'rules prompt')]
CATS = [('Quotes', [1, 2, 3, 4, 5, 10]), ('Policy documents', range(6, 10)), ('Renewals', range(11, 15)),
        ('Mid-term changes', range(15, 21)), ('Billing & payments', range(21, 29)), ('New claims (FNOL)', range(29, 37)),
        ('Claims in progress', range(37, 45)), ('Decision & payout', range(45, 48)), ('Third party & privacy', range(48, 51))]
# real-agent runs (eval/public.py writes public_<run>.json); optional
AGENT = Path(os.environ.get('AGENT_RESULTS', Path(__file__).parents[2] / 'eval' / 'results'))
keep = ('action_type', 'recipient', 'message', 'autonomy', 'confidence', 'j_match', 'j_harmful', 'j_why')

cases = {c['id']: c for c in (sim.parse_case(d) for d in sorted(sim.ROOT.glob('0*')))}
escs = {e['case']: e for e in json.loads((sim.OUT / 'escalation_points.json').read_text())}
runs = {cfg: {(r['case'], r['k']): {a: r.get(a) for a in keep}
              for r in json.loads((sim.OUT / f'{cfg}.json').read_text())} for cfg, *_ in CFGS}
cfgs = [{'id': c, 'model': m, 'prompt': p} for c, m, p in CFGS]


def section(text, name):
    m = re.search(rf'^##? *{name}[^\n]*\n(.*?)(?=^##? |\Z)', text or '', re.S | re.M | re.I)
    return m.group(1).strip() if m else ''


def agent_row(r, folder):
    """Map one eval/public.py row onto the sim row shape; next-steps score drives the dot colour."""
    s = r.get('scores') if isinstance(r.get('scores'), dict) else r
    nx, out, jd = (s.get(k) for k in ('next_steps', 'outcome', 'judgement_safety'))
    ans = r.get('answer') or ''
    f = folder / 'answers' / r['case'] / 'ANSWER.md'
    if not ans and f.exists():
        ans = f.read_text()
    steps = r.get('next_steps_text') or section(ans, 'Next steps')
    outcome = r.get('final_outcome') or r.get('outcome_text') or section(ans, 'Final outcome')
    msg = (f'FINAL OUTCOME\n{outcome}\n\n' if outcome else '') + (f'NEXT STEPS\n{steps}' if steps else '')
    return {'action_type': r.get('decision') or r.get('decision_type') or 'agent', 'recipient': 'see answer',
            'message': msg or ans[:8000] or '(no ANSWER.md)',
            'autonomy': None, 'confidence': None,
            'j_match': None if nx is None else 2 if nx >= 8 else 1 if nx >= 5 else 0,
            'j_harmful': bool(r.get('harmful')), 'invented': bool(r.get('invented_facts') or r.get('invented')),
            'scores': {'next steps': nx, 'outcome': out, 'judgement': jd},
            'j_why': r.get('rationale') or r.get('reason') or r.get('judge_reason') or ''}


for f in sorted(AGENT.glob('public_*.json')) if AGENT.is_dir() else []:
    try:
        j = json.loads(f.read_text())
        rows = j.get('cases', j.get('rows', [])) if isinstance(j, dict) else j
        cfg = 'agent_' + f.stem.removeprefix('public_')
        runs[cfg] = {(r['case'], r.get('k') or escs[r['case']]['esc_after'] + 1): agent_row(r, f.with_suffix(''))
                     for r in rows if r.get('case') in escs}
        cfgs.append({'id': cfg, 'model': 'Real agent', 'prompt': f.stem.removeprefix('public_'), 'agent': True})
    except Exception as e:  # a half-written file must not break the page
        print('skip', f.name, e)

data = {'configs': cfgs, 'cats': []}
for name, ids in CATS:
    rows = []
    for n in ids:
        c = cases[f'{n:03d}']
        e = escs[c['id']]
        pts = []
        for k in sim.points(c):
            ev, prev = c['events'][k], c['events'][k - 1]
            pts.append({'k': k + 1, 'n': len(c['events']), 'esc': k == e['esc_after'],
                        'prev': {'from': prev['from'], 'to': prev['to'], 'body': prev['body']},
                        'gold': {'to': ev['to'], 'channel': ev['channel'], 'body': ev['body']},
                        'p': {cfg['id']: runs[cfg['id']].get((c['id'], k + 1)) for cfg in cfgs}})
        title = (sim.ROOT / c['id'] / 'index.md').read_text().splitlines()[0].split(': ', 1)[-1]
        rows.append({'id': c['id'], 'title': title, 'pts': pts,
                     'esc': {a: e.get(a) for a in ('esc_after', 'trigger', 'action_events', 'later_events')}})
    data['cats'].append({'name': name, 'rows': rows})

html = (Path(__file__).parent / 'viz_template.html').read_text().replace('/*DATA*/null', json.dumps(data))
out = Path(__file__).parent / 'webapp' / 'sim.html'
out.write_text(html)
print('wrote', out, f'{len(html) // 1024} KB', f'configs: {[c["id"] for c in cfgs]}')
