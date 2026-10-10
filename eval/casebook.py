#!/usr/bin/env python3
"""Build the escalation casebook: every public case's correspondence with its attachments and the escalation point.

Usage: python3 eval/casebook.py --cases CASES_DIR --out OUT_DIR [--points eval/public_escalation_points.json]

Writes OUT_DIR/index.html plus OUT_DIR/att/<case>/<file> (images copied, PDFs rendered to a PNG of page 1).
The escalation point of a case comes from eval/public_escalation_points.json, the same file the backtest
(eval/public.py) and Case Lab use: the agent sees every event up to `esc_after` and nothing after it. An attachment
counts as seen only if an event above the line mentions its file name.
"""
import argparse, json, shutil, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from report import parse_case  # noqa: E402


def role(e, case):
    if e['ch'].lower() == 'note':
        return 'note'
    if e['broker']:
        return 'broker'
    ins = (case['details'].get('Insurer', '').split() or ['\0'])[0]
    if ins in e['from']:
        return 'insurer'
    if case['customer'] and e['from'].startswith(case['customer']):
        return 'customer'
    return 'other'


def pdf_preview(src, dst):
    """Render page 1 of a PDF to PNG. PyMuPDF if installed, else macOS Quick Look; False if neither works."""
    try:
        import fitz
        fitz.open(src)[0].get_pixmap(dpi=130).save(dst)
        return True
    except Exception:
        pass
    try:
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['qlmanage', '-t', '-s', '1700', '-o', tmp, str(src)], check=True, capture_output=True, timeout=60)
            shutil.move(str(Path(tmp) / (src.name + '.png')), dst)
        return True
    except Exception:
        return False


def attachments(d, case, out):
    items = []
    for p in sorted((d / 'attachments').glob('*')) if (d / 'attachments').is_dir() else []:
        mentions = [e['n'] for e in case['events'] if p.name in e['body']]
        item = {'name': p.name, 'kind': 'pdf' if p.suffix.lower() == '.pdf' else 'image', 'kb': round(p.stat().st_size / 1024),
                'first': mentions[0] if mentions else None, 'mentions': mentions, 'src': None}
        dst = out / 'att' / case['id']
        dst.mkdir(parents=True, exist_ok=True)
        if item['kind'] == 'image':
            shutil.copyfile(p, dst / p.name)
            item['src'] = f"att/{case['id']}/{p.name}"
        elif pdf_preview(p, dst / (p.name + '.png')):
            item['src'] = f"att/{case['id']}/{p.name}.png"
        items.append(item)
    return items


def load_points(path):
    """{case id: {step, covers, confidence, why}}. Reads the repo's list format ({case, esc_after, trigger,
    action_events}) or a map already in that shape."""
    raw = json.loads(Path(path).read_text())
    if isinstance(raw, dict):
        return raw
    out = {}
    for p in raw:
        step = p['esc_after'] + 1
        lo, _, hi = str(p.get('action_events') or step).partition('-')
        out[p['case']] = {'step': step, 'covers': list(range(int(lo), int(hi or lo) + 1)), 'confidence': None,
                          'why': p.get('trigger', '')}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cases', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--points', default=str(HERE / 'public_escalation_points.json'))
    ap.add_argument('--track', default='Insurance Claims Processing')
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    points = load_points(a.points)
    cases = []
    for d in sorted(p for p in Path(a.cases).iterdir() if (p / 'index.md').exists()):
        c = parse_case(d)
        for e in c['events']:
            e['role'] = role(e, c)
        c['att'] = attachments(d, c, out)
        esc = dict(points.get(c['id']) or {'step': None, 'covers': [], 'confidence': None, 'why': 'not located'})
        if esc.get('step'):
            # the broker's own notes/messages right above the line are visible to the agent and may state the plan
            k = esc['step'] - 1
            while k > 0 and c['events'][k - 1]['broker']:
                k -= 1
            esc['turn_start'] = k + 1
            # an action range can span the other side's replies; only the broker's own events carry the action out
            esc['covers'] = [n for n in esc.get('covers', []) if n == esc['step'] or (0 < n <= len(c['events']) and c['events'][n - 1]['broker'])]
        c['esc'] = esc
        c.pop('org', None)
        cases.append(c)
    data = json.dumps({'track': a.track, 'cases': cases}, ensure_ascii=False).replace('</', '<\\/')
    html = (HERE / 'casebook_template.html').read_text().replace('/*__DATA__*/', data)
    (out / 'index.html').write_text(html)
    files = sorted(str(p.relative_to(out)) for p in (out / 'att').rglob('*') if p.is_file())
    print(f"{len(cases)} cases -> {out / 'index.html'} ({len(html) // 1024} KB), {len(files)} attachment files")
    missing = [f"{c['id']}/{t['name']}" for c in cases for t in c['att'] if not t['src']]
    if missing:
        print('no preview for:', ', '.join(missing))


if __name__ == '__main__':
    main()
