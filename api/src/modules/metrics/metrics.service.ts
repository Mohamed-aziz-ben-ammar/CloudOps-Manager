import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateMetricDto } from './dto/create-metric.dto.js';
import { AlertEvaluatorService } from './alert-evaluator.service.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;

// Tolerated clock drift between a reporting client and this server.
export const FUTURE_TOLERANCE_MS = 60_000;

export interface FindMetricsQuery {
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class MetricsService {
  constructor(
    private prisma: PrismaService,
    private alertEvaluator: AlertEvaluatorService,
  ) {}

  // Same ownership rules (and messages) as ServersService.findOne, kept here so the
  // Servers module does not have to be modified or export anything.
  private async ensureServer(envId: string, idServer: string) {
    const env = await this.prisma.environment.findUnique({ where: { idEnv: envId } });
    if (!env) throw new NotFoundException(`Environment with ID ${envId} not found`);

    const server = await this.prisma.server.findUnique({ where: { idServer } });
    if (!server || server.envId !== envId) {
      throw new NotFoundException(`Server with ID ${idServer} not found in environment ${envId}`);
    }
    return server;
  }

  private assertPercentage(field: string, value: number) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new BadRequestException(`${field} must be a number between 0 and 100`);
    }
  }

  private parseDate(field: string, value: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} must be a valid ISO 8601 date`);
    }
    return date;
  }

  async create(envId: string, serverId: string, dto: CreateMetricDto) {
    this.assertPercentage('cpuUsage', dto.cpuUsage);
    this.assertPercentage('memoryUsage', dto.memoryUsage);
    this.assertPercentage('diskUsage', dto.diskUsage);

    let timestamp: Date | undefined;
    if (dto.timestamp !== undefined) {
      timestamp = this.parseDate('timestamp', dto.timestamp);
      if (timestamp.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
        throw new BadRequestException('timestamp cannot be in the future');
      }
    }

    await this.ensureServer(envId, serverId);

    const metric = await this.prisma.metric.create({
      data: {
        serverId,
        cpuUsage: dto.cpuUsage,
        memoryUsage: dto.memoryUsage,
        diskUsage: dto.diskUsage,
        ...(timestamp && { timestamp }),
      },
    });
    // Same evaluator as the simulator; it never throws, so a stored metric is never failed by it.
    await this.alertEvaluator.evaluate([
      { serverId, cpuUsage: dto.cpuUsage, memoryUsage: dto.memoryUsage, diskUsage: dto.diskUsage },
    ]);

    return { message: 'Metric recorded successfully', metric };
  }

  async findAll(envId: string, serverId: string, query: FindMetricsQuery = {}) {
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(page) || page < 1) {
      throw new BadRequestException('page must be an integer greater than or equal to 1');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }

    const from = query.from !== undefined ? this.parseDate('from', query.from) : undefined;
    const to = query.to !== undefined ? this.parseDate('to', query.to) : undefined;
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be earlier than or equal to to');
    }

    await this.ensureServer(envId, serverId);

    const where = {
      serverId,
      ...((from || to) && {
        timestamp: { ...(from && { gte: from }), ...(to && { lte: to }) },
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.metric.findMany({
        where,
        orderBy: [{ timestamp: 'desc' }, { idMetric: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.metric.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findLatest(envId: string, serverId: string) {
    await this.ensureServer(envId, serverId);

    const metric = await this.prisma.metric.findFirst({
      where: { serverId },
      orderBy: [{ timestamp: 'desc' }, { idMetric: 'asc' }],
    });
    if (!metric) {
      throw new NotFoundException(`No metrics recorded for server ${serverId}`);
    }
    return metric;
  }

  async findOne(envId: string, serverId: string, idMetric: string) {
    await this.ensureServer(envId, serverId);

    const metric = await this.prisma.metric.findUnique({ where: { idMetric } });
    if (!metric || metric.serverId !== serverId) {
      throw new NotFoundException(`Metric with ID ${idMetric} not found for server ${serverId}`);
    }
    return metric;
  }
}
