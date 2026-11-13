import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsSimulatorService } from './metrics-simulator.service.js';
import { AlertEvaluatorService } from './alert-evaluator.service.js';

@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsSimulatorService, AlertEvaluatorService],
})
export class MetricsModule {}
