#!/usr/bin/env python3
"""Bake every public case (all four tracks) into one self-contained index.html next to this script."""
import json
import os
import pathlib
import re
from urllib.parse import quote

HERE = pathlib.Path(__file__).parent
# folder holding the four track folders of the public cases (repo convention: data/public-cases)
ROOT = pathlib.Path(os.environ.get("PUBLIC_CASES_DIR", HERE.parents[1] / "data" / "public-cases"))
GH = "https://github.com/DwellyOrg/HackatonPublicCases/blob/main/"
SKIP = {"Case details", "Initial request", "Context", "History", "Attachments"}


def sections(md):
    parts = re.split(r"^## (.+)$", md, flags=re.M)
    return {h.strip(): b.strip() for h, b in zip(parts[1::2], parts[2::2])}


def fields(block):
    return dict(re.findall(r"^- \*\*(.+?):\*\* ?(.*)$", block, flags=re.M))


def events(md):
    out = []
    for chunk in re.split(r'<a id="event-\d+"></a>', md)[1:]:
        head, _, rest = chunk.strip().partition("\n")
        lines = rest.strip().split("\n")
        n = next((i for i, l in enumerate(lines) if not l.startswith("- **")), len(lines))
        meta = {k.lower(): v for k, v in fields("\n".join(lines[:n])).items()}
        ts, num = re.match(r"## (\S+ \S+) UTC — event (\d+)", head).groups()
        out.append({"ts": ts, "n": num, **meta, "body": "\n".join(lines[n:]).strip()})
    return out


def case(d):
    idx = (d / "index.md").read_text()
    sec = sections(idx)
    att = sorted((d / "attachments").glob("*")) if (d / "attachments").is_dir() else []
    return {
        "track": d.parent.name,
        "id": d.name,
        "title": re.search(r"^# Case \d+: (.+)$", idx, re.M).group(1),
        "details": fields(sec.get("Case details", "")),
        "request": sec.get("Initial request", ""),
        "context": sec.get("Context", ""),
        "key": {h: b for h, b in sec.items() if h not in SKIP},  # spoilers: overview, next action, outcome
        "events": events((d / "history.md").read_text()),
        "attachments": [{"name": a.name, "url": GH + quote(str(a.relative_to(ROOT)))} for a in att],
    }


cases = [case(d) for d in sorted(ROOT.glob("*/[0-9]*")) if d.is_dir()]
assert cases and all(c["events"] for c in cases), f"no cases parsed from {ROOT}"
data = json.dumps(cases, ensure_ascii=False).replace("</", "<\\/")
html = (HERE / "template.html").read_text().replace("/*DATA*/[]", data)
(HERE / "index.html").write_text(html)
print(f"{len(cases)} cases, {sum(len(c['events']) for c in cases)} events -> {HERE / 'index.html'} ({len(html) // 1024} KB)")
