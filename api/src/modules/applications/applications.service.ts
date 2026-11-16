import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateApplicationDto } from './dto/CreateApplicationDto.js';
import { UpdateApplicationDto } from './dto/UpdateApplicationDto.js';
import { AppStatus, Prisma } from '@prisma/client';

@Injectable()
export class ApplicationsService {
  constructor(private prisma: PrismaService) {}

  private async ensureServer(serverId: string) {
    const server = await this.prisma.server.findUnique({ where: { idServer: serverId } });
    if (!server) throw new NotFoundException(`Server with ID ${serverId} not found`);
    return server;
  }

  async create(serverId: string, dto: CreateApplicationDto) {
    await this.ensureServer(serverId);
    const application = await this.prisma.application.create({
      data: { ...dto, status: dto.status ?? AppStatus.Deployed, serverId },
    });
    return { message: 'Application created successfully', application };
  }

  async findAll(
    serverId: string,
    page = 1,
    limit = 10,
    search?: string,
    status?: AppStatus,
  ) {
    await this.ensureServer(serverId);

    const where: Prisma.ApplicationWhereInput = {
      serverId,
      ...(status && { status }),
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    };

    const [data, total] = await Promise.all([
      this.prisma.application.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { name: 'asc' },
      }),
      this.prisma.application.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(serverId: string, idApp: string) {
    await this.ensureServer(serverId);
    const application = await this.prisma.application.findUnique({
      where: { idApp },
      // The environment comes from the server, not from the application itself
      include: { server: { select: { env: { select: { name: true } } } } },
    });
    if (!application || application.serverId !== serverId) {
      throw new NotFoundException(`Application with ID ${idApp} not found on server ${serverId}`);
    }
    return application;
  }

  async update(serverId: string, idApp: string, dto: UpdateApplicationDto) {
    await this.findOne(serverId, idApp);
    const application = await this.prisma.application.update({ where: { idApp }, data: dto });
    return { message: 'Application updated successfully', application };
  }

  async remove(serverId: string, idApp: string) {
    await this.findOne(serverId, idApp);
    await this.prisma.application.delete({ where: { idApp } });
    return { message: `Application with ID ${idApp} deleted successfully` };
  }
}