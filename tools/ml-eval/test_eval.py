"""Unit tests for the offline ML evaluation script (issue #496).

Runs without any third-party deps so CI doesn't need a Python venv:

  python -m unittest discover -s tools/ml-eval -p 'test_*.py'
"""

from __future__ import annotations

import io
import json
import os
import tempfile
import unittest

from eval import (  # type: ignore[import-not-found]
    Sample,
    adjacent_accuracy,
    confusion_between_extremes,
    cross_bucket_agreement,
    dangerous_misclass_rate,
    evaluate,
    load_samples,
    mean_absolute_error,
    surface_type_accuracy,
    weighted_f1,
)
from ci_gate import check  # type: ignore[import-not-found]


def perfect_samples() -> list[Sample]:
    return [
        Sample(
            road_segment_id=f"seg-{i}",
            predicted_quality=q,
            truth_quality=q,
            device_family="iphone",
            bike_type="sport",
            predicted_surface="asphalt",
            truth_surface="asphalt",
        )
        for i, q in enumerate([5, 4, 3, 2, 1, 5, 4, 3, 2, 1])
    ]


class WeightedF1Tests(unittest.TestCase):
    def test_perfect_predictions_yield_one(self) -> None:
        self.assertAlmostEqual(weighted_f1(perfect_samples()), 1.0, places=4)

    def test_all_wrong_predictions_yield_zero(self) -> None:
        samples = [
            Sample(road_segment_id=f"s{i}", predicted_quality=1, truth_quality=5)
            for i in range(5)
        ]
        self.assertEqual(weighted_f1(samples), 0.0)


class AdjacentAccuracyTests(unittest.TestCase):
    def test_within_one_class_counts_as_correct(self) -> None:
        samples = [
            Sample(road_segment_id="s1", predicted_quality=4, truth_quality=5),
            Sample(road_segment_id="s2", predicted_quality=5, truth_quality=5),
            Sample(road_segment_id="s3", predicted_quality=2, truth_quality=5),
        ]
        # Adjacents: 4 vs 5 ok, 5 vs 5 ok, 2 vs 5 fail -> 2/3
        self.assertAlmostEqual(adjacent_accuracy(samples), 2 / 3, places=4)


class ExtremeConfusionTests(unittest.TestCase):
    def test_counts_5_vs_1_both_directions(self) -> None:
        samples = [
            Sample(road_segment_id="s1", predicted_quality=5, truth_quality=1),
            Sample(road_segment_id="s2", predicted_quality=1, truth_quality=5),
            Sample(road_segment_id="s3", predicted_quality=4, truth_quality=4),
        ]
        self.assertAlmostEqual(
            confusion_between_extremes(samples), 2 / 3, places=4
        )


class MAETests(unittest.TestCase):
    def test_mean_absolute_error_uses_score_distance(self) -> None:
        samples = [
            Sample(road_segment_id="s1", predicted_quality=5, truth_quality=4),
            Sample(road_segment_id="s2", predicted_quality=2, truth_quality=4),
        ]
        # |5-4| + |2-4| = 1 + 2 = 3 / 2 = 1.5
        self.assertEqual(mean_absolute_error(samples), 1.5)


class DangerousMisclassTests(unittest.TestCase):
    def test_predicted_excellent_truth_very_poor_is_dangerous(self) -> None:
        samples = [
            Sample(road_segment_id="s1", predicted_quality=5, truth_quality=1),
            Sample(road_segment_id="s2", predicted_quality=4, truth_quality=2),
            Sample(road_segment_id="s3", predicted_quality=4, truth_quality=4),
        ]
        # 2 dangerous out of 3
        self.assertAlmostEqual(
            dangerous_misclass_rate(samples), 2 / 3, places=4
        )


class SurfaceAccuracyTests(unittest.TestCase):
    def test_returns_none_when_no_surface_columns(self) -> None:
        samples = [
            Sample(
                road_segment_id="s1",
                predicted_quality=4,
                truth_quality=4,
                predicted_surface=None,
                truth_surface=None,
            ),
        ]
        self.assertIsNone(surface_type_accuracy(samples))

    def test_simple_match_ratio(self) -> None:
        samples = [
            Sample(
                road_segment_id="s1",
                predicted_quality=4,
                truth_quality=4,
                predicted_surface="asphalt",
                truth_surface="asphalt",
            ),
            Sample(
                road_segment_id="s2",
                predicted_quality=3,
                truth_quality=3,
                predicted_surface="gravel",
                truth_surface="asphalt",
            ),
        ]
        self.assertAlmostEqual(surface_type_accuracy(samples), 0.5, places=4)

    def test_blank_prediction_against_populated_truth_counts_as_miss(
        self,
    ) -> None:
        """Codex review: previously the function filtered rows with a
        blank `predicted_surface` out of the denominator, so a model
        could leave hard predictions blank and still pass the >0.85
        target on the easy subset. Now those rows count as MISSES."""
        samples = [
            Sample(
                road_segment_id="s1",
                predicted_quality=4,
                truth_quality=4,
                predicted_surface="asphalt",
                truth_surface="asphalt",
            ),
            Sample(
                road_segment_id="s2",
                predicted_quality=3,
                truth_quality=3,
                predicted_surface=None,
                truth_surface="cobblestone",
            ),
        ]
        # Without the fix this would be 1.0 (one gradeable row, all
        # correct). With the fix the blank prediction counts as a
        # miss → 1/2.
        self.assertAlmostEqual(surface_type_accuracy(samples), 0.5, places=4)

    def test_truth_missing_is_excluded_not_failed(self) -> None:
        """Rows without `truth_surface` are still excluded — there is
        no ground truth to grade against, so they're "not measurable"
        rather than "wrong"."""
        samples = [
            Sample(
                road_segment_id="s1",
                predicted_quality=4,
                truth_quality=4,
                predicted_surface="asphalt",
                truth_surface="asphalt",
            ),
            Sample(
                road_segment_id="s2",
                predicted_quality=3,
                truth_quality=3,
                predicted_surface="asphalt",
                truth_surface=None,
            ),
        ]
        self.assertAlmostEqual(surface_type_accuracy(samples), 1.0, places=4)


