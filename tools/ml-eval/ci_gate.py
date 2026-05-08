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
import math
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


# Metrics whose `null` is tolerated in non-strict mode. The two
# diversity gauges depend on data the founder-rides phase doesn't
# have yet (spec section 5.1 phase 1) — null is "not measurable in
# this set", not "model failed". Every other launch-gating metric
# is REQUIRED to be present: a `null` for `weighted_f1`,
# `adjacent_accuracy`, `surface_type_accuracy`, etc., means the
# eval pipeline is broken or the predictions.csv is missing
# columns, and either way the gate must fail so a bad report can't
# slip through.
_NULL_TOLERATED_NON_STRICT = frozenset(
    {"cross_device_agreement", "cross_bike_agreement"}
)


def check(report: dict, *, strict: bool) -> list[str]:
    failures: list[str] = []

    def fail_on_invalid(metric: str) -> bool:
        # Returns True when the caller has already recorded a failure
        # (or the value was tolerated and there's nothing to compare
        # against). Catches three classes of broken inputs:
        #
        #   - missing key                — eval pipeline didn't write it;
        #   - explicit null              — measurable-but-not-measured
        #                                  (tolerated for the two
        #                                  diversity metrics in non-
        #                                  strict mode, see allowlist);
        #   - NaN / +Inf / -Inf / non-num —
        #     these MUST fail regardless of strictness. Python's
        #     `json.load` accepts NaN by default, and `NaN < t` and
        #     `NaN > t` both evaluate to False — without this guard
        #     a broken report containing NaN for a required metric
        #     would silently pass the launch gate.
        if metric not in report:
            if strict or metric not in _NULL_TOLERATED_NON_STRICT:
                failures.append(
                    f"{metric}=missing (required metric missing from report)"
                )
            return True
        value = report[metric]
        if value is None:
            if strict or metric not in _NULL_TOLERATED_NON_STRICT:
                failures.append(
                    f"{metric}=null (required metric missing from report)"
                )
            return True
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            # `bool` is a subclass of `int`; reject it explicitly so a
            # `true`/`false` in the JSON doesn't sneak past as 0 or 1.
            failures.append(f"{metric}={value!r} (must be a finite number)")
            return True
        if isinstance(value, float) and not math.isfinite(value):
            failures.append(f"{metric}={value!r} (must be a finite number)")
            return True
        return False

    def gt(metric: str, threshold: float) -> None:
        # Spec section 7 uses strict "> threshold" for min targets,
        # so a value landing exactly on the bar must fail (codex
        # review). Example: spec says "Weighted F1 > 0.80"; a
        # report at 0.80 has not cleared the launch gate, so the
        # CI gate refuses it.
        if fail_on_invalid(metric):
            return
        value = report[metric]
        if value <= threshold:
            failures.append(f"{metric}={value:.4f} <= target {threshold:.4f}")

    def lt(metric: str, threshold: float) -> None:
        # Spec section 7 uses strict "< threshold" for max targets;
        # a report exactly on the bar (e.g. dangerous_misclass_rate
        # = 0.01 against the < 0.01 spec target) must fail.
        if fail_on_invalid(metric):
            return
        value = report[metric]
        if value >= threshold:
            failures.append(f"{metric}={value:.4f} >= target {threshold:.4f}")

    gt("weighted_f1", SPEC_TARGETS["weighted_f1_min"])
    gt("adjacent_accuracy", SPEC_TARGETS["adjacent_accuracy_min"])
    lt(
        "confusion_between_extremes",
        SPEC_TARGETS["confusion_between_extremes_max"],
    )
    lt("mae", SPEC_TARGETS["mae_max"])
    gt(
        "surface_type_accuracy",
        SPEC_TARGETS["surface_type_accuracy_min"],
    )
    gt(
        "cross_device_agreement",
        SPEC_TARGETS["cross_device_agreement_min"],
    )
    gt(
        "cross_bike_agreement",
        SPEC_TARGETS["cross_bike_agreement_min"],
    )
    lt(
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
