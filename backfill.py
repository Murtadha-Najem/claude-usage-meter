"""Reads every saved Claude Code conversation on this machine and writes what
each one cost, at Anthropic's published rates, to history.json beside this file.

The meter adds that to what it counts itself, so a session that began before
the meter was installed shows its whole cost and not only what the meter watched.
Run it again at any time: it rewrites history.json from scratch.
"""
import glob
import io
import json
import os
import time

HOME = os.path.expanduser('~')
PROJECTS = os.path.join(HOME, '.claude', 'projects')
# The meter's store file. Its name carries where the plugin was installed from,
# so take whichever was written last.
STORE = sorted(
    glob.glob(os.path.join(HOME, '.claude', 'plugins', 'store', 'usage-meter_*.json')),
    key=os.path.getmtime,
    reverse=True,
)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'history.json')


# Dollars per million tokens: input, output, cache read, 5-minute cache write,
# 1-hour cache write. The same table as RATES in hooks/register.tsx, from
# platform.claude.com/docs/en/about-claude/pricing as read on 5 Oct 2026.
RATES = [
    ('claude-fable-5-1', 10, 50, 0.25, 12.5, 20),
    ('claude-mythos-5-1', 10, 50, 0.25, 12.5, 20),
    ('claude-fable-5', 10, 50, 1, 12.5, 20),
    ('claude-mythos-5', 10, 50, 1, 12.5, 20),
    ('claude-opus-5-5', 4, 20, 0.2, 5, 8),
    ('claude-opus-5', 5, 25, 0.5, 6.25, 10),
    ('claude-opus-4-1', 15, 75, 1.5, 18.75, 30),
    ('claude-opus-4-5', 5, 25, 0.5, 6.25, 10),
    ('claude-opus-4-6', 5, 25, 0.5, 6.25, 10),
    ('claude-opus-4-7', 5, 25, 0.5, 6.25, 10),
    ('claude-opus-4-8', 5, 25, 0.5, 6.25, 10),
    ('claude-opus-4', 15, 75, 1.5, 18.75, 30),
    ('claude-sonnet-5', 2, 10, 0.2, 2.5, 4),
    ('claude-sonnet-4', 3, 15, 0.3, 3.75, 6),
    ('claude-haiku-4-5', 1, 5, 0.1, 1.25, 2),
    ('claude-haiku-3-5', 0.8, 4, 0.08, 1, 1.6),
]
UNKNOWN = 'claude-opus-5-5'
SEARCH_USD = 0.01  # web search: $10 per 1,000 searches


def priced(model, usage):
    rate = next((r for r in RATES if model.startswith(r[0])), None)
    rate = rate or next(r for r in RATES if r[0] == UNKNOWN)
    _, tin, tout, read, w5, w1 = rate
    made = usage.get('cache_creation') or {}
    in5 = made.get('ephemeral_5m_input_tokens')
    in1 = made.get('ephemeral_1h_input_tokens')
    if in5 is None and in1 is None:
        in5, in1 = 0, usage.get('cache_creation_input_tokens') or 0
    usd = (
        (usage.get('input_tokens') or 0) * tin
        + (usage.get('output_tokens') or 0) * tout
        + (usage.get('cache_read_input_tokens') or 0) * read
        + (in5 or 0) * w5
        + (in1 or 0) * w1
    ) / 1e6
    # Fast mode is billed at twice the standard rate.
    if usage.get('speed') == 'fast':
        usd *= 2
    searches = (usage.get('server_tool_use') or {}).get('web_search_requests') or 0
    return usd + searches * SEARCH_USD


def responses(path):
    """One (id, model, usage) per model response: a response written as several
    rows repeats its usage on each, so the last row of an id stands for it."""
    seen = {}
    with io.open(path, encoding='utf-8', errors='replace') as lines:
        for line in lines:
            if '"usage"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            message = row.get('message') or {}
            usage = message.get('usage')
            if row.get('type') != 'assistant' or not usage:
                continue
            key = message.get('id') or row.get('requestId') or row.get('uuid')
            seen[key] = (message.get('model') or 'unknown', usage)
    return seen


def main():
    store = {}
    if STORE:
        with io.open(STORE[0], encoding='utf-8') as held:
            store = json.load(held)

    history = {}
    for path in glob.glob(os.path.join(PROJECTS, '*', '*.jsonl')):
        session = os.path.basename(path)[:-6]
        seen = responses(path)
        side = os.path.join(path[:-6], 'subagents')
        for extra in glob.glob(os.path.join(side, '**', '*.jsonl'), recursive=True):
            seen.update(responses(extra))

        usd = sum(priced(model, usage) for model, usage in seen.values() if not model.startswith('<'))
        if usd <= 0:
            continue

        # What the meter's own sum stood at when this was read: only what it
        # adds after this point is counted on top of the history.
        held = store.get('sum:' + session)
        if held is None:
            line = store.get('tl:' + session) or []
            held = line[-1]['usd'] if line else 0
        history[session] = {'usd': round(usd, 4), 'sumAt': held}

    with io.open(OUT, 'w', encoding='utf-8') as out:
        json.dump({'at': int(time.time() * 1000), 'sessions': history}, out)
    print(len(history), 'sessions written to', OUT)


if __name__ == '__main__':
    main()
