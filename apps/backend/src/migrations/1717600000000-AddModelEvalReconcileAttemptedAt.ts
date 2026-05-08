import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #496 — adds an indexed claim column to `model_eval_samples`
 * so the reconcile job can do bounded O(log n) work even on a large
 * pending backlog (codex P2 review).
 *
 * The previous candidate-selection strategy was either:
 *
 *   - unbounded (no LIMIT — joined every gross-qualified row to
 *     surface_readings every tick), or
 *   - FIFO LIMIT N (still starves newer rows when the head of queue
 *     is dominated by LOO-ineligible same-rider-repeat rows), or
 *   - ORDER BY RANDOM() LIMIT N (still requires a full scan + sort
 *     of the gross-qualified pending set before the cap applies).
 *
 * This migration introduces a `last_reconcile_attempt_at` timestamp
 * that the reconcile job updates for every candidate it inspects.
 * The new partial index `idx_model_eval_samples_pending` on
 * `(last_reconcile_attempt_at NULLS FIRST, road_segment_id)
 * WHERE reconciled_at IS NULL` lets the job index-range-scan the N
 * least-recently-attempted pending rows without sorting the whole
 * pending set: the index already orders rows correctly, so
 * `LIMIT N` reads exactly N entries.
 *
 * Rows never inspected (newly created) sort first via NULLS FIRST,
 * so newer LOO-eligible samples are always reconciled before
 * permanently un-reconcilable rows that have been cycled to the back
 * of the queue. Permanently un-reconcilable rows are eventually
 * touched again — but only after every never-attempted row has been
 * — so they don't starve newer reconcilable work.
 *
 * The old `idx_model_eval_samples_pending` (on `road_segment_id`
 * partial) is dropped — the new index can serve any query that
 * filters by `reconciled_at IS NULL` and the segment FK lookup is
 * still cheap because the index includes `road_segment_id` as a
 * trailing column.
 */
export class AddModelEvalReconcileAttemptedAt1717600000000 implements MigrationInterface {
  name = 'AddModelEvalReconcileAttemptedAt1717600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE model_eval_samples
        ADD COLUMN IF NOT EXISTS last_reconcile_attempt_at TIMESTAMPTZ NULL;
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_model_eval_samples_pending`,
    );

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_model_eval_samples_pending
        ON model_eval_samples(last_reconcile_attempt_at NULLS FIRST, road_segment_id)
        WHERE reconciled_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_model_eval_samples_pending`,
    );

    // Restore the original pending index from migration #1717500000000.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_model_eval_samples_pending
        ON model_eval_samples(road_segment_id)
        WHERE reconciled_at IS NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE model_eval_samples
        DROP COLUMN IF EXISTS last_reconcile_attempt_at;
    `);
  }
}
