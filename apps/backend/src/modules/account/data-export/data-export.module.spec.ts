import 'reflect-metadata';
import { DataExportModule } from './data-export.module.js';
import { DataExportProcessor } from './data-export.processor.js';

/**
 * Static check — guards a real Nest DI bug.
 *
 * `JobsModule.DataExportQueueProcessor` injects `DataExportProcessor`
 * (the in-process bundle-assembly worker) and runs it as a queued job.
 * For Nest's DI to resolve that injection across module boundaries,
 * `DataExportModule` MUST list `DataExportProcessor` in its `exports`
 * array. Without it, the worker bootstraps and crashes with
 * "can't resolve dependencies of DataExportQueueProcessor".
 *
 * This test reads the Nest module metadata directly so the regression
 * fails in unit-test land instead of at runtime in prod.
 */
describe('DataExportModule', () => {
  it('exports DataExportProcessor so the BullMQ worker in JobsModule can inject it', () => {
    const exports = Reflect.getMetadata(
      'exports',
      DataExportModule,
    ) as unknown[];
    expect(exports).toBeDefined();
    expect(exports).toContain(DataExportProcessor);
  });
});
