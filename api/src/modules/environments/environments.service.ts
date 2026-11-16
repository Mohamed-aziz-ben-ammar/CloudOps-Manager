import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateEnvironmentDto } from './dto/create-environment.dto.js';
import { UpdateEnvironmentDto } from './dto/update-environment.dto.js';
import { QueryEnvironmentDto } from './dto/query-environment.dto.js';

@Injectable()
export class EnvironmentsService {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureProjectExists(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { idProject: projectId },
      select: { idProject: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
  }

  private rethrowIfDuplicate(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('This project already has an environment with that name');
    }
    throw error;
  }

  async create(projectId: string, dto: CreateEnvironmentDto) {
    await this.ensureProjectExists(projectId);
    try {
      return await this.prisma.environment.create({
        data: { name: dto.name, projectId },
      });
    } catch (error) {
      this.rethrowIfDuplicate(error);
    }
  }

  async findAll(projectId: string, query: QueryEnvironmentDto) {
    await this.ensureProjectExists(projectId);
    return this.prisma.environment.findMany({
      where: { projectId, ...(query.name && { name: query.name }) },
      include: { _count: { select: { servers: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(projectId: string, envId: string) {
    const environment = await this.prisma.environment.findFirst({
      where: { idEnv: envId, projectId },
      include: { _count: { select: { servers: true } } },
    });
    if (!environment) {
      throw new NotFoundException(`Environment ${envId} not found in project ${projectId}`);
    }
    return environment;
  }

  async update(projectId: string, envId: string, dto: UpdateEnvironmentDto) {
    await this.findOne(projectId, envId);
    try {
      return await this.prisma.environment.update({
        where: { idEnv: envId },
        data: dto,
      });
    } catch (error) {
      this.rethrowIfDuplicate(error);
    }
  }

  async remove(projectId: string, envId: string) {
    await this.findOne(projectId, envId);
    return this.prisma.environment.delete({ where: { idEnv: envId } });
  }
}