class CrossBucketAgreementTests(unittest.TestCase):
    def test_skips_segments_with_fewer_than_three_buckets(self) -> None:
        samples = [
            Sample(
                road_segment_id="s1",
                predicted_quality=4,
                truth_quality=4,
                device_family="iphone",
            ),
            Sample(
                road_segment_id="s1",
                predicted_quality=4,
                truth_quality=4,
                device_family="samsung",
            ),
        ]
        self.assertIsNone(
            cross_bucket_agreement(samples, "device_family", min_distinct=3)
        )

    def test_three_devices_within_one_class_score_one(self) -> None:
        samples = [
            Sample(
                road_segment_id="s1",
                predicted_quality=4,
                truth_quality=4,
                device_family="iphone",
            ),
            Sample(
                road_segment_id="s1",
                predicted_quality=5,
                truth_quality=5,
                device_family="samsung",
            ),
            Sample(
                road_segment_id="s1",
                predicted_quality=4,
                truth_quality=4,
                device_family="pixel",
            ),
        ]
        self.assertAlmostEqual(
            cross_bucket_agreement(samples, "device_family"), 1.0, places=4
        )


class LoadSamplesTests(unittest.TestCase):
    def test_round_trip_csv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "predictions.csv")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(
                    "road_segment_id,predicted_quality,truth_quality,"
                    "device_family,bike_type,predicted_surface,truth_surface\n"
                )
                fh.write("s1,4,5,iphone,sport,asphalt,asphalt\n")
                fh.write("s2,2,2,samsung,adv,gravel,gravel\n")
            samples = load_samples(path)
            self.assertEqual(len(samples), 2)
            self.assertEqual(samples[0].road_segment_id, "s1")
            self.assertEqual(samples[0].predicted_quality, 4)
            self.assertEqual(samples[1].truth_surface, "gravel")

    def test_blank_road_segment_id_rejected(self) -> None:
        """Codex review: an upstream export that writes blank
        `road_segment_id` would collapse unrelated roads into one
        synthetic segment for cross-bucket agreement, producing a
        plausible score from rows that do not share a road at all."""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "predictions.csv")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("road_segment_id,predicted_quality,truth_quality\n")
                fh.write("s1,4,5\n")
                fh.write(",2,2\n")  # blank id on line 3
            with self.assertRaises(SystemExit) as cm:
                load_samples(path)
            self.assertIn("line 3", str(cm.exception))
            self.assertIn("road_segment_id", str(cm.exception))

    def test_whitespace_road_segment_id_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "predictions.csv")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("road_segment_id,predicted_quality,truth_quality\n")
                fh.write("   ,4,5\n")
            with self.assertRaises(SystemExit) as cm:
                load_samples(path)
            self.assertIn("road_segment_id", str(cm.exception))

    def test_whitespace_optional_bucket_columns_become_none(self) -> None:
        """Codex review: whitespace `device_family` / `bike_type` /
        surface columns must coerce to None so they don't get treated
        as real buckets / predictions in the launch metrics."""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "predictions.csv")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(
                    "road_segment_id,predicted_quality,truth_quality,"
                    "device_family,bike_type,predicted_surface,truth_surface\n"
                )
                fh.write("s1,4,5, ,  ,   , \n")
            samples = load_samples(path)
            self.assertEqual(len(samples), 1)
            self.assertIsNone(samples[0].device_family)
            self.assertIsNone(samples[0].bike_type)
            self.assertIsNone(samples[0].predicted_surface)
            self.assertIsNone(samples[0].truth_surface)


