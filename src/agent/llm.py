"""Claude client: Anthropic API if ANTHROPIC_API_KEY is set, else Amazon Bedrock (Mantle endpoint) via bearer token."""
import os
import time

import anthropic

# USD per 1M tokens (input, output). Cache reads ~0.1x input, cache writes ~1.25x input. First-party list prices.
PRICES = {'claude-sonnet-5': (2, 10), 'claude-opus-5': (5, 25), 'claude-opus-4-8': (5, 25), 'claude-haiku-4-5': (1, 5)}


def make_client():
    """Returns (client, model_prefix). SDK retries 408/409/429/5xx and connection errors with backoff."""
    if os.environ.get('ANTHROPIC_API_KEY'):
        return anthropic.Anthropic(api_key=os.environ['ANTHROPIC_API_KEY'], max_retries=6, timeout=600), ''
    token = os.environ.get('AWS_BEARER_TOKEN_BEDROCK')
    if token:
        region = os.environ.get('AWS_BEDROCK_REGION') or 'eu-west-1'
        # x-api-key header carries the bearer token; Mantle accepts it (no extra Authorization header).
        return anthropic.Anthropic(base_url=f'https://bedrock-mantle.{region}.api.aws/anthropic', api_key=token,
                                   max_retries=6, timeout=600), 'anthropic.'
    raise SystemExit('No credentials: set ANTHROPIC_API_KEY or AWS_BEARER_TOKEN_BEDROCK (see .env.example)')


def cost_usd(model, usage):
    pin, pout = PRICES.get(model, (0, 0))
    u = usage or {}
    return (u.get('input_tokens', 0) * pin + u.get('cache_creation_input_tokens', 0) * pin * 1.25
            + u.get('cache_read_input_tokens', 0) * pin * 0.1 + u.get('output_tokens', 0) * pout) / 1e6


def call(client, prefix, model, system, messages, tools, thinking=True, max_tokens=16000):
    """One Messages call. Returns (response, info dict for the trace)."""
    kw = {}
    if thinking and 'haiku' not in model:
        kw['thinking'] = {'type': 'adaptive'}
    t0 = time.time()
    resp = client.messages.create(model=prefix + model, system=system, messages=messages, tools=tools,
                                  max_tokens=max_tokens, **kw)
    usage = resp.usage.model_dump() if resp.usage else {}
    usage = {k: v for k, v in usage.items() if isinstance(v, int)}
    return resp, {'model': model, 'duration_s': round(time.time() - t0, 2), 'stop_reason': resp.stop_reason,
                  'usage': usage, 'cost_usd': round(cost_usd(model, usage), 5)}
