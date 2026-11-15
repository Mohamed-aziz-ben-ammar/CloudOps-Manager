import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateTeamAssignmentDto } from './dto/create-team-assignment.dto.js';

// Never expose hashedPassword: only these user fields are returned.
const userSelect = { idUser: true, email: true, fullName: true, role: true };

@Injectable()
export class TeamAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureProjectExists(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { idProject: projectId },
      select: { idProject: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
  }

  async create(projectId: string, dto: CreateTeamAssignmentDto) {
    await this.ensureProjectExists(projectId);

    const user = await this.prisma.user.findUnique({
      where: { idUser: dto.userId },
      select: { idUser: true },
    });
    if (!user) throw new NotFoundException(`User ${dto.userId} not found`);

    try {
      return await this.prisma.teamAssignment.create({
        data: { projectId, userId: dto.userId },
        include: { user: { select: userSelect } },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This user is already assigned to the project');
      }
      throw error;
    }
  }

  async findAll(projectId: string) {
    await this.ensureProjectExists(projectId);
    return this.prisma.teamAssignment.findMany({
      where: { projectId },
      include: { user: { select: userSelect } },
      orderBy: { joinedAt: 'asc' },
    });
  }

  async remove(projectId: string, assignmentId: string) {
    const assignment = await this.prisma.teamAssignment.findFirst({
      where: { idTeamAssign: assignmentId, projectId },
    });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${assignmentId} not found in project ${projectId}`);
    }
    return this.prisma.teamAssignment.delete({ where: { idTeamAssign: assignmentId } });
  }
}