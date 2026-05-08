import { Test } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { ModelEvalController } from './model-eval.controller.js';
import { ModelEvalService } from './model-eval.service.js';

describe('ModelEvalController', () => {
  let controller: ModelEvalController;
  let service: { getMetrics: jest.Mock; renderMarkdownReport: jest.Mock };

  beforeEach(async () => {
    service = {
      getMetrics: jest.fn(),
      renderMarkdownReport: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ModelEvalController],
      providers: [
        { provide: ModelEvalService, useValue: service },
        ...authGuardTestProviders,
      ],
    }).compile();
    controller = moduleRef.get(ModelEvalController);
  });

  it('proxies /metrics to the service snapshot', async () => {
    const snapshot = {
      window_hours: 24,
      generated_at: '2026-05-08T00:00:00.000Z',
      versions: [],
      cross_device_agreement: {
        computed_at: null,
        agreement_score: null,
        segments_evaluated: 0,
      },
      cross_bike_agreement: {
        computed_at: null,
        agreement_score: null,
        segments_evaluated: 0,
      },
    };
    service.getMetrics.mockResolvedValue(snapshot);

    const result = await controller.metrics();
    expect(service.getMetrics).toHaveBeenCalledTimes(1);
    expect(result).toBe(snapshot);
  });

  it('proxies /report.md to the markdown renderer', async () => {
    service.renderMarkdownReport.mockResolvedValue('# Tarmoto');
    const result = await controller.report();
    expect(service.renderMarkdownReport).toHaveBeenCalledTimes(1);
    expect(result).toBe('# Tarmoto');
  });
});
