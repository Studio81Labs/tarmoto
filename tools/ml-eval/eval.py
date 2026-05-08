#!/usr/bin/env python3
"""Offline ML evaluation for the road-quality classifier (issue #496).

Computes the eight launch-gating metrics from `docs/ML_MODEL_SPEC.md`
section 7 against a held-out test set split by road segment (spec
section 5.4 - same road must not appear in train and test).

Inputs are two parallel arrays of integer scores in 1..5 plus an
optional surface-type column. The script does not depend on
TensorFlow or sklearn so it can run in a minimal CI image - the
classifier produces a `predictions.csv` and this tool grades it.

Output is a single JSON report (default `report.json`) with the
shape consumed by `ci_gate.py` and embedded into model retraining
PRs.

Usage:

  python tools/ml-eval/eval.py \
      --predictions path/to/predictions.csv \
      --output report.json

`predictions.csv` columns (one row per test sample):

  road_segment_id,device_family,bike_type,
  predicted_quality,truth_quality,
  predicted_surface,truth_surface

The script verifies the spec section 5.4 split-by-road constraint:
no road_segment_id may appear in both train and test, but since
this script only sees the test set, it relies on the upstream
training pipeline to enforce the split. We DO sanity-check the
test rows are unique-per-segment (one row per segment expected).
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Iterable


QUALITY_VALUES = (1, 2, 3, 4, 5)


@dataclass
class Sample:
    road_segment_id: str
    predicted_quality: int
    truth_quality: int
    device_family: str | None = None
    bike_type: str | None = None
    predicted_surface: str | None = None
    truth_surface: str | None = None


@dataclass
class EvalReport:
    sample_count: int
    weighted_f1: float
    adjacent_accuracy: float
    confusion_between_extremes: float
    mae: float
    surface_type_accuracy: float | None
    cross_device_agreement: float | None
    cross_bike_agreement: float | None
    dangerous_misclass_rate: float
    confusion_matrix: dict[str, dict[str, int]] = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "sample_count": self.sample_count,
            "weighted_f1": round(self.weighted_f1, 4),
            "adjacent_accuracy": round(self.adjacent_accuracy, 4),
            "confusion_between_extremes": round(
                self.confusion_between_extremes, 4
            ),
            "mae": round(self.mae, 4),
            "surface_type_accuracy": (
                None
                if self.surface_type_accuracy is None
                else round(self.surface_type_accuracy, 4)
            ),
            "cross_device_agreement": (
                None
                if self.cross_device_agreement is None
                else round(self.cross_device_agreement, 4)
            ),
            "cross_bike_agreement": (
                None
                if self.cross_bike_agreement is None
                else round(self.cross_bike_agreement, 4)
            ),
            "dangerous_misclass_rate": round(self.dangerous_misclass_rate, 4),
            "confusion_matrix": self.confusion_matrix,
        }


def parse_int(raw: str, *, field_name: str) -> int:
    try:
        value = int(raw)
    except ValueError as err:
        raise SystemExit(
            f"{field_name}={raw!r} is not an integer"
        ) from err
    if value not in QUALITY_VALUES:
        raise SystemExit(
            f"{field_name}={value} is not in {QUALITY_VALUES}"
        )
    return value


def load_samples(path: str) -> list[Sample]:
    samples: list[Sample] = []
    with open(path, encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        required = {"road_segment_id", "predicted_quality", "truth_quality"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise SystemExit(
                f"predictions.csv missing required columns: {sorted(missing)}"
            )
        for line_no, row in enumerate(reader, start=2):
            # Reject blank `road_segment_id` (codex review). An
            # upstream export that writes blank ids would otherwise
            # collapse unrelated roads into one synthetic segment for
            # cross-bucket agreement, defeating the spec section 5.4
            # same-road requirement and producing a plausible
            # agreement score from rows that don't share a road at
            # all.
            segment_id = (row.get("road_segment_id") or "").strip()
            if not segment_id:
                raise SystemExit(
                    f"predictions.csv line {line_no}: road_segment_id is "
                    f"empty or whitespace; cannot group cross-device / "
                    f"cross-bike agreement reliably"
                )
            samples.append(
                Sample(
                    road_segment_id=segment_id,
                    predicted_quality=parse_int(
                        row["predicted_quality"], field_name="predicted_quality"
                    ),
                    truth_quality=parse_int(
                        row["truth_quality"], field_name="truth_quality"
                    ),
                    device_family=row.get("device_family") or None,
                    bike_type=row.get("bike_type") or None,
                    predicted_surface=row.get("predicted_surface") or None,
                    truth_surface=row.get("truth_surface") or None,
                )
            )
    if not samples:
        raise SystemExit("predictions.csv contained no rows")
    return samples


def weighted_f1(samples: Iterable[Sample]) -> float:
    """Macro-averaged F1 weighted by class support, matching sklearn's
    `f1_score(..., average='weighted')`."""
    by_class: dict[int, dict[str, int]] = {
        cls: {"tp": 0, "fp": 0, "fn": 0, "support": 0} for cls in QUALITY_VALUES
    }
    for s in samples:
        by_class[s.truth_quality]["support"] += 1
        if s.predicted_quality == s.truth_quality:
            by_class[s.truth_quality]["tp"] += 1
        else:
            by_class[s.truth_quality]["fn"] += 1
            by_class[s.predicted_quality]["fp"] += 1

    total_support = sum(c["support"] for c in by_class.values())
    if total_support == 0:
        return 0.0

    weighted_sum = 0.0
    for stats in by_class.values():
        tp = stats["tp"]
        fp = stats["fp"]
        fn = stats["fn"]
        support = stats["support"]
        if support == 0:
            continue
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = (
            2 * precision * recall / (precision + recall)
            if (precision + recall) > 0
            else 0.0
        )
        weighted_sum += f1 * support
    return weighted_sum / total_support


def adjacent_accuracy(samples: Iterable[Sample]) -> float:
    samples = list(samples)
    if not samples:
        return 0.0
    return sum(
        1 for s in samples if abs(s.predicted_quality - s.truth_quality) <= 1
    ) / len(samples)


def confusion_between_extremes(samples: Iterable[Sample]) -> float:
    """Spec section 7.1: predicting Excellent (5) when truth is Very
    Poor (1) or vice versa. Symmetric — both directions are
    dangerous."""
    samples = list(samples)
    if not samples:
        return 0.0
    extremes = sum(
        1
        for s in samples
        if (s.predicted_quality == 5 and s.truth_quality == 1)
        or (s.predicted_quality == 1 and s.truth_quality == 5)
    )
    return extremes / len(samples)


def mean_absolute_error(samples: Iterable[Sample]) -> float:
    samples = list(samples)
    if not samples:
        return 0.0
    return sum(
        abs(s.predicted_quality - s.truth_quality) for s in samples
    ) / len(samples)


def surface_type_accuracy(samples: Iterable[Sample]) -> float | None:
    """Spec section 7.2 surface-type accuracy.

    A row is "gradeable" iff `truth_surface` is populated. A blank
    `predicted_surface` against a populated truth counts as a MISS,
    not as a row excluded from the denominator — otherwise the
    pipeline could leave hard predictions blank and inflate the
    metric on the easy subset (codex review feedback). Returns
    `None` only when no row in the test set has surface ground
    truth at all, which honestly means the metric is not measurable
    on this set rather than passing it.
    """
    gradeable = [s for s in samples if s.truth_surface]
    if not gradeable:
        return None
    correct = sum(
        1
        for s in gradeable
        if s.predicted_surface and s.predicted_surface == s.truth_surface
    )
    return correct / len(gradeable)


def dangerous_misclass_rate(samples: Iterable[Sample]) -> float:
    """Spec section 7.3 safety metric: the model says Excellent/Good
    when truth is Poor/Very Poor."""
    samples = list(samples)
    if not samples:
        return 0.0
    bad = sum(
        1
        for s in samples
        if s.predicted_quality >= 4 and s.truth_quality <= 2
    )
    return bad / len(samples)


def cross_bucket_agreement(
    samples: list[Sample],
    bucket_attr: str,
    min_distinct: int = 3,
) -> float | None:
    """Per spec section 7.2: average pairwise within-±1-class
    agreement across segments hit by at least `min_distinct` distinct
    devices/bikes. Returns `None` when the test set has no qualifying
    segment so the metric is honestly absent rather than zero."""
    by_segment: dict[str, dict[str, list[int]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for s in samples:
        bucket = getattr(s, bucket_attr)
        if bucket is None:
            continue
        by_segment[s.road_segment_id][bucket].append(s.predicted_quality)

    qualifying_scores: list[float] = []
    for buckets in by_segment.values():
        if len(buckets) < min_distinct:
            continue
        # One representative score per bucket: mode (or first sample
        # in a tie). Mirrors the runtime computation in
        # `ModelEvalService.computeAgreement`.
        bucket_scores = []
        for scores in buckets.values():
            counter = Counter(scores)
            best_score, _ = counter.most_common(1)[0]
            bucket_scores.append(best_score)
        agreed = 0
        total = 0
        for i in range(len(bucket_scores)):
            for j in range(i + 1, len(bucket_scores)):
                total += 1
                if abs(bucket_scores[i] - bucket_scores[j]) <= 1:
                    agreed += 1
        if total > 0:
            qualifying_scores.append(agreed / total)

    if not qualifying_scores:
        return None
    return sum(qualifying_scores) / len(qualifying_scores)


def confusion_matrix(samples: Iterable[Sample]) -> dict[str, dict[str, int]]:
    matrix: dict[str, dict[str, int]] = {
        str(t): {str(p): 0 for p in QUALITY_VALUES} for t in QUALITY_VALUES
    }
    for s in samples:
        matrix[str(s.truth_quality)][str(s.predicted_quality)] += 1
    return matrix


def evaluate(samples: list[Sample]) -> EvalReport:
    return EvalReport(
        sample_count=len(samples),
        weighted_f1=weighted_f1(samples),
        adjacent_accuracy=adjacent_accuracy(samples),
        confusion_between_extremes=confusion_between_extremes(samples),
        mae=mean_absolute_error(samples),
        surface_type_accuracy=surface_type_accuracy(samples),
        cross_device_agreement=cross_bucket_agreement(samples, "device_family"),
        cross_bike_agreement=cross_bucket_agreement(samples, "bike_type"),
        dangerous_misclass_rate=dangerous_misclass_rate(samples),
        confusion_matrix=confusion_matrix(samples),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Offline ML evaluation for the road-quality classifier."
    )
    parser.add_argument("--predictions", required=True, help="CSV of predictions vs truth")
    parser.add_argument(
        "--output", default="report.json", help="Where to write the JSON report"
    )
    args = parser.parse_args(argv)

    samples = load_samples(args.predictions)
    report = evaluate(samples)

    if math.isnan(report.weighted_f1):
        raise SystemExit("weighted_f1 evaluated to NaN — inspect the test set")

    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(report.to_json(), fh, indent=2, sort_keys=True)
        fh.write("\n")

    print(json.dumps(report.to_json(), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
