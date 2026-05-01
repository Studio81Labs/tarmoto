import { Test } from '@nestjs/testing';
import { JobsController } from './jobs.controller.js';
import { QueueHealthService } from './queue-health.service.js';
import { JOBS_CONFIG_TOKEN, type JobsConfig } from './jobs.tokens.js';

describe('JobsController', () => {
  let controller: JobsController;
  let health: { snapshot: jest.Mock };
  const config: JobsConfig = {
    connection: { host: 'localhost', port: 6379 },
    workersEnabled: true,
  };

  beforeEach(async () => {
    health = {
      snapshot: jest.fn().mockResolvedValue({
        generated_at: '2026-04-30T00:00:00Z',
        workers_enabled: true,
        queues: [],
      }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [JobsController],
      providers: [
        { provide: QueueHealthService, useValue: health },
        { provide: JOBS_CONFIG_TOKEN, useValue: config },
      ],
    }).compile();
    controller = moduleRef.get(JobsController);
  });

  it('GET /jobs/health forwards workers_enabled from the resolved config so split deployments are visible', async () => {
    await controller.getHealth();
    expect(health.snapshot).toHaveBeenCalledWith(true);
  });

  it('returns the QueueHealthSnapshot the service produced', async () => {
    const out = await controller.getHealth();
    expect(out).toMatchObject({
      generated_at: '2026-04-30T00:00:00Z',
      workers_enabled: true,
      queues: [],
    });
  });
});
