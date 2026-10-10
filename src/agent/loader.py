"""Load a case (folder or single file) into text + content blocks. Tolerant: never raises on odd files."""
import base64
import re
from pathlib import Path

try:
    from . import voice  # ElevenLabs transcription of call recordings / voicemails
except ImportError:  # loader self-check runs as a plain script
    voice = None

TEXT_EXT = {'.md', '.txt', '.json', '.eml', '.csv', '.tsv', '.html', '.htm', '.xml', '.yaml', '.yml', '.log', ''}
IMAGE_EXT = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'}
MAX_TEXT_CHARS = 600_000      # total case text; ~150k tokens
MAX_BINARY_BYTES = 4_500_000  # API limit is 5MB per image; PDFs share the 32MB request limit
# Public example cases carry the answer in these index.md sections; the agent must not see them.
REVEALING = re.compile(r'^##\s+(Overview|Next action.*|Outcome|Resolution|Summary of outcome)\s*$', re.I)
REVEALING_FIELD = re.compile(r'^\s*-\s+\*\*(Status|Updated|Completed):\*\*', re.I)
EVENT_SPLIT = re.compile(r'(?=<a id="event-\d+"></a>)')
ATTACH_SECTION = re.compile(r'^## Attachments\s*$.*?(?=^#|^=====|\Z)', re.M | re.S)


def strip_revealing(text):
    """Drop answer-revealing sections/fields. Returns (text, removed_section_names)."""
    out, removed, skipping = [], [], False
    for line in text.splitlines():
        if line.startswith('## ') or line.startswith('# '):
            skipping = bool(REVEALING.match(line))
            if skipping:
                removed.append(line.strip('# ').strip())
        m = REVEALING_FIELD.match(line)
        if skipping or m:
            if m and not skipping:
                removed.append(m.group(1))
            continue
        out.append(line)
    return '\n'.join(out), removed


def cut_history(text, n):
    """Keep only the first n events of an event-anchored history (dev: replay a decision point)."""
    parts = EVENT_SPLIT.split(text)
    if len(parts) <= 1:
        return text
    return re.sub(r'Total events: \d+', f'Total events: {min(n, len(parts) - 1)}', ''.join(parts[:n + 1]))


