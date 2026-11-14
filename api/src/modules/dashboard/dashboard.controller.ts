import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service.js';
import { DashboardFilterDto, DashboardMetricsQueryDto } from './dto/dashboard-query.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

// The dashboard is read-only: GET handlers only.
// Note: RolesGuard lets a request through when a handler has no @Roles metadata,
// so every handler below declares its roles explicitly (no class-level default).
@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  @Roles('Admin', 'Devops', 'Viewer')
  @ApiOperation({
    summary: 'Dashboard counters (servers, applications and active alerts by status/severity)',
    description:
      'Optionally restricted to a project and/or an environment. With both, the environment must belong to the project (404 otherwise). An empty scope returns zero counters.',
  })
  getSummary(@Query() query: DashboardFilterDto) {
    return this.dashboardService.getSummary(query);
  }

  @Get('metrics')
  @Roles('Admin', 'Devops', 'Viewer')
  @ApiOperation({
    summary: 'CPU and RAM history for charts (average and maximum per time bucket)',
    description:
      'Values are aggregated across all servers of the selected scope. Time buckets without samples are omitted. Optionally restricted to a project and/or an environment.',
  })
  getMetrics(@Query() query: DashboardMetricsQueryDto) {
    return this.dashboardService.getMetrics(query);
  }

  @Get('filters')
  @Roles('Admin', 'Devops', 'Viewer')
  @ApiOperation({ summary: 'Projects with their environments, to populate the dashboard filters' })
  getFilters() {
    return this.dashboardService.getFilters();
  }
}
