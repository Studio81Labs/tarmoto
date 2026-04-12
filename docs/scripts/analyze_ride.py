#!/usr/bin/env python3
"""
Tarmoto — Ride Data Analyzer v0.1
Analyzes CSV exports from the Tarmoto PoC sensor app.

Usage:
  python analyze_ride.py segments_file.csv [raw_file.csv]
  python analyze_ride.py --dir ./rides/     # analyze all CSVs in a directory

Outputs:
  - Console summary statistics
  - PNG charts saved to ./analysis/ folder
  - Combined report if multiple riders' data found
"""

import sys
import os
import glob
import argparse
from datetime import datetime

try:
    import pandas as pd
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    import numpy as np
except ImportError:
    print("Installing required packages...")
    os.system("pip install pandas matplotlib numpy --break-system-packages -q")
    import pandas as pd
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    import numpy as np

# ── Brand colors ──
COLORS = {
    'bg': '#070A10',
    'card': '#0C1018',
    'text': '#E8ECF2',
    'text2': '#8B95A8',
    'text3': '#4A5568',
    'cyan': '#0ED3CF',
    'excellent': '#22C55E',
    'good': '#84CC16',
    'fair': '#EAB308',
    'poor': '#F97316',
    'very_poor': '#EF4444',
    'grid': '#1A2235',
}

QUALITY_COLORS = {
    'excellent': COLORS['excellent'],
    'good': COLORS['good'],
    'fair': COLORS['fair'],
    'poor': COLORS['poor'],
    'very_poor': COLORS['very_poor'],
}

TAG_COLORS = {
    'smooth': '#22C55E',
    'rough': '#F97316',
    'gravel': '#EAB308',
    'cobblestone': '#A78BFA',
    'dirt': '#78716C',
    'unknown': '#4A5568',
}


def setup_plot_style():
    """Apply Tarmoto brand styling to matplotlib."""
    plt.rcParams.update({
        'figure.facecolor': COLORS['bg'],
        'axes.facecolor': COLORS['card'],
        'axes.edgecolor': COLORS['grid'],
        'axes.labelcolor': COLORS['text2'],
        'text.color': COLORS['text'],
        'xtick.color': COLORS['text3'],
        'ytick.color': COLORS['text3'],
        'grid.color': COLORS['grid'],
        'grid.alpha': 0.5,
        'font.size': 10,
        'axes.titlesize': 14,
        'axes.titleweight': 'bold',
        'figure.titlesize': 16,
        'figure.titleweight': 'bold',
    })


def load_segments(filepath):
    """Load segments CSV."""
    df = pd.read_csv(filepath)
    if 'timestamp' in df.columns:
        df['timestamp'] = pd.to_datetime(df['timestamp'])
    return df


def load_raw(filepath):
    """Load raw accelerometer CSV."""
    df = pd.read_csv(filepath)
    if 'timestamp' in df.columns:
        df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', errors='coerce')
    elif 't' in df.columns:
        df['timestamp'] = pd.to_datetime(df['t'], unit='ms', errors='coerce')
    return df


