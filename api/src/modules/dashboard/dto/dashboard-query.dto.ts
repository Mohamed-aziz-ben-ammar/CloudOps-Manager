import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { DASHBOARD_RANGE_KEYS, DEFAULT_DASHBOARD_RANGE } from '../dashboard.constants.js';
import type { DashboardRange } from '../dashboard.constants.js';

export class DashboardFilterDto {
  @ApiProperty({
    type: String,
    required: false,
    description: 'Only data of this project. Omit for all projects.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  projectId?: string;

  @ApiProperty({
    type: String,
    required: false,
    description:
      'Only data of this environment. Omit for all environments. When projectId is also given, the environment must belong to that project.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  environmentId?: string;
}

export class DashboardMetricsQueryDto extends DashboardFilterDto {
  @ApiProperty({
    enum: DASHBOARD_RANGE_KEYS,
    required: false,
    default: DEFAULT_DASHBOARD_RANGE,
    description: 'Time range ending now: 1h (1-minute buckets), 6h (5 min), 24h (15 min), 7d (1 hour)',
  })
  @IsOptional()
  @IsIn(DASHBOARD_RANGE_KEYS)
  range?: DashboardRange;
}
