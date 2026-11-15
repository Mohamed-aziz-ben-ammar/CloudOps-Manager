import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateTeamAssignmentDto {
  @ApiProperty({ description: 'ID of the user to add to the project' })
  @IsUUID()
  userId: string;
}