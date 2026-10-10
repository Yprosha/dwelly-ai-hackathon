"""Build webapp/sim.html — a focused view of simulation runs. usage: python3 viz.py"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import sim

CFGS = [('opus5_playbook', 'Opus 5', 'rules prompt'), ('sonnet5_bare', 'Sonnet 5', 'plain prompt'),
        ('sonnet5_v2', 'Sonnet 5', 'tuned prompt'), ('haiku45_playbook', 'Haiku 4.5', 'rules prompt')]
CATS = [('Quotes', [1, 2, 3, 4, 5, 10]), ('Policy documents', range(6, 10)), ('Renewals', range(11, 15)),
        ('Mid-term changes', range(15, 21)), ('Billing & payments', range(21, 29)), ('New claims (FNOL)', range(29, 37)),
        ('Claims in progress', range(37, 45)), ('Decision & payout', range(45, 48)), ('Third party & privacy', range(48, 51))]

cases = {c['id']: c for c in (sim.parse_case(d) for d in sorted(sim.ROOT.glob('0*')))}
runs = {cfg: {(r['case'], r['k']): r for r in json.loads((sim.OUT / f'{cfg}.json').read_text())} for cfg, *_ in CFGS}
keep = ('action_type', 'recipient', 'message', 'autonomy', 'confidence', 'j_match', 'j_harmful', 'j_why')

data = {'configs': [{'id': c, 'model': m, 'prompt': p} for c, m, p in CFGS], 'cats': []}
for name, ids in CATS:
    rows = []
    for n in ids:
        c = cases[f'{n:03d}']
        pts = []
        for k in sim.points(c):
            e, prev = c['events'][k], c['events'][k - 1]
            pts.append({'k': k + 1, 'n': len(c['events']),
                        'prev': {'from': prev['from'], 'to': prev['to'], 'body': prev['body']},
                        'gold': {'to': e['to'], 'channel': e['channel'], 'body': e['body']},
                        'p': {cfg: {a: runs[cfg][(c['id'], k + 1)].get(a) for a in keep} for cfg, *_ in CFGS}})
        title = (sim.ROOT / c['id'] / 'index.md').read_text().splitlines()[0].split(': ', 1)[-1]
        rows.append({'id': c['id'], 'title': title, 'pts': pts})
    data['cats'].append({'name': name, 'rows': rows})

html = (Path(__file__).parent / 'viz_template.html').read_text().replace('/*DATA*/null', json.dumps(data))
out = Path(__file__).parent / 'webapp' / 'sim.html'
out.write_text(html)
print('wrote', out, f'{len(html) // 1024} KB')
