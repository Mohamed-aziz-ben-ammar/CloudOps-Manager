import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { MetricsService } from './metrics.service.js';
import { CreateMetricDto } from './dto/create-metric.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

// Note: RolesGuard lets a request through when a handler has no @Roles metadata,
// so every handler below declares its roles explicitly (no class-level default).
@ApiTags('metrics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('environments/:envId/servers/:serverId/metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Post()
  @Roles('Admin', 'Devops')
  @ApiOperation({ summary: 'Record a metric sample for a server' })
  create(
    @Param('envId') envId: string,
    @Param('serverId') serverId: string,
    @Body() dto: CreateMetricDto,
  ) {
    return this.metricsService.create(envId, serverId, dto);
  }

  @Get()
  @Roles('Admin', 'Devops', 'Viewer')
  @ApiOperation({ summary: 'List metric samples for a server (newest first)' })
  @ApiQuery({ name: 'from', required: false, example: '2026-11-12T00:00:00.000Z', description: 'Only samples at or after this ISO 8601 date' })
  @ApiQuery({ name: 'to', required: false, example: '2026-11-12T23:59:59.999Z', description: 'Only samples at or before this ISO 8601 date' })
  @ApiQuery({ name: 'page', required: false, example: 1, description: 'Page number for pagination' })
  @ApiQuery({ name: 'limit', required: false, example: 10, description: 'Number of items per page (max 100)' })
  findAll(
    @Param('envId') envId: string,
    @Param('serverId') serverId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.metricsService.findAll(envId, serverId, { from, to, page, limit });
  }

  // Declared before ':idMetric' so that "latest" is not captured as a metric ID.
  @Get('latest')
  @Roles('Admin', 'Devops', 'Viewer')
  @ApiOperation({ summary: 'Get the most recent metric sample for a server' })
  findLatest(@Param('envId') envId: string, @Param('serverId') serverId: string) {
    return this.metricsService.findLatest(envId, serverId);
  }

  @Get(':idMetric')
  @Roles('Admin', 'Devops', 'Viewer')
  @ApiOperation({ summary: 'Get a metric sample by ID for a server' })
  findOne(
    @Param('envId') envId: string,
    @Param('serverId') serverId: string,
    @Param('idMetric') idMetric: string,
  ) {
    return this.metricsService.findOne(envId, serverId, idMetric);
  }
}
