import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class CreateMetricDto {
  @ApiProperty({ type: Number, example: 45.5, minimum: 0, maximum: 100, description: 'CPU usage in percent' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  cpuUsage: number;

  @ApiProperty({ type: Number, example: 62.3, minimum: 0, maximum: 100, description: 'Memory usage in percent' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  memoryUsage: number;

  @ApiProperty({ type: Number, example: 71.8, minimum: 0, maximum: 100, description: 'Disk usage in percent' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  diskUsage: number;

  @ApiProperty({
    type: String,
    required: false,
    example: '2026-11-12T10:30:00.000Z',
    description: 'ISO 8601 sample time. Defaults to the current time and cannot be in the future.',
  })
  @IsDateString()
  @IsOptional()
  timestamp?: string;
}
