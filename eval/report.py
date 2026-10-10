#!/usr/bin/env python3
"""Build a self-contained review page for an agent run over the public example cases.

Usage: python3 eval/report.py --cases CASES_DIR --logs RUN/logs --out RUN/report.html

Reads each case (index.md, history.md, attachments/) and the agent trace RUN/logs/<id>.jsonl, and puts the
agent's decision next to what the broker actually did at the same point. The decision point is taken from the
trace itself (the loader note left by `agent run --cut-at-event`); a case run on its full history has no
"broker actually did" side.
"""
import argparse, base64, json, re
from pathlib import Path

HERE = Path(__file__).resolve().parent
EMBED_MAX_BYTES = 200_000  # small document scans are embedded; large photos are listed by name only
CATS = [("Quote", {1, 2, 3, 4, 5, 10}), ("Policy docs", range(6, 10)), ("Renewal", range(11, 15)),
        ("Mid-term change", range(15, 21)), ("Billing", range(21, 29)), ("FNOL", range(29, 37)),
        ("Claim in progress", range(37, 45)), ("Decision / payout", range(45, 48)), ("Third party / privacy", range(48, 51))]
STAGING = {'send_message', 'create_internal_note', 'escalate_to_human', 'no_action'}


def sections(md):
    return {m[0].strip(): m[1].strip() for m in re.findall(r"^## (.+?)\n(.*?)(?=^## |\Z)", md, re.M | re.S)}


def parse_case(d):
    idx, hist = (d / 'index.md').read_text(), (d / 'history.md').read_text()
    s = sections(idx)
    det = dict(re.findall(r"^- \*\*(.+?):\*\* (.*)$", s.get('Case details', ''), re.M))
    events = []
    for chunk in re.split(r'<a id="event-\d+"></a>', hist)[1:]:
        head = re.search(r"^## (.+?) — event (\d+)", chunk, re.M)
        meta = dict(re.findall(r"^- \*\*(Channel|From|To):\*\* (.*)$", chunk, re.M))
        body = re.sub(r"^## .*\n|^- \*\*(Channel|From|To):\*\*.*\n", "", chunk.strip() + "\n", flags=re.M).strip()
        events.append({'n': int(head[2]), 'ts': head[1], 'ch': meta.get('Channel', ''), 'from': meta.get('From', ''),
                       'to': meta.get('To', ''), 'body': body})
    # broker detection: org name in From, or the handler's first name. Based on research/insurance-sim/sim.py, but the
    # handler is taken from "Name, Org" / "Name at Org" parties first; event 1 is only a fallback when that finds nobody.
    broker = det.get('Broker', '')
    org = (re.search(r"([A-Z][a-z]+ (?:Cover|Risk|Brokers|Insurance))", broker) or [None, broker])[1]
    names = {w for w in re.findall(r'\b[A-Z][a-z]+\b', broker) if w not in org.split()}
    for e in events:
        for party in (e['from'], e['to']):
            head = party.split()
            if org and org in party and head and head[0].strip(',') not in org.split():
                names.add(head[0].strip(','))

    def by_broker(frm):
        head = frm.split(',')[0].split()
        return bool(org and org in frm) or bool(head and head[0] in names)
    if events and not any(by_broker(e['from']) for e in events):
        first, to = events[0]['from'].split(',')[0].split(), events[0]['to'].split(',')[0].split()
        if len(first) == 1:    # a bare first name opening the file is the handler's own note
            names.add(first[0])
        elif to:
            names.add(to[0])
    for e in events:
        e['broker'] = by_broker(e['from'])
    # the customer is the most frequent party that is neither the broker nor the insurer nor a file/record
    ins = (det.get('Insurer', '').split() or ['\0'])[0]
    tally = {}
    for e in events:
        for party in (e['from'], e['to']):
            name = party.split(',')[0].strip()
            if name and not by_broker(party) and ins not in party and not re.search(r'record|file|team', party, re.I):
                tally[name] = tally.get(name, 0) + 1
    customer = max(tally, key=tally.get) if tally else ''
    num = int(d.name) if d.name.isdigit() else 0
    title = re.search(r"^# Case \d+: (.+)$", idx, re.M)
    return {'id': d.name, 'title': title[1].strip() if title else d.name,
            'cat': next((c for c, r in CATS if num in r), ''), 'details': det, 'org': org, 'customer': customer,
            'initial': s.get('Initial request', ''), 'overview': s.get('Overview', ''),
            'next': s.get('Next action at escalation', ''), 'outcome': s.get('Outcome', ''), 'events': events}


def gold_role(case, e):
    """Which party the broker's real step was addressed to (coarse)."""
    to, ins = e['to'], (case['details'].get('Insurer', '').split() or ['\0'])[0]
    if e['ch'].lower() == 'note' or not to:
        return 'note'
    if case['org'] and case['org'] in to:
        return 'internal'
    if ins in to:
        return 'insurer'
    if case['customer'] and case['customer'] in to:
        return 'customer'
    return 'other'


EXTERNAL = {'customer', 'insurer', 'third_party', 'contractor', 'other'}


