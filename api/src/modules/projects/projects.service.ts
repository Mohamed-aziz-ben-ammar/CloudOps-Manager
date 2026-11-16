import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';
import { QueryProjectDto } from './dto/query-project.dto.js';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateProjectDto) {
    return this.prisma.project.create({ data: dto });
  }

  async findAll(query: QueryProjectDto) {
    const { page = 1, limit = 10, search } = query;
    const where: Prisma.ProjectWhereInput = search
      ? { name: { contains: search, mode: 'insensitive' } }
      : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { environments: true, teamAssignments: true } } },
      }),
      this.prisma.project.count({ where }),
    ]);

    return { items, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    const project = await this.prisma.project.findUnique({
      where: { idProject: id },
      include: { environments: true, _count: { select: { teamAssignments: true } } },
    });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  async update(id: string, dto: UpdateProjectDto) {
    await this.findOne(id);
    return this.prisma.project.update({ where: { idProject: id }, data: dto });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.project.delete({ where: { idProject: id } });
  }
}