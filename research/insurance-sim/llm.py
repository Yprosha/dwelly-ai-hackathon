"""Minimal Claude Messages client (stdlib only).
Uses ANTHROPIC_API_KEY (api.anthropic.com) if set, else AWS_BEARER_TOKEN_BEDROCK (Bedrock Mantle, region AWS_BEDROCK_REGION)."""
import json, os, time, urllib.request, urllib.error

KEY = os.environ.get('ANTHROPIC_API_KEY')
TOKEN = os.environ.get('AWS_BEARER_TOKEN_BEDROCK')
if KEY:
    URL, AUTH, PREFIX = 'https://api.anthropic.com/v1/messages', KEY, ''
else:
    URL = f"https://bedrock-mantle.{os.environ.get('AWS_BEDROCK_REGION', 'eu-west-1')}.api.aws/anthropic/v1/messages"
    AUTH, PREFIX = TOKEN, 'anthropic.'


def call(model, system, content, max_tokens=1500, retries=4, thinking=None):
    body = json.dumps({'model': PREFIX + model, 'max_tokens': max_tokens, 'system': system,
                       'messages': [{'role': 'user', 'content': content}],
                       **({'thinking': thinking} if thinking else {})}).encode()
    for i in range(retries):
        req = urllib.request.Request(URL, body, {'content-type': 'application/json', 'x-api-key': AUTH, 'anthropic-version': '2023-06-01'})
        try:
            r = json.load(urllib.request.urlopen(req, timeout=180))
            return ''.join(b.get('text', '') for b in r['content']), r.get('usage', {})
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:300]
            if e.code in (429, 500, 502, 503, 529) and i < retries - 1:
                time.sleep(2 ** i * 3); continue
            raise RuntimeError(f'{e.code}: {err}')
        except (urllib.error.URLError, TimeoutError):
            if i < retries - 1: time.sleep(3); continue
            raise
