import { PartialType } from '@nestjs/swagger';
import { CreateTeamAssignmentDto } from './create-team-assignment.dto.js';

export class UpdateTeamAssignmentDto extends PartialType(CreateTeamAssignmentDto) {}
