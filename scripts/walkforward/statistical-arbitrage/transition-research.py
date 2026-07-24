#!/usr/bin/env python3
"""
SA Swing walk-forward validation: TRANSITION regime lead (2026-07-22 diagnosis).

Purpose: Test whether Daily Regime=TRANSITION + |z|≥2.15 survives walk-forward splits.

Run:
  python3 scripts/walkforward/statistical-arbitrage/transition-research.py

Requires local xlsx exports: ~/Desktop/sa-12m-{btc,eth,bnb,sol,xrp}.xlsx
"""

import openpyxl
import json
from datetime import datetime, timedelta
from collections import defaultdict

SYMS = ['btc', 'eth', 'bnb', 'sol', 'xrp']
DESKTOP = '/Users/fahras/Desktop'

def num(x):
    try:
        return float(x) if x and x != '' else None
    except:
        return None

def parse_time(ts_str):
    """Parse 'Thu 02 Jul '20  23:00' format."""
    if not ts_str:
        return None
    try:
        return datetime.strptime(str(ts_str).strip(), "%a %d %b '%y %H:%M")
    except:
        return None

def stats(trades):
    if not trades:
        return None
    n = len(trades)
    wins = [t for t in trades if (t['pnl_net'] or 0) > 0]
    losses = [t for t in trades if (t['pnl_net'] or 0) <= 0]
    gp = sum(t['pnl_net'] for t in wins) if wins else 0
    gl = abs(sum(t['pnl_net'] for t in losses)) if losses else 0
    pf = (gp / gl) if gl > 0 else float('inf')
    net = sum(t['pnl_net'] for t in trades)
    return {
        'n': n,
        'wins': len(wins),
        'wr': round(100 * len(wins) / n, 1) if n > 0 else 0,
        'pf': round(pf, 3) if pf != float('inf') else 'inf',
        'net': round(net, 2),
    }

print("="*70)
print("SA SWING — TRANSITION WALK-FORWARD VALIDATION")
print("="*70)
print()

# Load all data
all_trades = []
for s in SYMS:
    path = f"{DESKTOP}/sa-12m-{s}.xlsx"
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb['StatArb_specific']
    rows = list(ws.iter_rows(values_only=True))
    hdr = rows[0]
    idx = {h: i for i, h in enumerate(hdr)}
    for r in rows[1:]:
        if r[0] is None:
            continue
        t = {
            'file': s,
            'symbol': r[idx['Symbol']],
            'pnl_net': num(r[idx['PnL Net']]),
            'z': num(r[idx['Sa ZScore']]),
            'regime': r[idx['Daily Regime']],
            'open_time': parse_time(r[idx['Open Time']]),
        }
        all_trades.append(t)
    wb.close()

all_trades.sort(key=lambda t: t['open_time'] or datetime.min)
print(f"Total trades: {len(all_trades)}")
print(f"Date range: {all_trades[0]['open_time'].date()} → {all_trades[-1]['open_time'].date()}")
print()

# Walk-forward splits (expanding window)
min_date = all_trades[0]['open_time']
max_date = all_trades[-1]['open_time']
total_days = (max_date - min_date).days

print("="*70)
print("WALK-FORWARD SPLITS")
print("="*70)
print()

splits_def = [
    {'name': 'Split 1', 'train_pct': 0.25, 'test_pct': 0.10},
    {'name': 'Split 2', 'train_pct': 0.50, 'test_pct': 0.10},
    {'name': 'Split 3', 'train_pct': 0.65, 'test_pct': 0.10},
    {'name': 'Split 4', 'train_pct': 0.75, 'test_pct': 0.10},
]

results = []
for split in splits_def:
    train_pct = split['train_pct']
    test_pct = split['test_pct']
    split_name = split['name']
    train_cutoff = min_date + timedelta(days=int(total_days * train_pct))
    test_start = train_cutoff
    test_cutoff = min_date + timedelta(days=int(total_days * (train_pct + test_pct)))
    train = [t for t in all_trades if t['open_time'] < train_cutoff]
    test = [t for t in all_trades if test_start <= t['open_time'] < test_cutoff]
    transition_test = [t for t in test if t['regime'] == 'TRANSITION' and t['z'] and abs(t['z']) >= 2.15]
    test_stats = stats(transition_test)
    print(f"{split_name}:")
    print(f"  Train: {train_cutoff.date()} ({len(train)} trades)")
    print(f"  Test:  {test_cutoff.date()} ({len(test)} trades)")
    if test_stats:
        print(f"  TRANSITION+|z|≥2.15: n={test_stats['n']}, WR={test_stats['wr']}%, PF={test_stats['pf']}, net={test_stats['net']}")
    else:
        print(f"  TRANSITION+|z|≥2.15: n=0 (no trades)")
    print()
    results.append({'split': split_name, 'train_end': train_cutoff.isoformat(), 'test_end': test_cutoff.isoformat(), 'n_test': len(test), 'stats': test_stats})

# Per-coin breakdown
print("="*70)
print("TRANSITION+|z|≥2.15 PER-COIN (Full 12-month)")
print("="*70)
print()

by_coin = defaultdict(list)
for t in all_trades:
    if t['regime'] == 'TRANSITION' and t['z'] and abs(t['z']) >= 2.15:
        by_coin[t['file']].append(t)

for s in SYMS:
    coin_trades = by_coin[s]
    coin_stats = stats(coin_trades)
    if coin_stats:
        print(f"{s.upper()}: n={coin_stats['n']} WR={coin_stats['wr']}% PF={coin_stats['pf']} net={coin_stats['net']}")
    else:
        print(f"{s.upper()}: n=0")

print()
print("="*70)
print("VERDICT")
print("="*70)
print()

oos_pfs = [r['stats']['pf'] for r in results if r['stats'] and isinstance(r['stats']['pf'], float) and r['stats']['pf'] > 0]
oos_pass = sum(1 for pf in oos_pfs if pf >= 1.0)
print(f"OOS splits with PF≥1.0: {oos_pass}/{len(oos_pfs)}")
if oos_pass >= len(oos_pfs) * 0.75:
    print("✅ TRANSITION lead PASSES walk-forward check")
else:
    print("⚠️  Variance in OOS splits — needs deeper investigation")

# Export
output = {
    'timestamp': datetime.now().isoformat(),
    'total_trades': len(all_trades),
    'splits': results,
    'by_coin': {s: stats(by_coin[s]) if by_coin[s] else None for s in SYMS},
}
with open('/tmp/sa_swing_transition_walkforward.json', 'w') as f:
    json.dump(output, f, default=str, indent=2)
print("[exported /tmp/sa_swing_transition_walkforward.json]")
