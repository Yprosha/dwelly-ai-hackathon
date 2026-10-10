#!/usr/bin/env python3
"""Copy eval cases to a clean agent-input directory, dropping grader-only files (rubric.json).

Usage: python3 eval/prepare.py --out /tmp/rt_input [--cases eval/cases]
"""
import argparse, shutil
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--cases", default=str(Path(__file__).resolve().parent / "cases"))
a = ap.parse_args()
out = Path(a.out)
if out.exists():  # only wipe a previous prepare.py output, never an arbitrary directory
    assert all((p / "index.md").exists() for p in out.iterdir()), f"{out} exists and is not a previous case dir; refusing to delete"
    shutil.rmtree(out)
shutil.copytree(a.cases, out, ignore=shutil.ignore_patterns("rubric.json", ".*"))
leaked = list(out.rglob("rubric.json"))
assert not leaked, leaked
print(f"{len([p for p in out.iterdir() if p.is_dir()])} cases -> {out}")
