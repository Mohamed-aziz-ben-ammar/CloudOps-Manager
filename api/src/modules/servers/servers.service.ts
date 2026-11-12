import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateServerDto } from './dto/create-server.dto.js';
import { UpdateServerDto } from './dto/update-server.dto.js';
import { ServerStatus } from '@prisma/client';

@Injectable()
export class ServersService {
  constructor(private prisma: PrismaService) {}

  private async ensureEnvironment(envId: string) {
    const env = await this.prisma.environment.findUnique({ where: { idEnv: envId } });
    if (!env) throw new NotFoundException(`Environment with ID ${envId} not found`);
    return env;
  }

  async create(envId: string, dto: CreateServerDto) {
    await this.ensureEnvironment(envId);
    const server = await this.prisma.server.create({
      data: { ...dto, status: dto.status ?? ServerStatus.Running, envId },
    });
    return { message: 'Server created successfully', server };
  }

  async findAll(envId: string) {
    await this.ensureEnvironment(envId);
    return this.prisma.server.findMany({ where: { envId }, orderBy: { idServer: 'asc' } });
  }

  async findOne(envId: string, idServer: string) {
    await this.ensureEnvironment(envId);
    const server = await this.prisma.server.findUnique({ where: { idServer } });
    if (!server || server.envId !== envId) {
      throw new NotFoundException(`Server with ID ${idServer} not found in environment ${envId}`);
    }
    return server;
  }

  async update(envId: string, idServer: string, dto: UpdateServerDto) {
    await this.findOne(envId, idServer);
    const server = await this.prisma.server.update({ where: { idServer }, data: dto });
    return { message: 'Server updated successfully', server };
  }

  async remove(envId: string, idServer: string) {
    await this.findOne(envId, idServer);
    await this.prisma.server.delete({ where: { idServer } });
    return { message: `Server with ID ${idServer} deleted successfully` };
  }
}
