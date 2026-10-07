"""Tests the meter against the account's real usage figures.

The meter never sees how Anthropic counts usage; it only prices tokens. The
account's own percentages are the truth it is held to: over every stretch a
window was watched, the dollars the meter counted are set beside the points
the window really moved. If the meter counts the right thing, dollars per
point come out the same from one stretch to the next. A wide spread means it
is missing usage, or weighs it differently from Anthropic.

Run: python check.py [hours]   (hours: how far back to look, default all)
"""
import glob
import io
import json
import os
import statistics
import sys
import time

HOME = os.path.expanduser('~')
# The meter's store file. Its name carries where the plugin was installed from,
# so take whichever was written last.
STORE = sorted(
    glob.glob(os.path.join(HOME, '.claude', 'plugins', 'store', 'usage-meter_*.json')),
    key=os.path.getmtime,
    reverse=True,
)
WEEK = 7 * 24 * 3600 * 1000
SAME_WINDOW = 5 * 60 * 1000
MIN_POINTS = 3


def account(r7):
    return None if not r7 else round((r7 % WEEK) / 600000) % 1008


def runs(line):
    out, acc = [], None
    for point in line:
        acc = account(point.get('r7')) or acc
        if acc is None:
            continue
        if out and out[-1][0] == acc:
            out[-1][1].append(point)
        else:
            out.append((acc, [point]))
    return out


def usd_at(line, t):
    usd = line[0]['usd']
    for point in line:
        if point['t'] > t:
            break
        usd = point['usd']
    return usd


def stamp(t):
    return time.strftime('%a %d %H:%M', time.localtime(t / 1000))


def main():
    since = (time.time() - float(sys.argv[1]) * 3600) * 1000 if len(sys.argv) > 1 else 0
    with io.open(STORE[0], encoding='utf-8') as held:
        store = json.load(held)

    accounts = {}
    for key, line in store.items():
        if key.startswith('tl:'):
            for acc, points in runs([p for p in line if p['t'] >= since]):
                accounts.setdefault(acc, []).append(points)

    for acc, lines in accounts.items():
        reset = next(p['r7'] for line in lines for p in line if p.get('r7'))
        print('\nAccount whose week resets %s (%d session runs)' % (time.strftime('%a %H:%M', time.localtime(reset / 1000)), len(lines)))
        for pk, rk, label in (('p5', 'r5', '5-hour'), ('p7', 'r7', 'week')):
            readings = sorted((p['t'], p[pk], p.get(rk, 0)) for line in lines for p in line if p.get(pk) is not None)
            spans = []
            for reading in readings:
                last = spans[-1][1] if spans else None
                if last and abs(reading[2] - last[2]) < SAME_WINDOW and reading[1] >= last[1] - 0.5:
                    spans[-1][1] = reading
                else:
                    spans.append([reading, reading])
            rates = []
            print('  %s windows:' % label)
            for first, last in spans:
                moved = last[1] - first[1]
                spent = sum(usd_at(line, last[0]) - usd_at(line, first[0]) for line in lines)
                if moved < 1:
                    continue
                rate = spent / moved
                firm = moved >= MIN_POINTS
                if firm:
                    rates.append(rate)
                print('    %s to %s  moved %5.1f%%  metered $%7.2f  = $%.3f per 1%%%s' % (
                    stamp(first[0]), stamp(last[0]), moved, spent, rate, '' if firm else '  (too short to count)'))
            if len(rates) >= 2:
                mid = statistics.median(rates)
                spread = (max(rates) - min(rates)) / mid * 100
                print('    => median $%.3f per 1%%, spread %.0f%% across %d windows' % (mid, spread, len(rates)))
            elif rates:
                print('    => one usable window only: $%.3f per 1%%, nothing to compare it with yet' % rates[0])
            else:
                print('    => no window moved %d points while watched' % MIN_POINTS)


if __name__ == '__main__':
    main()
