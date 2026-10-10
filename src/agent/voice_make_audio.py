"""Make audio test cases: copy case folders, turn their first Call event into a voicemail mp3 (ElevenLabs TTS) and
replace that event's text with a pointer to the recording, so ingestion has to go through speech-to-text.

    python -m agent.voice_make_audio <cases_dir> <out_dir> 006 016 022
"""
import re
import shutil
import sys
from pathlib import Path

from . import voice

CALLER_VOICE = 'Xb7hH8MSUJpSbSDYk0k2'  # "Alice", British English, distinct from the broker voice
CALL = re.compile(r'(- \*\*Channel:\*\* Call\n(?:- \*\*[^\n]*\n)*\n)(.+?)(?=\n<a id=|\Z)', re.S)


def make(case_dir, out_dir):
    hist = (case_dir / 'history.md').read_text()
    m = CALL.search(hist)
    if not m:
        return None
    dst = out_dir / case_dir.name
    shutil.copytree(case_dir, dst, dirs_exist_ok=True)
    voice.speak(m.group(2).strip(), dst / 'call_recording.mp3', CALLER_VOICE)
    (dst / 'history.md').write_text(hist[:m.start(2)] + '[Call recorded: call_recording.mp3]\n' + hist[m.end(2):])
    return dst


if __name__ == '__main__':
    src, out, ids = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]
    for cid in ids:
        print(cid, make(src / cid, out) or 'no Call event')
