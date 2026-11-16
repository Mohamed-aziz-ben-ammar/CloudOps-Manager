import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { EnvName } from '@prisma/client';

export class QueryEnvironmentDto {
  @ApiPropertyOptional({ enum: EnvName, description: 'Filter by environment name' })
  @IsOptional()
  @IsEnum(EnvName)
  name?: EnvName;
}