def print_summary(segments, raw=None):
    """Print console summary of ride data."""
    print("\n" + "=" * 60)
    print("  TARMOTO — Ride Data Analysis")
    print("=" * 60)

    riders = segments['rider'].unique() if 'rider' in segments.columns else ['unknown']
    print(f"\n  Riders:         {', '.join(riders)}")
    print(f"  Total segments: {len(segments)}")
    total_dist = segments['distance_m'].sum() if 'distance_m' in segments.columns else 0
    print(f"  Total distance: {total_dist:.0f}m ({total_dist/1000:.1f}km)")

    if 'rms' in segments.columns:
        print(f"\n  RMS Statistics:")
        print(f"    Mean:         {segments['rms'].mean():.3f} m/s²")
        print(f"    Median:       {segments['rms'].median():.3f} m/s²")
        print(f"    Std dev:      {segments['rms'].std():.3f} m/s²")
        print(f"    Min:          {segments['rms'].min():.3f} m/s²")
        print(f"    Max:          {segments['rms'].max():.3f} m/s²")

    if 'classification' in segments.columns:
        print(f"\n  Quality Distribution:")
        for cls in ['excellent', 'good', 'fair', 'poor', 'very_poor']:
            count = len(segments[segments['classification'] == cls])
            pct = count / len(segments) * 100 if len(segments) > 0 else 0
            bar = "█" * int(pct / 2)
            print(f"    {cls:12s}  {count:3d} ({pct:5.1f}%)  {bar}")

    if 'road_tag' in segments.columns:
        print(f"\n  Road Tags:")
        for tag in segments['road_tag'].unique():
            subset = segments[segments['road_tag'] == tag]
            print(f"    {tag:12s}  {len(subset):3d} segments  "
                  f"avg RMS: {subset['rms'].mean():.3f}  "
                  f"median: {subset['rms'].median():.3f}  "
                  f"std: {subset['rms'].std():.3f}")

    # KEY VALIDATION: Do road tags produce distinct RMS clusters?
    if 'road_tag' in segments.columns:
        tags = [t for t in segments['road_tag'].unique() if t != 'unknown']
        if len(tags) >= 2:
            print(f"\n  ── Validation: Are road types distinguishable? ──")
            tag_stats = {}
            for tag in tags:
                s = segments[segments['road_tag'] == tag]['rms']
                tag_stats[tag] = {'mean': s.mean(), 'std': s.std(), 'n': len(s)}

            sorted_tags = sorted(tag_stats.keys(), key=lambda t: tag_stats[t]['mean'])
            for i in range(len(sorted_tags) - 1):
                t1, t2 = sorted_tags[i], sorted_tags[i + 1]
                s1, s2 = tag_stats[t1], tag_stats[t2]
                gap = s2['mean'] - s1['mean']
                overlap = max(0, (s1['mean'] + s1['std']) - (s2['mean'] - s2['std']))
                sep = "CLEAR" if overlap <= 0 else f"OVERLAP {overlap:.2f}"
                print(f"    {t1} → {t2}: gap={gap:.3f} m/s²  [{sep}]")

            if all((tag_stats[sorted_tags[i+1]]['mean'] - tag_stats[sorted_tags[i]]['mean']) > 
                   max(tag_stats[sorted_tags[i]]['std'], tag_stats[sorted_tags[i+1]]['std'])
                   for i in range(len(sorted_tags)-1)):
                print(f"\n  ✅ RESULT: Road types show CLEAR separation!")
                print(f"     The accelerometer approach is VIABLE.")
            else:
                print(f"\n  ⚠️  RESULT: Road types show some overlap.")
                print(f"     May need frequency analysis or better thresholds.")

    if raw is not None:
        print(f"\n  Raw data: {len(raw)} readings")
        if 'deviation' in raw.columns:
            print(f"    Avg deviation:  {raw['deviation'].astype(float).mean():.4f} m/s²")
            print(f"    Sample rate:    ~{len(raw) / max(1, (raw['timestamp'].max() - raw['timestamp'].min()).total_seconds()):.0f} Hz")

    print("\n" + "=" * 60)


