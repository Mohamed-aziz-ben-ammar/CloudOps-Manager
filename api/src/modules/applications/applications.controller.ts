import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AppStatus } from '@prisma/client';
import { ApplicationsService } from './applications.service.js';
import { CreateApplicationDto } from './dto/CreateApplicationDto.js';
import { UpdateApplicationDto } from './dto/UpdateApplicationDto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

@ApiTags('applications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('servers/:serverId/applications')
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Post()
  @Roles('Admin', 'Devops')
  @ApiOperation({ summary: 'Create an application on the selected server' })
  create(@Param('serverId') serverId: string, @Body() dto: CreateApplicationDto) {
    return this.applicationsService.create(serverId, dto);
  }

  @Get()
  @Roles('Admin', 'Devops', 'Viewer')
  @ApiOperation({ summary: 'List applications of the selected server' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({ name: 'search', required: false, description: 'Search by application name' })
  @ApiQuery({ name: 'status', required: false, enum: AppStatus })
  findAll(
    @Param('serverId') serverId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: AppStatus,
  ) {
    const pageNumber = Math.max(parseInt(page ?? '1', 10) || 1, 1);
    const limitNumber = Math.min(Math.max(parseInt(limit ?? '10', 10) || 10, 1), 100);
    return this.applicationsService.findAll(serverId, pageNumber, limitNumber, search, status);
  }

  @Get(':id')
  @Roles('Admin', 'Devops', 'Viewer')
  @ApiOperation({ summary: 'Get an application by ID on the selected server' })
  findOne(@Param('serverId') serverId: string, @Param('id') id: string) {
    return this.applicationsService.findOne(serverId, id);
  }

  @Patch(':id')
  @Roles('Admin', 'Devops')
  @ApiOperation({ summary: 'Update an application on the selected server' })
  update(
    @Param('serverId') serverId: string,
    @Param('id') id: string,
    @Body() dto: UpdateApplicationDto,
  ) {
    return this.applicationsService.update(serverId, id, dto);
  }

  @Delete(':id')
  @Roles('Admin', 'Devops')
  @ApiOperation({ summary: 'Delete an application on the selected server' })
  remove(@Param('serverId') serverId: string, @Param('id') id: string) {
    return this.applicationsService.remove(serverId, id);
  }
}