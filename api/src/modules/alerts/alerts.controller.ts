import { Controller, Get, Param, ParseIntPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AlertSeverity, AlertStatus } from '@prisma/client';
import { AlertsService } from './alerts.service.js';
import { ALERT_TYPES } from './alert-metrics.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

// Note: RolesGuard lets a request through when a handler has no @Roles metadata,
// so every handler below declares its roles explicitly (no class-level default).
@ApiTags('alerts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('environments/:envId/alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  @Roles('Admin', 'Devops', 'Viewer')
  @ApiOperation({ summary: 'List alerts of the environment, including resolved ones (newest first)' })
  @ApiQuery({ name: 'serverId', required: false, description: 'Only alerts of this server' })
  @ApiQuery({ name: 'type', required: false, enum: ALERT_TYPES, description: 'Only alerts of this type' })
  @ApiQuery({ name: 'severity', required: false, enum: AlertSeverity, description: 'Only alerts of this severity' })
  @ApiQuery({ name: 'status', required: false, enum: AlertStatus, description: 'Only alerts with this status' })
  @ApiQuery({ name: 'page', required: false, example: 1, description: 'Page number for pagination' })
  @ApiQuery({ name: 'limit', required: false, example: 10, description: 'Number of items per page (max 100)' })
  findAll(
    @Param('envId') envId: string,
    @Query('serverId') serverId?: string,
    @Query('type') type?: string,
    @Query('severity') severity?: string,
    @Query('status') status?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.alertsService.findAll(envId, { serverId, type, severity, status, page, limit });
  }

  @Get(':idAlert')
  @Roles('Admin', 'Devops', 'Viewer')
  @ApiOperation({ summary: 'Get an alert by ID in the selected environment' })
  findOne(@Param('envId') envId: string, @Param('idAlert') idAlert: string) {
    return this.alertsService.findOne(envId, idAlert);
  }

  @Patch(':idAlert/resolve')
  @Roles('Admin', 'Devops')
  @ApiOperation({ summary: 'Manually resolve an active alert (kept in the history)' })
  resolve(@Param('envId') envId: string, @Param('idAlert') idAlert: string) {
    return this.alertsService.resolve(envId, idAlert);
  }
}
