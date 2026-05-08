# Tarmoto — Offline ML Evaluation

Tools for grading the road-quality classifier against the
[`docs/ML_MODEL_SPEC.md`](../../docs/ML_MODEL_SPEC.md) §7 launch
targets, plus a CI gate that fails model-retraining PRs that miss
those targets.

The runtime equivalent (online sampling, dangerous-misclass alert,
cross-device/bike agreement) lives in
[`apps/backend/src/modules/model-eval/`](../../apps/backend/src/modules/model-eval).
Both share `SPEC_TARGETS` so the offline gate and the production
alert use identical thresholds.

## Files

| File           | Purpose                                                            |
| -------------- | ------------------------------------------------------------------ |
| `eval.py`      | Reads `predictions.csv`, writes `report.json`.                     |
| `ci_gate.py`   | Reads `report.json`, exits non-zero if any spec target was missed. |
| `test_eval.py` | `python -m unittest`-runnable unit tests, no third-party deps.     |

## Inputs

`eval.py` consumes a `predictions.csv` with columns:

```
road_segment_id,device_family,bike_type,predicted_quality,truth_quality,predicted_surface,truth_surface
```

- `predicted_quality` / `truth_quality`: integers in `1..5`
  (1 = Very Poor … 5 = Excellent, per spec §5.3).
- `device_family` / `bike_type` / `predicted_surface` / `truth_surface`:
  optional strings. Cross-bucket agreement and surface accuracy are
  reported as `null` when the column is absent.

The training pipeline is responsible for the spec §5.4 split-by-road
constraint (no `road_segment_id` in both train and test). This script
only sees the held-out test set.

## Workflow

```bash
# Run after a training pipeline emits predictions.csv:
python tools/ml-eval/eval.py \
    --predictions out/predictions.csv \
    --output out/report.json

# Gate the PR:
python tools/ml-eval/ci_gate.py --report out/report.json
```

`report.json` ships with model retraining PRs (the repo PR template
calls this out under "Contract / Schema / Docs Impact"). The runtime
metrics endpoint at `/model-eval/metrics` exposes the same numbers
computed against the live aggregate truth (spec §8.3).

## Strict mode

`ci_gate.py --strict` rejects reports whose `cross_device_agreement`
or `cross_bike_agreement` is `null`. Use this once the data
collection has accumulated enough device and bike diversity to make
the agreement scores meaningful (post phase 2 of spec §5.1). During
phase 1 (founder rides only) leave it off so a thin test set doesn't
fail CI for cross-bucket reasons that aren't really model defects.

## Running the tests

```bash
cd tools/ml-eval
python -m unittest discover -p 'test_*.py'
```

No `pytest` or `numpy` is required — the script uses only the Python
3.11 standard library so the same image the backend CI uses can run
this gate.
