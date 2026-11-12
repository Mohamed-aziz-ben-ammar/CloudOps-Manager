import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { ServerStatus } from '@prisma/client';

export class CreateServerDto {
  @ApiProperty({ example: 'AWS' })
  @IsString()
  @IsNotEmpty()
  provider: string;

  @ApiProperty({ example: 'eu-west-1' })
  @IsString()
  @IsNotEmpty()
  region: string;

  @ApiProperty({ example: 4 })
  @IsInt()
  @Min(1)
  cpuCores: number;

  @ApiProperty({ example: 16 })
  @IsInt()
  @Min(1)
  ramGb: number;

  @ApiProperty({ example: 200 })
  @IsInt()
  @Min(1)
  storageGb: number;

  @ApiProperty({ example: '203.0.113.10' })
  @IsString()
  @IsNotEmpty()
  publicIp: string;

  @ApiProperty({ example: '10.0.0.10' })
  @IsString()
  @IsNotEmpty()
  privateIp: string;

  @ApiProperty({ enum: ServerStatus, required: false, example: ServerStatus.Running })
  @IsEnum(ServerStatus)
  @IsOptional()
  status?: ServerStatus;
}
