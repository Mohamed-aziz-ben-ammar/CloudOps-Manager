import { PartialType } from '@nestjs/swagger';
import { CreateApplicationDto } from './CreateApplicationDto.js';

export class UpdateApplicationDto extends PartialType(CreateApplicationDto) {}