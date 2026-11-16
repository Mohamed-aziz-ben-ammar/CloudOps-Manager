import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { AppStatus } from '@prisma/client';

export class CreateApplicationDto {
  @ApiProperty({ example: 'billing-api' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: '1.4.2' })
  @IsString()
  @IsNotEmpty()
  version: string;

  @ApiProperty({ enum: AppStatus, required: false, example: AppStatus.Deployed })
  @IsEnum(AppStatus)
  @IsOptional()
  status?: AppStatus;
}