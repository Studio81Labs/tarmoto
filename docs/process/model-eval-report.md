# Tarmoto — Model Evaluation Snapshot

This file is a placeholder rendering. The live snapshot is served by
the backend at `GET /api/v1/model-eval/report.md` (issue #496) —
point a cron task at it to keep this file fresh, or paste the
response into this document at each release boundary.

The metrics defined here (24h dangerous-misclass rate, adjacent
accuracy, MAE, cross-device/bike agreement) are described in
[`docs/ML_MODEL_SPEC.md`](../ML_MODEL_SPEC.md) §7 and tracked by
[`apps/backend/src/modules/model-eval`](../../apps/backend/src/modules/model-eval).
The offline counterpart is in
[`tools/ml-eval`](../../tools/ml-eval).

## How to refresh

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://api.tarmoto.example/api/v1/model-eval/report.md \
     > docs/process/model-eval-report.md
```

## Spec gates

| Metric                     | Target | Where it's enforced                       |
| -------------------------- | ------ | ----------------------------------------- |
| Weighted F1                | > 0.80 | `tools/ml-eval/ci_gate.py` (offline only) |
| Adjacent accuracy          | > 0.95 | offline + runtime gauge                   |
| Confusion between extremes | < 0.02 | offline only                              |
| MAE                        | < 0.50 | offline + runtime gauge                   |
| Surface type accuracy      | > 0.85 | offline only                              |
| Cross-device agreement     | > 0.80 | offline + runtime weekly job              |
| Cross-bike agreement       | > 0.75 | offline + runtime weekly job              |
| Dangerous misclass rate    | < 0.01 | offline + runtime alert (>0.015)          |