class EvaluateAndGateTests(unittest.TestCase):
    def test_perfect_run_passes_ci_gate(self) -> None:
        report = evaluate(perfect_samples()).to_json()
        # Perfect predictions: all metrics at the ideal end of their
        # range, but cross-bucket agreement requires >=3 distinct
        # buckets so it returns None for our single-family fixture.
        self.assertEqual(report["weighted_f1"], 1.0)
        self.assertEqual(report["dangerous_misclass_rate"], 0.0)
        # In non-strict mode, null cross-device/bike scores are
        # tolerated and the gate passes.
        failures = check(report, strict=False)
        self.assertEqual(failures, [])

    def test_failing_metrics_are_reported(self) -> None:
        bad = {
            "weighted_f1": 0.50,
            "adjacent_accuracy": 0.80,
            "confusion_between_extremes": 0.05,
            "mae": 1.5,
            "surface_type_accuracy": 0.50,
            "cross_device_agreement": 0.40,
            "cross_bike_agreement": 0.30,
            "dangerous_misclass_rate": 0.05,
        }
        failures = check(bad, strict=True)
        self.assertEqual(len(failures), 8)

    def test_null_required_metric_fails_default_mode(self) -> None:
        """Codex review: in non-strict mode, only the cross-device /
        cross-bike diversity metrics may be null. A null
        `surface_type_accuracy` (or any other launch-gating metric)
        must still fail the gate — otherwise a predictions.csv
        missing the surface columns would silently bypass the 0.85
        target."""
        report = {
            "weighted_f1": 0.90,
            "adjacent_accuracy": 0.96,
            "confusion_between_extremes": 0.01,
            "mae": 0.30,
            "surface_type_accuracy": None,
            "cross_device_agreement": None,
            "cross_bike_agreement": None,
            "dangerous_misclass_rate": 0.005,
        }
        failures = check(report, strict=False)
        self.assertEqual(len(failures), 1)
        self.assertIn("surface_type_accuracy=null", failures[0])

    def test_null_diversity_metrics_tolerated_in_default_mode(self) -> None:
        report = {
            "weighted_f1": 0.90,
            "adjacent_accuracy": 0.96,
            "confusion_between_extremes": 0.01,
            "mae": 0.30,
            "surface_type_accuracy": 0.90,
            "cross_device_agreement": None,
            "cross_bike_agreement": None,
            "dangerous_misclass_rate": 0.005,
        }
        self.assertEqual(check(report, strict=False), [])

    def test_strict_mode_rejects_any_null(self) -> None:
        report = {
            "weighted_f1": 0.90,
            "adjacent_accuracy": 0.96,
            "confusion_between_extremes": 0.01,
            "mae": 0.30,
            "surface_type_accuracy": 0.90,
            "cross_device_agreement": None,
            "cross_bike_agreement": None,
            "dangerous_misclass_rate": 0.005,
        }
        failures = check(report, strict=True)
        self.assertEqual(len(failures), 2)

    def test_nan_required_metric_fails_default_mode(self) -> None:
        """Codex review: Python's `json.load` accepts NaN by default,
        and `NaN < threshold` / `NaN > threshold` are both False, so
        a broken report containing NaN for a required metric would
        silently pass without an explicit non-finite guard."""
        report = {
            "weighted_f1": float("nan"),
            "adjacent_accuracy": 0.96,
            "confusion_between_extremes": 0.01,
            "mae": 0.30,
            "surface_type_accuracy": 0.90,
            "cross_device_agreement": None,
            "cross_bike_agreement": None,
            "dangerous_misclass_rate": 0.005,
        }
        failures = check(report, strict=False)
        self.assertEqual(len(failures), 1)
        self.assertIn("weighted_f1", failures[0])
        self.assertIn("finite number", failures[0])

    def test_inf_required_metric_fails(self) -> None:
        report = {
            "weighted_f1": 0.90,
            "adjacent_accuracy": 0.96,
            "confusion_between_extremes": 0.01,
            "mae": float("inf"),
            "surface_type_accuracy": 0.90,
            "cross_device_agreement": None,
            "cross_bike_agreement": None,
            "dangerous_misclass_rate": 0.005,
        }
        failures = check(report, strict=False)
        self.assertEqual(len(failures), 1)
        self.assertIn("mae", failures[0])

    def test_non_numeric_required_metric_fails(self) -> None:
        report = {
            "weighted_f1": "not-a-number",
            "adjacent_accuracy": 0.96,
            "confusion_between_extremes": 0.01,
            "mae": 0.30,
            "surface_type_accuracy": 0.90,
            "cross_device_agreement": None,
            "cross_bike_agreement": None,
            "dangerous_misclass_rate": 0.005,
        }
        failures = check(report, strict=False)
        self.assertEqual(len(failures), 1)
        self.assertIn("weighted_f1", failures[0])
        self.assertIn("finite number", failures[0])

    def test_nan_diversity_metric_fails_even_in_default_mode(self) -> None:
        """Even though `cross_device_agreement` may legitimately be
        null in non-strict mode, NaN is a different signal — it
        means the eval pipeline produced something nonsensical and
        the gate must fail even for tolerated metrics."""
        report = {
            "weighted_f1": 0.90,
            "adjacent_accuracy": 0.96,
            "confusion_between_extremes": 0.01,
            "mae": 0.30,
            "surface_type_accuracy": 0.90,
            "cross_device_agreement": float("nan"),
            "cross_bike_agreement": None,
            "dangerous_misclass_rate": 0.005,
        }
        failures = check(report, strict=False)
        self.assertEqual(len(failures), 1)
        self.assertIn("cross_device_agreement", failures[0])


if __name__ == "__main__":
    unittest.main()
