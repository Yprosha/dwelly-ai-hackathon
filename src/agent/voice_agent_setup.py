"""Create or update the ElevenLabs Agents (Conversational AI) voice agent for the live claims line. Idempotent.

    python -m agent.voice_agent_setup        # prints the agent_id and stores it in .env as ELEVENLABS_AGENT_ID

Lookup order: ELEVENLABS_AGENT_ID from .env, then an existing agent with the same name, else create a new one.
"""
import json
import os
import urllib.error
import urllib.request

from dotenv import load_dotenv, set_key

from .voice import VOICE_ID

API = 'https://api.elevenlabs.io/v1/convai'
NAME = 'Redline - Fenwick & Dale claims line'
LLM = os.environ.get('ELEVENLABS_AGENT_LLM', 'claude-haiku-4-5')
TTS_MODEL = os.environ.get('ELEVENLABS_AGENT_TTS_MODEL', 'eleven_flash_v2')  # lowest-latency English TTS
FIRST_MESSAGE = "Fenwick & Dale claims line, this is Redline. What's happened?"

PROMPT = """You are Redline, the voice on Fenwick & Dale's first-notice-of-loss line. Fenwick & Dale is an insurance broker; \
callers are policyholders, tenants or agents reporting damage to a property. You are on a live phone call.

Collect, one question at a time: who is calling, the property address, what happened, when, and whether it is still happening.

SAFETY FIRST, before anything else:
- Gas smell: stop using appliances and switches, open windows, and if it is strong leave and call the gas emergency line on 0800 111 999.
- Water near electrics: don't touch anything wet; switch off at the consumer unit only if it is dry and safe to reach.
- Structural danger (cracks, sagging ceiling, collapse): keep everyone away from that area.

Rules:
- Never promise cover, payment, amounts or dates. Never take card or bank details. Never admit liability.
- Use lookup_policy to find the policy. Unverified callers get no policy details: do not read out policy numbers, \
cover or insurer details unless the caller has given the policyholder's name and the property address that match.
- When you have the core facts, call log_claim, then read the reference back to the caller and say a claims handler \
will review it. Do not wait for a decision.
- Call escalate_to_human for danger to people, a vulnerable caller, an angry or confused caller, a complaint, or \
anything you cannot handle; tell the caller a colleague will pick it up.
- Keep every reply to one or two short spoken sentences. British English. No lists, no markdown."""

TOOLS = [
    {'type': 'client', 'name': 'lookup_policy', 'expects_response': True, 'response_timeout_secs': 5,
     'description': "Find the caller's policy on the broker's file by policyholder name or property address. Instant.",
     'parameters': {'type': 'object', 'required': ['name_or_address'], 'properties': {
         'name_or_address': {'type': 'string', 'description': 'policyholder name and/or property address as given by the caller'}}}},
    {'type': 'client', 'name': 'log_claim', 'expects_response': True, 'response_timeout_secs': 5,
     'description': 'Log the first notice of loss once you know who, where, what, when and whether it is ongoing. '
                    'Returns a claim reference immediately; the claims team reviews it in the background.',
     'parameters': {'type': 'object', 'required': ['caller_name', 'property', 'what_happened'], 'properties': {
         'caller_name': {'type': 'string', 'description': "caller's name and relationship to the property"},
         'property': {'type': 'string', 'description': 'property address'},
         'what_happened': {'type': 'string', 'description': 'short description of the damage or incident'},
         'when': {'type': 'string', 'description': 'when it happened or was discovered'},
         'ongoing': {'type': 'string', 'description': 'whether it is still happening, e.g. yes / no / unknown'},
         'safety_advice_given': {'type': 'string', 'description': 'any safety advice you gave'}}}},
    {'type': 'client', 'name': 'escalate_to_human', 'expects_response': True, 'response_timeout_secs': 5,
     'description': 'Hand the call to a human claims handler. Instant acknowledgement.',
     'parameters': {'type': 'object', 'required': ['reason', 'urgency'], 'properties': {
         'reason': {'type': 'string', 'description': 'why a human is needed'},
         'urgency': {'type': 'string', 'enum': ['low', 'medium', 'high', 'emergency'], 'description': 'how urgent'}}}},
]

CONFIG = {
    'name': NAME,
    'conversation_config': {
        'agent': {'first_message': FIRST_MESSAGE, 'language': 'en',
                  'prompt': {'prompt': PROMPT, 'llm': LLM, 'temperature': 0.3, 'tools': TOOLS}},
        'tts': {'voice_id': VOICE_ID, 'model_id': TTS_MODEL},
        # eager = shortest end-of-turn wait; 'normal' if it cuts callers off mid-sentence
        'turn': {'turn_eagerness': os.environ.get('ELEVENLABS_AGENT_TURN_EAGERNESS', 'eager'), 'speculative_turn': True},
        'conversation': {'client_events': ['audio', 'interruption', 'user_transcript', 'agent_response',
                                           'agent_response_correction', 'client_tool_call', 'vad_score']},
    },
    'platform_settings': {
        'auth': {'enable_auth': True},  # sessions only via signed URLs minted by our server
        'overrides': {'conversation_config_override': {'conversation': {'text_only': True}}},  # typed test mode
    },
}


def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={'xi-api-key': os.environ['ELEVENLABS_API_KEY'], 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f'ElevenLabs {method} {path} -> HTTP {e.code}: {e.read().decode()[:2000]}')


def find_agent():
    aid = os.environ.get('ELEVENLABS_AGENT_ID')
    if aid:
        return aid
    agents = api('GET', '/agents?page_size=100&search=' + urllib.request.quote(NAME))['agents']
    return next((a['agent_id'] for a in agents if a['name'] == NAME), None)


def main():
    load_dotenv('.env')
    aid = find_agent()
    if aid:
        api('PATCH', f'/agents/{aid}', CONFIG)
        print(f'updated {aid}')
    else:
        aid = api('POST', '/agents/create', CONFIG)['agent_id']
        print(f'created {aid}')
    set_key('.env', 'ELEVENLABS_AGENT_ID', aid)
    a = api('GET', f'/agents/{aid}')['conversation_config']
    print(json.dumps({'agent_id': aid, 'llm': a['agent']['prompt']['llm'], 'tts': a['tts']['model_id'],
                      'voice': a['tts']['voice_id'], 'tools': [t['name'] for t in a['agent']['prompt'].get('tools') or []],
                      'tool_ids': a['agent']['prompt'].get('tool_ids')}, indent=1))


if __name__ == '__main__':
    main()
