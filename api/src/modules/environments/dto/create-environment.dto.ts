import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { EnvName } from '@prisma/client';

export class CreateEnvironmentDto {
  @ApiProperty({ enum: EnvName, example: EnvName.Production })
  @IsEnum(EnvName)
  name: EnvName;
}