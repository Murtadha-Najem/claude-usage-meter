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
# Readings further apart than this had no session reporting in between, so
# whatever the limit moved meanwhile is set apart as its own stretch.
QUIET = 30 * 60 * 1000
# A limit moves in whole points, so a stretch shorter than this is too coarse
# to compare with the others. A stretch this far from the middle one is usage
# the meter did not see (the phone app, claude.ai), as the meter itself treats it.
MIN_POINTS = 10
FAR = 3


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


def stretches(readings):
    """Cuts an account's readings into stretches, as the meter does.

    A window is every reading that shares one reset time. Within it the limit
    only rises, so a reading below one already seen is a stale one from another
    session and is left out. A window is cut only where nothing reported for a
    while: use across such a gap may not have been metered at all.
    """
    windows = {}
    for t, p, r in sorted(readings):
        windows.setdefault(round(r / SAME_WINDOW), []).append((t, p))
    out = []
    for key in sorted(windows, key=lambda k: windows[k][0][0]):
        rising = []
        for reading in windows[key]:
            if not rising or reading[1] >= rising[-1][1]:
                rising.append(reading)
        start = rising[0]
        for before, after in zip(rising, rising[1:]):
            if after[0] - before[0] > QUIET:
                out.append((start, before, False))
                out.append((before, after, True))
                start = after
        out.append((start, rising[-1], False))
    return out


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
            readings = [(p['t'], p[pk], p[rk]) for line in lines for p in line if p.get(pk) is not None and p.get(rk)]
            found = []
            for first, last, quiet in stretches(readings):
                moved = last[1] - first[1]
                if moved >= 1:
                    spent = sum(usd_at(line, last[0]) - usd_at(line, first[0]) for line in lines)
                    found.append((first, last, quiet, moved, spent))
            firm = [spent / moved for _, _, quiet, moved, spent in found if moved >= MIN_POINTS and not quiet]
            mid = statistics.median(firm) if firm else 0
            rates, points, usd = [], 0, 0
            print('  %s windows:' % label)
            for first, last, quiet, moved, spent in found:
                rate = spent / moved
                if quiet:
                    note = '  (nothing reporting in between, not counted)'
                elif moved < MIN_POINTS:
                    note = '  (too short to count)'
                elif not mid / FAR < rate < mid * FAR:
                    note = '  (far from the rest: usage the meter did not see, not counted)'
                else:
                    note = ''
                    rates.append(rate)
                    points += moved
                    usd += spent
                print('    %s to %s  moved %5.1f%%  metered $%7.2f  = $%.3f per 1%%%s' % (
                    stamp(first[0]), stamp(last[0]), moved, spent, rate, note))
            if len(rates) >= 2:
                spread = (max(rates) - min(rates)) / mid * 100
                print('    => $%.3f per 1%% over %d points, spread %.0f%% across %d stretches' % (usd / points, points, spread, len(rates)))
            elif rates:
                print('    => one usable stretch only: $%.3f per 1%%, nothing to compare it with yet' % rates[0])
            else:
                print('    => no stretch moved %d points while watched' % MIN_POINTS)


if __name__ == '__main__':
    main()
