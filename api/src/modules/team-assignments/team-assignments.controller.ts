import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TeamAssignmentsService } from './team-assignments.service.js';
import { CreateTeamAssignmentDto } from './dto/create-team-assignment.dto.js';

@ApiTags('Team assignments')
@ApiBearerAuth()
@Controller('projects/:projectId/members')
export class TeamAssignmentsController {
  constructor(private readonly teamAssignmentsService: TeamAssignmentsService) {}

  @Post()
  create(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateTeamAssignmentDto,
  ) {
    return this.teamAssignmentsService.create(projectId, dto);
  }

  @Get()
  findAll(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.teamAssignmentsService.findAll(projectId);
  }

  @Delete(':assignmentId')
  remove(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ) {
    return this.teamAssignmentsService.remove(projectId, assignmentId);
  }
}