import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Max, Min, ValidateNested } from 'class-validator';

export class ThresholdLevelsDto {
  @ApiProperty({ type: Number, example: 80, minimum: 0, maximum: 100, description: 'Warning threshold in percent' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  warning: number;

  @ApiProperty({
    type: Number,
    example: 95,
    minimum: 0,
    maximum: 100,
    description: 'Critical threshold in percent, strictly greater than warning',
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  critical: number;
}

export class UpdateAlertThresholdsDto {
  @ApiProperty({ type: () => ThresholdLevelsDto, required: false, description: 'CPU usage thresholds' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThresholdLevelsDto)
  cpu?: ThresholdLevelsDto;

  @ApiProperty({ type: () => ThresholdLevelsDto, required: false, description: 'Memory usage thresholds' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThresholdLevelsDto)
  memory?: ThresholdLevelsDto;

  @ApiProperty({ type: () => ThresholdLevelsDto, required: false, description: 'Disk usage thresholds' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThresholdLevelsDto)
  disk?: ThresholdLevelsDto;
}
