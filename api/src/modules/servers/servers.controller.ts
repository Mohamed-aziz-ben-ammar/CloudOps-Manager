import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ServersService } from './servers.service.js';
import { CreateServerDto } from './dto/create-server.dto.js';
import { UpdateServerDto } from './dto/update-server.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

@ApiTags('servers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('Admin', 'Devops')
@Controller('environments/:envId/servers')
export class ServersController {
  constructor(private readonly serversService: ServersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a server in the selected environment' })
  create(@Param('envId') envId: string, @Body() dto: CreateServerDto) {
    return this.serversService.create(envId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List servers in the selected environment' })
  findAll(@Param('envId') envId: string) {
    return this.serversService.findAll(envId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a server by ID in the selected environment' })
  findOne(@Param('envId') envId: string, @Param('id') id: string) {
    return this.serversService.findOne(envId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a server in the selected environment' })
  update(@Param('envId') envId: string, @Param('id') id: string, @Body() dto: UpdateServerDto) {
    return this.serversService.update(envId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a server in the selected environment' })
  remove(@Param('envId') envId: string, @Param('id') id: string) {
    return this.serversService.remove(envId, id);
  }
}