def same_addressee(gold, roles):
    """Coarse: did the agent address the party the broker addressed? A broker file note matches only if the agent
    contacted nobody outside the firm either."""
    roles = set(roles)
    if gold in ('note', 'internal'):
        return not roles & EXTERNAL
    return bool(roles & ({'third_party', 'contractor', 'other'} if gold == 'other' else {gold}))


def parse_trace(path):
    """Rebuild the agent's staged/committed actions and final decision from its JSONL trace."""
    a = {'decision': 'failed', 'actions': [], 'calls': [], 'notes': [], 'files': [], 'cut': None, 'turns': 0,
         'cost': 0, 'duration': 0, 'error': None, 'stopped': None, 'final': None}
    if not path.exists():
        a['error'] = 'no trace file'
        return a
    pending = []
    for line in path.read_text().splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        t = e.get('type')
        if t == 'case_loaded':
            a['files'], a['notes'] = e.get('files', []), e.get('notes', [])
            m = re.search(r'cut after event (\d+)', ' '.join(a['notes']))
            a['cut'] = int(m[1]) if m else None
        elif t == 'model_call':
            pending = list(e.get('tool_calls', []))
        elif t == 'tool_result' and pending:
            c = pending.pop(0)
            name, inp, res, err = c['name'], c.get('input') or {}, e.get('result', ''), bool(e.get('is_error'))
            a['calls'].append({'tool': name, 'input': json.dumps(inp, ensure_ascii=False)[:600], 'result': res[:400], 'err': err})
            if err:
                continue
            if name in STAGING:
                a['actions'].append({'id': f"A{len(a['actions']) + 1}", 'tool': name, 'input': inp, 'status': 'staged'})
            elif name == 'cancel_action':
                for x in a['actions']:
                    if x['id'] == inp.get('action_id'):
                        x['status'], x['cancel_reason'] = 'cancelled', inp.get('reason', '')
            elif name == 'finish' and res.startswith('committed'):
                a['final'] = inp
                for x in a['actions']:
                    if x['status'] == 'staged':
                        x['status'] = 'committed'
        elif t == 'error':
            a['error'] = e.get('error')
        elif t == 'summary':
            for k, src in (('turns', 'turns'), ('cost', 'cost_usd'), ('duration', 'duration_s'), ('error', 'error'), ('stopped', 'stopped')):
                a[k] = e.get(src) if e.get(src) is not None else a[k]
    f = a.pop('final') or {}
    if f:
        a['decision'] = f.get('decision_type', 'failed')
    a.update({'confidence': f.get('confidence'), 'situation': f.get('situation', ''), 'key_facts': f.get('key_facts', []),
              'issues': f.get('issues_detected', []), 'options': f.get('options_considered', []),
              'rationale': f.get('rationale', ''), 'open_risks': f.get('open_risks', [])})
    roles = set()
    for x in a['actions']:
        if x['status'] != 'committed':
            continue
        roles.add({'send_message': x['input'].get('recipient_role', 'other'), 'create_internal_note': 'note',
                   'escalate_to_human': 'escalation', 'no_action': 'none'}[x['tool']])
    a['roles'] = sorted(roles)
    return a


def attachments(d, agent):
    out = []
    seen, withheld = ' '.join(agent['files']), ' '.join(n for n in agent['notes'] if 'withheld' in n)
    for p in sorted((d / 'attachments').glob('*')) if (d / 'attachments').is_dir() else []:
        item = {'name': p.name, 'shown': p.name in seen and p.name not in withheld, 'kb': round(p.stat().st_size / 1024)}
        if p.suffix.lower() == '.png' and p.stat().st_size <= EMBED_MAX_BYTES:
            item['src'] = 'data:image/png;base64,' + base64.b64encode(p.read_bytes()).decode()
        out.append(item)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cases', required=True)
    ap.add_argument('--logs', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--track', default='Insurance Claims Processing')
    a = ap.parse_args()
    logs = Path(a.logs)
    cases = []
    for d in sorted(p for p in Path(a.cases).iterdir() if (p / 'index.md').exists() and (logs / f'{p.name}.jsonl').exists()):
        c = parse_case(d)
        agent = parse_trace(logs / f'{d.name}.jsonl')
        cut = agent.pop('cut')
        c['cut'] = cut if cut is not None and cut < len(c['events']) else None
        c['gold_role'] = c['same'] = None
        if c['cut'] is not None:
            c['gold_role'] = gold_role(c, c['events'][c['cut']])
            if agent['decision'] != 'failed':
                c['same'] = same_addressee(c['gold_role'], agent['roles'])
        c['att'] = attachments(d, agent)
        c['agent'] = agent
        cases.append(c)
    try:
        run = json.loads((logs / 'run_summary.json').read_text())
        run.pop('rows', None)
    except (OSError, ValueError):
        run = {}
    run['track'] = a.track
    data = json.dumps({'run': run, 'cases': cases}, ensure_ascii=False).replace('</', '<\\/')
    html = (HERE / 'report_template.html').read_text().replace('/*__DATA__*/', data)
    Path(a.out).write_text(html)
    print(f'{len(cases)} cases -> {a.out} ({len(html) // 1024} KB)')


if __name__ == '__main__':
    main()
