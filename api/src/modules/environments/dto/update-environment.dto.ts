import { PartialType } from '@nestjs/swagger';
import { CreateEnvironmentDto } from './create-environment.dto.js';

export class UpdateEnvironmentDto extends PartialType(CreateEnvironmentDto) {}