def load_case(path, cut_at_event=None):
    """Returns dict(id, files, notes, text, blocks). `blocks` are API content blocks for images/PDFs."""
    path = Path(path)
    files = sorted(p for p in path.rglob('*') if p.is_file()) if path.is_dir() else [path]
    files = [p for p in files if not p.name.startswith('.')]
    root = path if path.is_dir() else path.parent
    case = {'id': path.name if path.is_dir() else path.stem, 'files': [], 'notes': [], 'text': '', 'blocks': []}
    texts = []
    for p in files:
        rel = str(p.relative_to(root))
        ext = p.suffix.lower()
        try:
            if ext in TEXT_EXT:
                t = p.read_text(errors='replace')
                if p.name.lower().startswith('index') or ext == '.md':
                    t, removed = strip_revealing(t)
                    if removed:
                        case['notes'].append(f'{rel}: hid answer-revealing sections/fields: {", ".join(removed)}')
                if cut_at_event and 'history' in p.name.lower():
                    t = cut_history(t, cut_at_event)
                    case['notes'].append(f'{rel}: dev replay, history cut after event {cut_at_event}')
                texts.append((rel, t))
                case['files'].append(f'{rel} (text, {len(t)} chars)')
            elif ext in IMAGE_EXT or ext == '.pdf':
                size = p.stat().st_size
                if size > MAX_BINARY_BYTES:
                    case['notes'].append(f'{rel}: skipped, {size} bytes exceeds the {MAX_BINARY_BYTES} byte limit')
                    case['files'].append(f'{rel} (binary, NOT READ: too large)')
                    continue
                case['files'].append(f'{rel} ({"pdf" if ext == ".pdf" else "image"}, {size} bytes)')
                case['_binaries'] = case.get('_binaries', []) + [(rel, p, ext)]
            elif voice and ext in voice.AUDIO_EXT:
                texts.append((rel, voice.event_text(voice.audio_to_event(p))))
                case['files'].append(f'{rel} (audio, transcribed)')
            else:
                case['notes'].append(f'{rel}: unsupported file type, not read')
                case['files'].append(f'{rel} (NOT READ: unsupported type)')
        except Exception as e:  # unreadable file must not kill the case
            case['notes'].append(f'{rel}: failed to read ({e})')
            case['files'].append(f'{rel} (NOT READ: error)')

    # history first-class after index; everything else in name order
    texts.sort(key=lambda t: (0 if t[0].lower().startswith('index') else 1 if 'history' in t[0].lower() else 2, t[0]))
    body = '\n\n'.join(f'===== FILE: {rel} =====\n{t.strip()}' for rel, t in texts)
    if len(body) > MAX_TEXT_CHARS:
        case['notes'].append(f'case text truncated from {len(body)} to {MAX_TEXT_CHARS} chars')
        body = body[:MAX_TEXT_CHARS] + '\n[... TRUNCATED BY LOADER ...]'
    case['text'] = body

    # in dev replay, only show attachments already mentioned in the kept text (no peeking ahead); the index's own
    # "## Attachments" listing names every file of the finished case, so it does not count as a mention
    seen = ATTACH_SECTION.sub('', body)
    withheld = []
    for rel, p, ext in case.pop('_binaries', []):
        if cut_at_event and p.name not in seen:  # withheld, and its name hidden too (as if it had not arrived yet)
            withheld.append(p.name)
            case['files'] = [f for f in case['files'] if not f.startswith(rel + ' ')]
            case['text'] = '\n'.join(l for l in case['text'].splitlines() if not (l.lstrip().startswith('-') and p.name in l))
            continue
        data = base64.b64encode(p.read_bytes()).decode()
        if ext == '.pdf':
            case['blocks'].append({'type': 'document', 'source': {'type': 'base64', 'media_type': 'application/pdf', 'data': data}})
        else:
            case['blocks'].append({'type': 'image', 'source': {'type': 'base64', 'media_type': IMAGE_EXT[ext], 'data': data}})
        case['blocks'].append({'type': 'text', 'text': f'(attachment above: {rel})'})
    if withheld:
        case['notes'].append(f'dev replay: {len(withheld)} attachment(s) not yet referenced in the kept history withheld')
    if not texts and not case['blocks']:
        case['notes'].append('no readable content found in case')
    return case


def discover(cases_dir):
    """Case folders (any name) plus loose top-level files; a folder holding index.md directly is one case."""
    d = Path(cases_dir)
    if d.is_file():
        return [d]
    if (d / 'index.md').exists() or (d / 'history.md').exists():
        return [d]
    items = [p for p in sorted(d.iterdir()) if not p.name.startswith(('.', '_')) and p.name.lower() != 'readme.md']
    return items


if __name__ == '__main__':  # self-check
    t, rm = strip_revealing('# C\n## Case details\n- **Status:** Completed\n- **Property:** X\n## Overview\nanswer\n## Outcome\nx\n## History\nlink')
    assert 'answer' not in t and 'Property' in t and 'Completed' not in t and '## History' in t, t
    assert rm == ['Status', 'Overview', 'Outcome'], rm
    h = 'head\n<a id="event-001"></a>\none\n<a id="event-002"></a>\ntwo'
    assert cut_history(h, 1) == 'head\n<a id="event-001"></a>\none\n', repr(cut_history(h, 1))
    assert 'x.png' not in ATTACH_SECTION.sub('', '## Initial request\nhi\n## Attachments\n- [x.png](a/x.png)\n\n===== FILE: h =====\nev')
    print('ok')
