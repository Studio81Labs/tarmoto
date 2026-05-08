#!/usr/bin/env python3
"""CI gate for model retraining PRs (issue #496).

Reads the JSON report produced by `eval.py` and exits non-zero when
any spec target from `docs/ML_MODEL_SPEC.md` section 7 is missed.

Usage:

  python tools/ml-eval/ci_gate.py --report report.json
  python tools/ml-eval/ci_gate.py --report report.json --strict

In `--strict` mode the cross-device/cross-bike agreement metrics
are required (script fails when they're null). Default mode lets
those be `null` because the founder-rides phase doesn't have enough
device/bike diversity for them to be meaningful yet (spec section
5.1 phase 1).
"""

from __future__ import annotations

import argparse
import json
import sys


# Mirrors `apps/backend/src/modules/model-eval/model-eval.constants.ts`
# so the offline gate and the runtime alert use the same numbers.
SPEC_TARGETS = {
    "weighted_f1_min": 0.80,
    "adjacent_accuracy_min": 0.95,
    "confusion_between_extremes_max": 0.02,
    "mae_max": 0.50,
    "surface_type_accuracy_min": 0.85,
    "cross_device_agreement_min": 0.80,
    "cross_bike_agreement_min": 0.75,
    "dangerous_misclass_rate_max": 0.01,
}


def check(report: dict, *, strict: bool) -> list[str]:
    failures: list[str] = []

    def ge(metric: str, threshold: float) -> None:
        value = report.get(metric)
        if value is None:
            if strict:
                failures.append(f"{metric}=null (strict mode requires a value)")
            return
        if value < threshold:
            failures.append(f"{metric}={value:.4f} < target {threshold:.4f}")

    def le(metric: str, threshold: float) -> None:
        value = report.get(metric)
        if value is None:
            if strict:
                failures.append(f"{metric}=null (strict mode requires a value)")
            return
        if value > threshold:
            failures.append(f"{metric}={value:.4f} > target {threshold:.4f}")

    ge("weighted_f1", SPEC_TARGETS["weighted_f1_min"])
    ge("adjacent_accuracy", SPEC_TARGETS["adjacent_accuracy_min"])
    le(
        "confusion_between_extremes",
        SPEC_TARGETS["confusion_between_extremes_max"],
    )
    le("mae", SPEC_TARGETS["mae_max"])
    ge(
        "surface_type_accuracy",
        SPEC_TARGETS["surface_type_accuracy_min"],
    )
    ge(
        "cross_device_agreement",
        SPEC_TARGETS["cross_device_agreement_min"],
    )
    ge(
        "cross_bike_agreement",
        SPEC_TARGETS["cross_bike_agreement_min"],
    )
    le(
        "dangerous_misclass_rate",
        SPEC_TARGETS["dangerous_misclass_rate_max"],
    )
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Gate model retraining PRs.")
    parser.add_argument("--report", required=True, help="Path to report.json")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Treat null cross-device/cross-bike scores as failures.",
    )
    args = parser.parse_args(argv)

    with open(args.report, encoding="utf-8") as fh:
        report = json.load(fh)

    failures = check(report, strict=args.strict)
    if failures:
        print("CI gate FAILED:")
        for line in failures:
            print(f"  - {line}")
        return 1
    print("CI gate passed: all spec targets met.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
