"""Live phone-line demo: the caller speaks -> ElevenLabs Scribe transcript -> new Call event on the case ->
the core broker agent decides (act / ask / escalate / no action) -> the reply to the caller is spoken with ElevenLabs TTS.

    python -m agent.voice_demo [--case <case folder>] [--port 8777] [--model claude-sonnet-5]

Without --case a small built-in policyholder file is used. Traces go to logs/voice_demo/<call>.jsonl.
"""
import argparse
import base64
import json
import mimetypes
import threading
import time
from functools import lru_cache
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import load_dotenv

from . import llm, voice
from .agent import safe_run
from .loader import load_case

HTML = Path(__file__).with_name('voice_demo.html')

DEMO_CASE = """===== FILE: index.md =====
# Case V01: Policyholder on the phone line

## Case details

- **Source role:** Property owner / policyholder
- **Created:** 2025-06-02 09:00:00 UTC
- **Property:** 27 Larch Close, Brackenford, ZZ4 2ZZ
- **Policyholder:** Priya Shah (lives at the property with two children)
- **Broker:** Oakmere Cover — Ava
- **Insurer:** Northmere Mutual, home buildings and contents policy NM-HH-448213, renewed 1 March 2025

===== FILE: history.md =====
# Case V01 history

<a id="event-001"></a>
## 2025-03-01 10:00:00 UTC — event 001

- **Channel:** Note
- **From:** Ava, Oakmere Cover
- **To:** Oakmere Cover case record

Renewal of Northmere Mutual policy NM-HH-448213 for Priya Shah, 27 Larch Close, confirmed. No open claims.
"""

LIVE_NOTE = ('LIVE PHONE CALL: the caller is on the line now; the last event(s) are speech-to-text transcripts (ElevenLabs '
             'Scribe, may contain recognition errors; the caller\'s identity is not verified). Whatever you send to the '
             'caller with send_message (recipient_role customer, channel phone_call) is spoken to them immediately: keep it '
             'short spoken English, no lists, no markdown. Urgent safety advice must be given now, not held for approval; set '
             'needs_human_approval only for content that must not be said without a human, which will not be spoken.')
ACK_LINE = 'Thanks, bear with me a moment while I check your policy file.'
HOLDING_LINE = 'Thank you. I have passed this to a colleague who will review it and come back to you.'


class Call:
    """One phone call: the case file plus the call's turns so far."""

    def __init__(self, case_dir):
        if case_dir:
            self.case = load_case(case_dir)
        else:
            self.case = {'id': 'V01', 'files': ['index.md', 'history.md'], 'notes': [], 'text': DEMO_CASE, 'blocks': []}
        self.base_text = self.case['text']
        self.turns = []  # (who, text)
        self.id = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
        self.lock = threading.Lock()

    def case_with_call(self):
        now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
        events = [f'<a id="event-live-{i}"></a>\n## {now} — live call, turn {i}\n\n- **Channel:** Call\n'
                  f'- **From:** {"Caller (phone line; identity not verified)" if who == "caller" else "Broker voice agent"}\n'
                  f'- **Source:** {"live audio, transcribed by ElevenLabs Scribe" if who == "caller" else "spoken reply"}\n\n{text}\n'
                  for i, (who, text) in enumerate(self.turns, 1)]
        return {**self.case, 'text': self.base_text + '\n\n===== FILE: live_call.md =====\n' + '\n'.join(events),
                'files': self.case['files'] + ['live_call.md (live call transcript)'], 'notes': self.case['notes'] + [LIVE_NOTE]}


def summarise(env, meta):
    acts = [a for a in env.actions if a['status'] == ('committed' if env.final else 'staged')]
    out = []
    for a in acts:
        i = a['input']
        if a['tool'] == 'send_message':
            out.append({'kind': 'message', 'to': i.get('to'), 'role': i.get('recipient_role'), 'channel': i.get('channel'),
                        'body': i.get('body'), 'approval': bool(i.get('needs_human_approval'))})
        elif a['tool'] == 'escalate_to_human':
            out.append({'kind': 'escalation', 'urgency': i.get('urgency'), 'route_to': i.get('route_to'),
                        'reason': i.get('reason'), 'body': i.get('handover_summary'), 'open': i.get('open_questions')})
        elif a['tool'] == 'create_internal_note':
            out.append({'kind': 'note', 'body': i.get('text')})
        elif a['tool'] == 'no_action':
            out.append({'kind': 'no_action', 'body': i.get('reason'), 'next': i.get('next_trigger')})
    f = env.final or {}
    return {'decision': f.get('decision_type') or ('escalate (agent did not finish)' if meta.get('error') or meta.get('stopped') else None),
            'situation': f.get('situation'), 'rationale': f.get('rationale'), 'issues': f.get('issues_detected') or [],
            'confidence': f.get('confidence'), 'actions': out, 'error': meta.get('error') or meta.get('stopped'),
            'cost_usd': meta.get('cost_usd'), 'duration_s': meta.get('duration_s')}


