import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AlertSeverity, AlertStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ALERT_TYPES } from './alert-metrics.js';
import { ensureEnvironment, ensureServerInEnvironment } from './server-lookup.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;

export interface FindAlertsQuery {
  serverId?: string;
  type?: string;
  severity?: string;
  status?: string;
  page?: number;
  limit?: number;
}

const SEVERITIES: string[] = Object.values(AlertSeverity);
const STATUSES: string[] = Object.values(AlertStatus);

/**
 * Alert listing, history and manual resolution (KAN-34). Alerts are never deleted:
 * resolving only sets status = Resolved and resolvedAt, so every alert stays in the
 * history. Creation and automatic resolution are done by AlertEvaluatorService.
 */
@Injectable()
export class AlertsService {
  constructor(private prisma: PrismaService) {}

  async findAll(envId: string, query: FindAlertsQuery = {}) {
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(page) || page < 1) {
      throw new BadRequestException('page must be an integer greater than or equal to 1');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    if (query.type !== undefined && !ALERT_TYPES.includes(query.type)) {
      throw new BadRequestException(`type must be one of: ${ALERT_TYPES.join(', ')}`);
    }
    if (query.severity !== undefined && !SEVERITIES.includes(query.severity)) {
      throw new BadRequestException(`severity must be one of: ${SEVERITIES.join(', ')}`);
    }
    if (query.status !== undefined && !STATUSES.includes(query.status)) {
      throw new BadRequestException(`status must be one of: ${STATUSES.join(', ')}`);
    }

    if (query.serverId !== undefined) {
      await ensureServerInEnvironment(this.prisma, envId, query.serverId);
    } else {
      await ensureEnvironment(this.prisma, envId);
    }

    const where = {
      server: { envId },
      ...(query.serverId !== undefined && { serverId: query.serverId }),
      ...(query.type !== undefined && { type: query.type }),
      ...(query.severity !== undefined && { severity: query.severity as AlertSeverity }),
      ...(query.status !== undefined && { status: query.status as AlertStatus }),
    };

    const [data, total] = await Promise.all([
      this.prisma.alert.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { idAlert: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.alert.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(envId: string, idAlert: string) {
    await ensureEnvironment(this.prisma, envId);

    const found = await this.prisma.alert.findUnique({
      where: { idAlert },
      include: { server: { select: { envId: true } } },
    });
    if (!found || found.server.envId !== envId) {
      throw new NotFoundException(`Alert with ID ${idAlert} not found in environment ${envId}`);
    }
    const { server: _server, ...alert } = found;
    return alert;
  }

  async resolve(envId: string, idAlert: string) {
    const alert = await this.findOne(envId, idAlert);
    if (alert.status === AlertStatus.Resolved) {
      throw new ConflictException(`Alert with ID ${idAlert} is already resolved`);
    }

    // The status guard makes this safe against a concurrent resolution (manual or
    // automatic): only one of them can change the row and set resolvedAt.
    const { count } = await this.prisma.alert.updateMany({
      where: { idAlert, status: AlertStatus.Active },
      data: { status: AlertStatus.Resolved, resolvedAt: new Date() },
    });
    if (count === 0) {
      throw new ConflictException(`Alert with ID ${idAlert} is already resolved`);
    }

    return { message: 'Alert resolved successfully', alert: await this.findOne(envId, idAlert) };
  }
}
