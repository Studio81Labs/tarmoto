import { Controller, Get, Header, HttpStatus, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard.js';
import { ModelEvalService } from './model-eval.service.js';
import { ModelEvalMetricsResponseDto } from './dto/model-eval-metrics.dto.js';

@ApiTags('model-eval')
@Controller('model-eval')
export class ModelEvalController {
  constructor(private readonly service: ModelEvalService) {}

  /**
   * Snapshot of the rolling 24h ML evaluation metrics (issue #496).
   * Auth-guarded so the data isn't scraped anonymously, but
   * intentionally not gated behind a role check — the repo doesn't
   * have an admin role today and the metrics are aggregate counters
   * over de-identified telemetry. The throttler is skipped because
   * the on-call dashboard polls this on a tight cadence and would
   * otherwise burn through the per-IP budget.
   */
  @Get('metrics')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @SkipThrottle()
  @ApiOperation({
    summary: '24h rolling ML evaluation snapshot',
    description:
      'Per-`model_version` dangerous-misclass / adjacent-accuracy / ' +
      'MAE gauges plus the latest cross-device and cross-bike ' +
      'agreement scores. Spec §7. Returns an empty `versions` array ' +
      'when no samples have been reconciled in the last 24h.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: ModelEvalMetricsResponseDto })
  async metrics(): Promise<ModelEvalMetricsResponseDto> {
    return this.service.getMetrics();
  }

  /**
   * Markdown rendering of the same snapshot, suitable for pasting
   * into `docs/process/model-eval-report.md` or for a non-engineer
   * to read in their browser. Spec acceptance criteria: "A read-only
   * admin endpoint or scheduled report writes the latest values into
   * a Markdown summary in `docs/process/`".
   */
  @Get('report.md')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @SkipThrottle()
  @Header('content-type', 'text/markdown; charset=utf-8')
  @ApiProduces('text/markdown')
  @ApiOperation({
    summary: 'Markdown rendering of the model-eval snapshot',
    description:
      'Same data as `/model-eval/metrics` rendered as a stable ' +
      'Markdown report. Format is intentionally diff-friendly so a ' +
      'cron task can write it into `docs/process/model-eval-report.md`.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  async report(): Promise<string> {
    return this.service.renderMarkdownReport();
  }
}