def spoken_reply(result):
    """What the caller hears: the agent's phone message to them, else a holding line if a human now has it."""
    to_caller = [a for a in result['actions'] if a['kind'] == 'message' and a['role'] == 'customer']
    say = next((a for a in to_caller if a['channel'] == 'phone_call' and not a['approval']), None) or \
        next((a for a in to_caller if not a['approval']), None)
    if say:
        return say['body']
    if to_caller or any(a['kind'] == 'escalation' for a in result['actions']) or not result['decision']:
        return HOLDING_LINE
    return None


@lru_cache(maxsize=1)
def ack_audio():
    return base64.b64encode(voice.speak_bytes(ACK_LINE)).decode()


def make_handler(state, args):
    client, prefix = llm.make_client()

    class H(BaseHTTPRequestHandler):
        def _send(self, code, body, ctype='application/json'):
            body = body if isinstance(body, bytes) else json.dumps(body, default=str).encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            return self.rfile.read(int(self.headers.get('Content-Length') or 0))

        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path == '/':
                return self._send(200, HTML.read_bytes(), 'text/html; charset=utf-8')
            if self.path == '/api/ack':  # filler line played while the agent decides, so the caller isn't left in silence
                try:
                    return self._send(200, {'text': ACK_LINE, 'audio': ack_audio()})
                except voice.VoiceUnavailable as e:
                    return self._send(503, {'error': str(e)})
            if self.path == '/api/case':
                c = state['call']
                return self._send(200, {'id': c.case['id'], 'text': c.base_text[:4000], 'turns': c.turns})
            self._send(404, {'error': 'not found'})

        def do_POST(self):
            try:
                if self.path == '/api/reset':
                    state['call'] = Call(args.case)
                    return self._send(200, {'ok': True})
                if self.path == '/api/transcribe':
                    data = self._body()
                    mime = (self.headers.get('Content-Type') or 'audio/webm').split(';')[0]
                    t0 = time.time()
                    text = voice.transcribe_bytes(data, 'call' + (mimetypes.guess_extension(mime) or '.webm'), mime)
                    return self._send(200, {'transcript': text, 'stt_s': round(time.time() - t0, 1)})
                if self.path == '/api/decide':
                    return self._send(200, decide(state['call'], json.loads(self._body())['transcript'], client, prefix, args))
                self._send(404, {'error': 'not found'})
            except voice.VoiceUnavailable as e:
                self._send(503, {'error': str(e)})
            except Exception as e:
                self._send(500, {'error': f'{type(e).__name__}: {e}'})

    return H


def decide(call, transcript, client, prefix, args):
    transcript = transcript.strip()
    if not transcript.startswith(('Caller:', 'Speaker', 'Broker:')):
        transcript = f'Caller: {transcript}'
    with call.lock:  # ponytail: one call at a time, it's a single-line demo
        call.turns.append(('caller', transcript))
        trace = Path(args.logs) / f'{call.id}.jsonl'
        trace.parent.mkdir(parents=True, exist_ok=True)
        with open(trace, 'a') as tf:
            def log(e):
                tf.write(json.dumps({'ts': datetime.now(timezone.utc).isoformat(timespec='seconds'), **e}, default=str) + '\n')
            log({'type': 'caller_turn', 'transcript': transcript})
            env, meta = safe_run(call.case_with_call(), client, prefix, args.model, args.thinking, log)
            result = summarise(env, meta)
            result['reply'] = spoken_reply(result)
            result['audio'] = None
            if result['reply']:
                call.turns.append(('broker', result['reply']))
                try:
                    result['audio'] = base64.b64encode(voice.speak_bytes(result['reply'])).decode()
                except voice.VoiceUnavailable as e:
                    result['tts_error'] = str(e)
            log({'type': 'voice_turn_result', **{k: v for k, v in result.items() if k != 'audio'}})
    result['trace'] = str(trace)
    return result


def main(argv=None):
    load_dotenv()
    ap = argparse.ArgumentParser(prog='agent.voice_demo')
    ap.add_argument('--case', help='case folder to take the call on (default: built-in demo policyholder)')
    ap.add_argument('--port', type=int, default=8777)
    ap.add_argument('--model', default='claude-sonnet-5')
    ap.add_argument('--thinking', action='store_true', help='adaptive thinking (slower, for harder calls)')
    ap.add_argument('--logs', default='logs/voice_demo')
    args = ap.parse_args(argv)
    state = {'call': Call(args.case)}
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(state, args))
    print(f'Voice line open: http://127.0.0.1:{args.port}  (case {state["call"].case["id"]}, model {args.model})', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