def plot_rms_by_tag(segments, outdir):
    """Box plot of RMS values grouped by road tag."""
    if 'road_tag' not in segments.columns:
        return

    tags = [t for t in ['smooth', 'rough', 'gravel', 'cobblestone', 'dirt', 'unknown']
            if t in segments['road_tag'].values]
    if len(tags) < 2:
        return

    fig, ax = plt.subplots(figsize=(10, 6))

    data = [segments[segments['road_tag'] == tag]['rms'].values for tag in tags]
    bp = ax.boxplot(data, labels=tags, patch_artist=True, widths=0.6,
                    medianprops=dict(color=COLORS['text'], linewidth=2),
                    whiskerprops=dict(color=COLORS['text3']),
                    capprops=dict(color=COLORS['text3']),
                    flierprops=dict(marker='o', markerfacecolor=COLORS['text3'],
                                   markersize=4, alpha=0.5))

    for patch, tag in zip(bp['boxes'], tags):
        color = TAG_COLORS.get(tag, COLORS['text3'])
        patch.set_facecolor(color + '44')
        patch.set_edgecolor(color)

    # Add threshold lines
    thresholds = [(1.5, 'Excellent', COLORS['excellent']),
                  (3.0, 'Good', COLORS['good']),
                  (5.5, 'Fair', COLORS['fair']),
                  (9.0, 'Poor', COLORS['poor'])]
    for val, label, color in thresholds:
        ax.axhline(y=val, color=color, linestyle='--', alpha=0.4, linewidth=1)
        ax.text(len(tags) + 0.6, val, label, fontsize=8, color=color, va='center')

    ax.set_ylabel('RMS Vibration (m/s²)')
    ax.set_title('RMS Distribution by Road Type')
    ax.grid(True, axis='y', alpha=0.3)
    plt.tight_layout()
    plt.savefig(os.path.join(outdir, 'rms_by_road_type.png'), dpi=150)
    plt.close()
    print(f"  📊 Saved: rms_by_road_type.png")


def plot_rms_timeline(segments, outdir):
    """Plot RMS over distance with color-coded quality and road tags."""
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 7), height_ratios=[3, 1],
                                    gridspec_kw={'hspace': 0.05})

    cumulative_dist = segments['distance_m'].cumsum() / 1000  # km

    # Top: RMS line chart
    for i in range(len(segments)):
        cls = segments.iloc[i].get('classification', 'unknown')
        color = QUALITY_COLORS.get(cls, COLORS['text3'])
        if i > 0:
            ax1.plot([cumulative_dist.iloc[i-1], cumulative_dist.iloc[i]],
                     [segments['rms'].iloc[i-1], segments['rms'].iloc[i]],
                     color=color, linewidth=2, solid_capstyle='round')
        ax1.scatter(cumulative_dist.iloc[i], segments['rms'].iloc[i],
                   color=color, s=20, zorder=5)

    # Threshold lines
    for val, color in [(1.5, COLORS['excellent']), (3.0, COLORS['good']),
                       (5.5, COLORS['fair']), (9.0, COLORS['poor'])]:
        ax1.axhline(y=val, color=color, linestyle='--', alpha=0.3, linewidth=1)

    ax1.set_ylabel('RMS Vibration (m/s²)')
    ax1.set_title('Road Quality Over Distance')
    ax1.grid(True, alpha=0.2)
    ax1.set_xlim(0, cumulative_dist.iloc[-1])
    ax1.set_xticklabels([])

    # Bottom: Road tag bar
    if 'road_tag' in segments.columns:
        for i in range(len(segments)):
            tag = segments.iloc[i].get('road_tag', 'unknown')
            color = TAG_COLORS.get(tag, COLORS['text3'])
            x_start = cumulative_dist.iloc[i-1] if i > 0 else 0
            x_end = cumulative_dist.iloc[i]
            ax2.barh(0, x_end - x_start, left=x_start, height=0.6,
                    color=color, alpha=0.8, edgecolor='none')

        ax2.set_xlim(0, cumulative_dist.iloc[-1])
        ax2.set_xlabel('Distance (km)')
        ax2.set_ylabel('Road tag')
        ax2.set_yticks([])
        # Legend
        used_tags = segments['road_tag'].unique()
        patches = [mpatches.Patch(color=TAG_COLORS.get(t, '#666'), label=t)
                   for t in used_tags if t in TAG_COLORS]
        ax2.legend(handles=patches, loc='upper right', fontsize=8,
                  facecolor=COLORS['card'], edgecolor=COLORS['grid'])
    else:
        ax2.set_visible(False)

    plt.tight_layout()
    plt.savefig(os.path.join(outdir, 'rms_timeline.png'), dpi=150)
    plt.close()
    print(f"  📊 Saved: rms_timeline.png")


