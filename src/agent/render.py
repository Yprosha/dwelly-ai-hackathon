"""Render ANSWER.md / REASONING.md from the agent's recorded state. Pure formatting: no model calls."""
import json

LABEL = {'act': 'ACT', 'ask_for_info': 'ASK FOR INFORMATION', 'escalate': 'ESCALATE TO HUMAN', 'no_action': 'NO ACTION'}


def _quote(text):
    return '\n'.join('> ' + line if line.strip() else '>' for line in str(text).strip().splitlines())


def _bullets(items, empty='None.'):
    items = [i for i in (items or []) if str(i).strip()]
    return '\n'.join(f'- {i}' for i in items) if items else empty


def _action(a):
    i = a['input']
    if a['tool'] == 'send_message':
        return (f"**Message to {i.get('to')}** ({i.get('recipient_role')}) via {i.get('channel')}"
                f" - human approval before sending: {'yes' if i.get('needs_human_approval') else 'no'}\n\n"
                + (f"Subject: {i['subject']}\n\n" if i.get('subject') else '') + _quote(i.get('body', ''))
                + f"\n\nPurpose: {i.get('purpose', '')}")
    if a['tool'] == 'escalate_to_human':
        return (f"**Escalation to human** - urgency: {i.get('urgency')}"
                + (f", route to: {i['route_to']}" if i.get('route_to') else '')
                + f"\n\nReason: {i.get('reason')}\n\nHandover summary:\n\n{_quote(i.get('handover_summary', ''))}"
                + f"\n\nOpen questions:\n{_bullets(i.get('open_questions'))}"
                + (f"\n\nRecommended next steps:\n{_bullets(i.get('recommended_next_steps'))}" if i.get('recommended_next_steps') else ''))
    if a['tool'] == 'create_internal_note':
        return f"**Internal case note**\n\n{_quote(i.get('text', ''))}"
    if a['tool'] == 'no_action':
        return f"**No action now** - {i.get('reason')}" + (f"\n\nNext trigger: {i['next_trigger']}" if i.get('next_trigger') else '')
    return f"**{a['tool']}** {json.dumps(i, ensure_ascii=False)}"


def answer_md(case, env, meta):
    f = env.final
    committed = [a for a in env.actions if a['status'] == 'committed']
    out = [f"# Case {case['id']} - Answer\n"]
    if f:
        steps = f.get('next_steps') or []
        steps = [s for s in (steps.splitlines() if isinstance(steps, str) else steps) if str(s).strip()]
        out.append(f"## Final outcome\n\n{f.get('final_outcome') or 'Not stated.'}\n\n## Next steps\n\n"
                   + ('\n'.join(f'{n}. {s}' for n, s in enumerate(steps, 1)) or 'None stated.') + '\n')
        out.append(f"## Decision\n\n**Decision:** {LABEL.get(f.get('decision_type'), f.get('decision_type'))}  \n"
                   f"**Confidence:** {f.get('confidence')}\n\n## Situation\n\n{f.get('situation', '')}\n")
    else:
        why = meta.get('error') or meta.get('stopped') or 'agent did not complete'
        out.append("## Final outcome\n\nNot determined: the automated run did not complete, so the case is handed to a human "
                   "handler unchanged.\n\n## Next steps\n\n1. NOW - a human handler reviews the case from the start.\n")
        out.append(f"## Decision\n\n**Decision:** ESCALATE TO HUMAN (system fallback - the agent did not complete this case)  \n"
                   f"**Confidence:** 0\n\n## Situation\n\nThe automated run failed: {why}. No action was committed. "
                   "A human handler must review this case from the start; any drafts the agent staged are listed below "
                   "for reference only.\n")
    out.append('## Actions taken\n\n(Recorded in the mock operations outbox; messages flagged for approval would wait for a human.)\n')
    shown = committed if f else [a for a in env.actions if a['status'] == 'staged']
    out += [f"### {n}. {_action(a)}\n" for n, a in enumerate(shown, 1)] or ['None.\n']
    esc = [a for a in shown if a['tool'] == 'escalate_to_human']
    out.append('## Escalated\n\n' + ('\n'.join(f"- {a['input'].get('reason')} (urgency {a['input'].get('urgency')})" for a in esc)
                                     if esc else ('Whole case (system fallback).' if not f else 'Nothing escalated.')) + '\n')
    if f:
        out.append(f"## Open risks\n\n{_bullets(f.get('open_risks'))}\n")
    return '\n'.join(out)


def reasoning_md(case, env, meta, model, trace_path):
    f = env.final or {}
    out = [f"# Case {case['id']} - Reasoning\n", '## What the system received\n', _bullets(case['files'], 'No files.')]
    if case['notes']:
        out.append('\nLoader notes:\n\n' + _bullets(case['notes']))
    out += ['\n## Key facts\n', _bullets(f.get('key_facts'), 'Not produced (agent did not complete).'),
            '\n## Conflicts, gaps and risks detected\n', _bullets(f.get('issues_detected'), 'None detected.' if f else 'Not produced.'),
            '\n## Options considered\n', _bullets(f.get('options_considered'), 'Not produced.'),
            '\n## Why this decision\n', f.get('rationale') or 'Not produced.',
            '\n## Tool calls in order\n']
    for n, c in enumerate(env.calls, 1):
        inp = json.dumps(c['input'], ensure_ascii=False)
        res = c['result'] if c['tool'] != 'finish' or c['is_error'] else c['result'].split('\n\n')[0]
        out.append(f"{n}. `{c['tool']}` {inp[:400]}{'...' if len(inp) > 400 else ''}\n   - result{' (ERROR)' if c['is_error'] else ''}: "
                   + res[:500].replace('\n', ' / '))
    if not env.calls:
        out.append('None.')
    failed = [f"Tool error in `{c['tool']}`: {c['result']}" for c in env.calls if c['is_error']]
    failed += [f"{a['id']} ({a['tool']}) cancelled after self-check: {a.get('cancel_reason')}" for a in env.actions if a['status'] == 'cancelled']
    if meta.get('error'):
        failed.append(f"Run failed: {meta['error']}")
    if meta.get('stopped'):
        failed.append(f"Loop stopped: {meta['stopped']}")
    out += ['\n## What failed or was corrected\n', _bullets(failed, 'Nothing failed.'),
            '\n## Confidence\n', str(f.get('confidence', 0)),
            '\n## Run\n',
            f"- Model: {model}\n- Model calls: {meta.get('turns')}\n- Tokens: {json.dumps(meta.get('usage', {}))}\n"
            f"- Estimated cost (list price): ${meta.get('cost_usd')}\n- Wall time: {meta.get('duration_s')}s\n- Trace: `{trace_path}`\n"]
    return '\n'.join(out)
