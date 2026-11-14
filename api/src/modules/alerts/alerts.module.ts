import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller.js';
import { AlertsService } from './alerts.service.js';
import { AlertThresholdsController } from './alert-thresholds.controller.js';
import { AlertThresholdsService } from './alert-thresholds.service.js';

@Module({
  controllers: [AlertsController, AlertThresholdsController],
  providers: [AlertsService, AlertThresholdsService],
  // The metrics module's AlertEvaluatorService reads thresholds through this service.
  exports: [AlertThresholdsService],
})
export class AlertsModule {}
