import { Module } from '@nestjs/common';
import { TeamAssignmentsController } from './team-assignments.controller.js';
import { TeamAssignmentsService } from './team-assignments.service.js';

@Module({ controllers: [TeamAssignmentsController], providers: [TeamAssignmentsService] })
export class TeamAssignmentsModule {}