def plot_quality_distribution(segments, outdir):
    """Pie/donut chart of quality classification."""
    if 'classification' not in segments.columns:
        return

    order = ['excellent', 'good', 'fair', 'poor', 'very_poor']
    counts = segments['classification'].value_counts()
    labels = [c for c in order if c in counts.index]
    values = [counts[c] for c in labels]
    chart_colors = [QUALITY_COLORS[c] for c in labels]

    fig, ax = plt.subplots(figsize=(7, 7))
    wedges, texts, autotexts = ax.pie(
        values, labels=labels, colors=chart_colors, autopct='%1.0f%%',
        startangle=90, pctdistance=0.78,
        wedgeprops=dict(width=0.4, edgecolor=COLORS['bg'], linewidth=2))

    for text in texts:
        text.set_color(COLORS['text2'])
        text.set_fontsize(11)
    for autotext in autotexts:
        autotext.set_color(COLORS['text'])
        autotext.set_fontsize(10)
        autotext.set_fontweight('bold')

    ax.set_title('Road Quality Distribution', pad=20)
    plt.tight_layout()
    plt.savefig(os.path.join(outdir, 'quality_distribution.png'), dpi=150)
    plt.close()
    print(f"  📊 Saved: quality_distribution.png")


def plot_rms_histogram(segments, outdir):
    """Histogram of RMS values, colored by road tag."""
    fig, ax = plt.subplots(figsize=(10, 5))

    if 'road_tag' in segments.columns:
        tags = [t for t in ['smooth', 'rough', 'gravel', 'cobblestone', 'dirt']
                if t in segments['road_tag'].values]
        for tag in tags:
            subset = segments[segments['road_tag'] == tag]['rms']
            ax.hist(subset, bins=25, alpha=0.5, label=tag,
                    color=TAG_COLORS.get(tag, '#666'), edgecolor='none')
        ax.legend(facecolor=COLORS['card'], edgecolor=COLORS['grid'])
    else:
        ax.hist(segments['rms'], bins=30, alpha=0.7,
                color=COLORS['cyan'], edgecolor='none')

    # Threshold lines
    for val, label, color in [(1.5, 'Excellent', COLORS['excellent']),
                              (3.0, 'Good', COLORS['good']),
                              (5.5, 'Fair', COLORS['fair']),
                              (9.0, 'Poor', COLORS['poor'])]:
        ax.axvline(x=val, color=color, linestyle='--', alpha=0.5, linewidth=1.5)
        ax.text(val + 0.1, ax.get_ylim()[1] * 0.9, label, fontsize=8,
                color=color, rotation=90, va='top')

    ax.set_xlabel('RMS Vibration (m/s²)')
    ax.set_ylabel('Segment Count')
    ax.set_title('RMS Distribution — Do Road Types Separate?')
    ax.grid(True, axis='y', alpha=0.2)
    plt.tight_layout()
    plt.savefig(os.path.join(outdir, 'rms_histogram.png'), dpi=150)
    plt.close()
    print(f"  📊 Saved: rms_histogram.png")


def plot_speed_vs_rms(segments, outdir):
    """Scatter: does speed affect RMS readings?"""
    if 'speed_kmh' not in segments.columns and 'speed' not in segments.columns:
        return

    # Raw data might have speed
    fig, ax = plt.subplots(figsize=(8, 5))

    if 'road_tag' in segments.columns:
        for tag in segments['road_tag'].unique():
            subset = segments[segments['road_tag'] == tag]
            ax.scatter(subset.get('speed_kmh', subset.get('speed', [])),
                      subset['rms'], alpha=0.5, s=20,
                      color=TAG_COLORS.get(tag, '#666'), label=tag)
        ax.legend(facecolor=COLORS['card'], edgecolor=COLORS['grid'])
    else:
        ax.scatter(segments.get('speed_kmh', segments.get('speed', [])),
                  segments['rms'], alpha=0.5, s=20, color=COLORS['cyan'])

    ax.set_xlabel('Speed (km/h)')
    ax.set_ylabel('RMS Vibration (m/s²)')
    ax.set_title('Speed vs RMS — Checking for Speed Bias')
    ax.grid(True, alpha=0.2)
    plt.tight_layout()
    plt.savefig(os.path.join(outdir, 'speed_vs_rms.png'), dpi=150)
    plt.close()
    print(f"  📊 Saved: speed_vs_rms.png")


