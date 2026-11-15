import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { EnvironmentsService } from './environments.service.js';
import { CreateEnvironmentDto } from './dto/create-environment.dto.js';
import { UpdateEnvironmentDto } from './dto/update-environment.dto.js';
import { QueryEnvironmentDto } from './dto/query-environment.dto.js';

@ApiTags('Environments')
@ApiBearerAuth()
@Controller('projects/:projectId/environments')
export class EnvironmentsController {
  constructor(private readonly environmentsService: EnvironmentsService) {}

  @Post()
  create(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateEnvironmentDto,
  ) {
    return this.environmentsService.create(projectId, dto);
  }

  @Get()
  findAll(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: QueryEnvironmentDto,
  ) {
    return this.environmentsService.findAll(projectId, query);
  }

  @Get(':envId')
  findOne(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('envId', ParseUUIDPipe) envId: string,
  ) {
    return this.environmentsService.findOne(projectId, envId);
  }

  @Patch(':envId')
  update(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('envId', ParseUUIDPipe) envId: string,
    @Body() dto: UpdateEnvironmentDto,
  ) {
    return this.environmentsService.update(projectId, envId, dto);
  }

  @Delete(':envId')
  remove(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('envId', ParseUUIDPipe) envId: string,
  ) {
    return this.environmentsService.remove(projectId, envId);
  }
}