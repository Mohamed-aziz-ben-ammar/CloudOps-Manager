import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AlertThresholdsService } from './alert-thresholds.service.js';
import { UpdateAlertThresholdsDto } from './dto/update-alert-thresholds.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

// Note: RolesGuard lets a request through when a handler has no @Roles metadata,
// so every handler below declares its roles explicitly (no class-level default).
@ApiTags('alert-thresholds')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('environments/:envId/servers/:serverId/alert-thresholds')
export class AlertThresholdsController {
  constructor(private readonly thresholdsService: AlertThresholdsService) {}

  @Get()
  @Roles('Admin', 'Devops', 'Viewer')
  @ApiOperation({ summary: 'Get the effective alert thresholds of a server (custom or default)' })
  get(@Param('envId') envId: string, @Param('serverId') serverId: string) {
    return this.thresholdsService.get(envId, serverId);
  }

  @Put()
  @Roles('Admin', 'Devops')
  @ApiOperation({ summary: 'Create or update the alert thresholds of a server (any of cpu, memory, disk)' })
  update(
    @Param('envId') envId: string,
    @Param('serverId') serverId: string,
    @Body() dto: UpdateAlertThresholdsDto,
  ) {
    return this.thresholdsService.upsert(envId, serverId, dto);
  }
}
