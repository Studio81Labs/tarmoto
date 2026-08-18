import { Controller, Get } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Service banner' })
  getHello(): string {
    return this.appService.getHello();
  }

  // Lightweight liveness probe used by the ALB target group, the
  // ECS container health check, and the post-deploy smoke test.
  // Intentionally cheap — no DB or Redis hop. See `/jobs/health`
  // for the deeper readiness signal that exercises BullMQ workers.
  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe' })
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