def plot_multi_rider(segments, outdir):
    """Compare RMS distributions across multiple riders."""
    if 'rider' not in segments.columns:
        return
    riders = segments['rider'].unique()
    if len(riders) < 2:
        return

    fig, ax = plt.subplots(figsize=(10, 6))
    data = [segments[segments['rider'] == r]['rms'].values for r in riders]
    bp = ax.boxplot(data, labels=riders, patch_artist=True, widths=0.6,
                    medianprops=dict(color=COLORS['text'], linewidth=2),
                    whiskerprops=dict(color=COLORS['text3']),
                    capprops=dict(color=COLORS['text3']))

    for patch in bp['boxes']:
        patch.set_facecolor(COLORS['cyan'] + '44')
        patch.set_edgecolor(COLORS['cyan'])

    ax.set_ylabel('RMS Vibration (m/s²)')
    ax.set_title('RMS Distribution by Rider — Phone/Bike Variance')
    ax.grid(True, axis='y', alpha=0.3)
    plt.tight_layout()
    plt.savefig(os.path.join(outdir, 'multi_rider_comparison.png'), dpi=150)
    plt.close()
    print(f"  📊 Saved: multi_rider_comparison.png")


def analyze(segments_path, raw_path=None, outdir='./analysis'):
    """Run full analysis."""
    os.makedirs(outdir, exist_ok=True)
    setup_plot_style()

    print(f"\n  Loading: {segments_path}")
    segments = load_segments(segments_path)

    raw = None
    if raw_path:
        print(f"  Loading: {raw_path}")
        raw = load_raw(raw_path)

    print_summary(segments, raw)

    print(f"\n  Generating charts → {outdir}/")
    plot_rms_by_tag(segments, outdir)
    plot_rms_timeline(segments, outdir)
    plot_quality_distribution(segments, outdir)
    plot_rms_histogram(segments, outdir)
    if raw is not None:
        plot_speed_vs_rms(raw, outdir)
    plot_multi_rider(segments, outdir)

    print(f"\n  ✅ Analysis complete!\n")


def analyze_directory(dirpath, outdir='./analysis'):
    """Find and combine all segment CSVs in a directory."""
    segment_files = glob.glob(os.path.join(dirpath, '*segment*csv'))
    raw_files = glob.glob(os.path.join(dirpath, '*raw*csv'))

    if not segment_files:
        print(f"  No segment CSV files found in {dirpath}")
        return

    print(f"\n  Found {len(segment_files)} segment file(s), {len(raw_files)} raw file(s)")

    # Combine all segment files
    all_segments = pd.concat([load_segments(f) for f in segment_files], ignore_index=True)

    # Combine all raw files if present
    all_raw = None
    if raw_files:
        all_raw = pd.concat([load_raw(f) for f in raw_files], ignore_index=True)

    # Save combined
    combined_path = os.path.join(outdir, 'combined_segments.csv')
    os.makedirs(outdir, exist_ok=True)
    all_segments.to_csv(combined_path, index=False)
    print(f"  Combined → {combined_path}")

    analyze(combined_path, raw_path=None, outdir=outdir)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Tarmoto Ride Data Analyzer')
    parser.add_argument('segments', nargs='?', help='Segments CSV file')
    parser.add_argument('raw', nargs='?', help='Raw data CSV file (optional)')
    parser.add_argument('--dir', help='Directory containing CSV files from multiple riders')
    parser.add_argument('--out', default='./analysis', help='Output directory (default: ./analysis)')

    args = parser.parse_args()

    if args.dir:
        analyze_directory(args.dir, args.out)
    elif args.segments:
        analyze(args.segments, args.raw, args.out)
    else:
        parser.print_help()
        print("\n  Example:")
        print("    python analyze_ride.py tarmoto_segments_Martin_2026-04-12.csv")
        print("    python analyze_ride.py --dir ./rides/")
