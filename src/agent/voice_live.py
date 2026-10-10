"""Real-time claims line: ElevenLabs Agents does the conversation (ASR + LLM + TTS, turn-taking, barge-in) in the
browser; this server only mints signed URLs and answers the agent's client tools. The core broker agent runs in a
background thread after log_claim, so it never blocks the call.

    python -m agent.voice_agent_setup              # once: create/update the ElevenLabs agent, stores ELEVENLABS_AGENT_ID
    python -m agent.voice_live [--case <case folder>] [--port 8778]

Traces go to logs/voice_live/<ref>.jsonl.
"""
import argparse
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import load_dotenv

from . import llm
from .agent import safe_run
from .loader import load_case
from .voice_demo import DEMO_CASE, summarise

HTML = Path(__file__).with_name('voice_live.html')
CLAIMS = {}  # ref -> {'status', 'fields', 'escalations', 'result'}; ponytail: in-memory, a restart forgets claims


def signed_url():
    q = urllib.parse.urlencode({'agent_id': os.environ['ELEVENLABS_AGENT_ID']})
    req = urllib.request.Request(f'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?{q}',
                                 headers={'xi-api-key': os.environ['ELEVENLABS_API_KEY']})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)['signed_url']


def lookup_policy(case, query):
    """Instant fixture lookup: the case's detail bullets, if the name/address the caller gave matches them."""
    head = case['text'].split('===== FILE: history')[0]
    details = [ln for ln in head.splitlines() if re.match(r'- \*\*(Property|Policyholder|Insurer|Policy|Landlord|Tenant)', ln)]
    words = {w for w in re.findall(r'[a-z0-9]{3,}', query.lower())} - {'the', 'and', 'road', 'street', 'close', 'lane', 'flat'}
    hits = [ln for ln in details if any(w in ln.lower() for w in words)]
    if not hits:
        return 'No matching policy found on file. Take the details and log the claim; a handler will match it.'
    return ('Match on file (internal; do not read policy details to an unverified caller):\n' + '\n'.join(details)
            + '\nMatched on: ' + '; '.join(h.split('**')[1] for h in hits if '**' in h))


def case_with_call(case, ref, fields, transcript, escalations):
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    lines = '\n'.join(f"{'Caller' if t.get('role') == 'user' else 'Redline (voice agent)'}: {t.get('text', '')}" for t in transcript)
    esc = ''.join(f"\nVoice agent requested a human: {e.get('reason')} (urgency {e.get('urgency')})." for e in escalations)
    event = (f'<a id="event-live-1"></a>\n## {now} — event live-1\n\n- **Channel:** Call\n'
             '- **From:** Caller (phone line; identity not verified)\n- **To:** Fenwick & Dale claims line (Redline voice agent)\n'
             '- **Source:** live call, automatic transcript (ElevenLabs Agents speech recognition)\n\n'
             f'Voice agent logged first notice of loss {ref}: {json.dumps(fields, ensure_ascii=False)}{esc}\n\n{lines}\n')
    note = (f'The last event is an automatic transcript of a phone call handled by the Redline voice agent (may contain '
            f'recognition errors; caller identity not verified). The caller was given reference {ref} and told a claims '
            'handler will review it. Nothing you send is spoken on the call; messages go out after it.')
    return {**case, 'text': case['text'] + '\n\n===== FILE: live_call.md =====\n' + event,
            'files': case['files'] + ['live_call.md (live call transcript)'], 'notes': case['notes'] + [note]}


def run_deep_agent(ref, case, args):
    c = CLAIMS[ref]
    trace = Path(args.logs) / f'{ref}.jsonl'
    trace.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    with open(trace, 'w') as tf:
        def log(e):
            tf.write(json.dumps({'ts': datetime.now(timezone.utc).isoformat(timespec='seconds'), **e}, default=str) + '\n')
            tf.flush()
        try:
            client, prefix = llm.make_client()
            env, meta = safe_run(case_with_call(case, ref, c['fields'], c['transcript'], c['escalations']),
                                 client, prefix, args.model, False, log)
            c['result'] = summarise(env, meta)
        except BaseException as e:  # make_client raises SystemExit when no Claude credentials
            c['result'] = {'decision': None, 'error': f'{type(e).__name__}: {e}', 'actions': []}
        log({'type': 'voice_live_result', 'ref': ref, **c['result']})
    c['result']['wall_s'] = round(time.time() - t0, 1)
    c['status'] = 'done'


def make_handler(case, args):
    class H(BaseHTTPRequestHandler):
        def _send(self, code, body, ctype='application/json'):
            body = body if isinstance(body, bytes) else json.dumps(body, default=str).encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path == '/':
                return self._send(200, HTML.read_bytes(), 'text/html; charset=utf-8')
            if self.path == '/api/signed-url':
                try:
                    return self._send(200, {'signed_url': signed_url()})
                except KeyError as e:
                    return self._send(503, {'error': f'{e.args[0]} not set; run python -m agent.voice_agent_setup'})
                except urllib.error.HTTPError as e:
                    return self._send(502, {'error': f'ElevenLabs HTTP {e.code}: {e.read().decode()[:500]}'})
            m = re.fullmatch(r'/api/claim/(CLM-\d+)', self.path)
            if m and m[1] in CLAIMS:
                c = CLAIMS[m[1]]
                return self._send(200, {'ref': m[1], 'status': c['status'], 'elapsed_s': round(time.time() - c['t0'], 1),
                                        'result': c['result']})
            self._send(404, {'error': 'not found'})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
            if self.path == '/api/policy':
                return self._send(200, {'result': lookup_policy(case, str(body.get('name_or_address', '')))})
            if self.path == '/api/claim':
                ref = f'CLM-{secrets.randbelow(900000) + 100000}'
                CLAIMS[ref] = {'status': 'running', 't0': time.time(), 'fields': body.get('fields') or {},
                               'transcript': body.get('transcript') or [], 'escalations': body.get('escalations') or [],
                               'result': None}
                threading.Thread(target=run_deep_agent, args=(ref, case, args), daemon=True).start()
                return self._send(200, {'ref': ref})
            if self.path == '/api/escalate':
                print(f"ESCALATION [{body.get('urgency')}]: {body.get('reason')}", flush=True)
                return self._send(200, {'ok': True})
            self._send(404, {'error': 'not found'})

    return H


def main(argv=None):
    load_dotenv('.env')
    ap = argparse.ArgumentParser(prog='agent.voice_live')
    ap.add_argument('--case', help='case folder the policy lookup and deep agent use (default: built-in demo policyholder)')
    ap.add_argument('--port', type=int, default=8778)
    ap.add_argument('--model', default='claude-sonnet-5', help='model for the background deep agent')
    ap.add_argument('--logs', default='logs/voice_live')
    args = ap.parse_args(argv)
    case = load_case(args.case) if args.case else {'id': 'V01', 'files': ['index.md', 'history.md'], 'notes': [],
                                                    'text': DEMO_CASE.replace('Oakmere Cover', 'Fenwick & Dale'), 'blocks': []}
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(case, args))
    print(f'Live claims line: http://127.0.0.1:{args.port}  (case {case["id"]}, deep agent {args.model})', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
