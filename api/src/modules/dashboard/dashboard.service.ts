import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AlertSeverity, AlertStatus, AppStatus, Prisma, ServerStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  DASHBOARD_RANGE_KEYS,
  DASHBOARD_RANGES,
  DashboardRange,
  DEFAULT_DASHBOARD_RANGE,
} from './dashboard.constants.js';

export interface DashboardFilters {
  projectId?: string;
  environmentId?: string;
}

export interface DashboardMetricsFilters extends DashboardFilters {
  range?: string;
}

interface Scope {
  /** Server filter for the selected project / environment; empty when nothing is selected. */
  serverWhere: Prisma.ServerWhereInput;
  hasScope: boolean;
  /** Project of the scope when one is selected (directly or through the environment). */
  projectId: string | null;
}

interface MetricRow {
  bucket: number | string;
  cpuAvg: number | string;
  cpuMax: number | string;
  memoryAvg: number | string;
  memoryMax: number | string;
  diskAvg: number | string;
  diskMax: number | string;
  samples: number | string | bigint;
}

type Groups = { _count: { _all: number } }[];

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Read-only dashboard (KAN-37 / KAN-38): counters and CPU/RAM time series, optionally
 * restricted to one project and/or one environment.
 *
 * Access follows the rest of the API: any authenticated Admin, Devops or Viewer may read
 * everything, there is no per-user team scoping. What the filters guarantee is that data
 * never mixes across the selected project/environment.
 *
 * Both endpoints first resolve the filters (unknown IDs and an environment outside the
 * selected project are 404s), then run only aggregate queries: no query per server,
 * environment or project.
 */
@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  // Overridable clock (deterministic in unit tests).
  now: () => Date = () => new Date();

  /**
   * Validates the filters and builds the server filter used by every query.
   * The project and environment lookups run in parallel, only for the filters given.
   */
  private async resolveScope(filters: DashboardFilters): Promise<Scope> {
    const { projectId, environmentId } = filters;

    const [project, environment] = await Promise.all([
      projectId !== undefined
        ? this.prisma.project.findUnique({ where: { idProject: projectId }, select: { idProject: true } })
        : null,
      environmentId !== undefined
        ? this.prisma.environment.findUnique({
            where: { idEnv: environmentId },
            select: { idEnv: true, projectId: true },
          })
        : null,
    ]);

    if (projectId !== undefined && !project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }
    if (environmentId !== undefined && !environment) {
      throw new NotFoundException(`Environment with ID ${environmentId} not found`);
    }
    if (projectId !== undefined && environment && environment.projectId !== projectId) {
      throw new NotFoundException(`Environment with ID ${environmentId} not found in project ${projectId}`);
    }

    // An environment already belongs to the selected project (checked above), so the
    // environment filter alone is enough: a direct column filter, no join.
    const serverWhere: Prisma.ServerWhereInput =
      environmentId !== undefined
        ? { envId: environmentId }
        : projectId !== undefined
          ? { env: { projectId } }
          : {};

    return {
      serverWhere,
      hasScope: environmentId !== undefined || projectId !== undefined,
      projectId: projectId ?? environment?.projectId ?? null,
    };
  }

  private count(groups: Groups, field: string, key: string): number {
    const group = (groups as unknown as Record<string, unknown>[]).find((g) => g[field] === key);
    return (group?._count as { _all: number } | undefined)?._all ?? 0;
  }

  private total(groups: Groups): number {
    return groups.reduce((sum, g) => sum + g._count._all, 0);
  }

  async getSummary(filters: DashboardFilters = {}) {
    const scope = await this.resolveScope(filters);
    const { environmentId } = filters;
    const server = scope.hasScope ? { server: scope.serverWhere } : {};

    // One round trip, five aggregate queries, whatever the amount of data.
    const [serverGroups, applicationGroups, alertGroups, projects, environments] = await this.prisma.$transaction([
      this.prisma.server.groupBy({ by: ['status'], where: scope.serverWhere, _count: { _all: true } }),
      this.prisma.application.groupBy({ by: ['status'], where: { ...server }, _count: { _all: true } }),
      this.prisma.alert.groupBy({
        by: ['severity'],
        where: { status: AlertStatus.Active, ...server },
        _count: { _all: true },
      }),
      this.prisma.project.count({ where: scope.projectId ? { idProject: scope.projectId } : {} }),
      this.prisma.environment.count({
        where: environmentId !== undefined ? { idEnv: environmentId } : scope.projectId ? { projectId: scope.projectId } : {},
      }),
    ]);

    return {
      filters: { projectId: filters.projectId ?? null, environmentId: environmentId ?? null },
      counters: {
        projects,
        environments,
        servers: {
          total: this.total(serverGroups),
          running: this.count(serverGroups, 'status', ServerStatus.Running),
          stopped: this.count(serverGroups, 'status', ServerStatus.Stopped),
          maintenance: this.count(serverGroups, 'status', ServerStatus.Maintenance),
        },
        applications: {
          total: this.total(applicationGroups),
          deployed: this.count(applicationGroups, 'status', AppStatus.Deployed),
          failed: this.count(applicationGroups, 'status', AppStatus.Failed),
          building: this.count(applicationGroups, 'status', AppStatus.Building),
        },
        alerts: {
          active: this.total(alertGroups),
          critical: this.count(alertGroups, 'severity', AlertSeverity.Critical),
          warning: this.count(alertGroups, 'severity', AlertSeverity.Warning),
          info: this.count(alertGroups, 'severity', AlertSeverity.Info),
        },
      },
    };
  }

  async getMetrics(query: DashboardMetricsFilters = {}) {
    const range = query.range ?? DEFAULT_DASHBOARD_RANGE;
    if (!(DASHBOARD_RANGE_KEYS as string[]).includes(range)) {
      throw new BadRequestException(`range must be one of: ${DASHBOARD_RANGE_KEYS.join(', ')}`);
    }
    const { seconds, bucketSeconds } = DASHBOARD_RANGES[range as DashboardRange];

    const scope = await this.resolveScope(query);

    // The project/environment filter is applied here, on the small Server table. The Metric
    // query below then only needs "these servers within this time range", which is exactly
    // what the (serverId, timestamp) index serves; no join on the large table.
    const servers: { idServer: string }[] = await this.prisma.server.findMany({
      where: scope.serverWhere,
      select: { idServer: true },
    });

    const to = this.now();
    const from = new Date(to.getTime() - seconds * 1000);
    const response = {
      filters: { projectId: query.projectId ?? null, environmentId: query.environmentId ?? null },
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      bucketSeconds,
      serverCount: servers.length,
    };
    if (servers.length === 0) return { ...response, series: [] };

    const serverIds = servers.map((s) => s.idServer);

    // Every variable value is a bound parameter. Timestamps are sent as ISO strings and cast
    // to timestamp (the column is timestamp without time zone, stored in UTC), so the result
    // does not depend on the session time zone. date_bin with the epoch as origin gives
    // buckets aligned on multiples of the bucket size, identical from one request to the next.
    // GROUP BY / ORDER BY 1 refer to the bucket expression, so its parameters need not repeat.
    // COUNT is cast to int because Prisma would return a bigint.
    const rows = (await this.prisma.$queryRaw(Prisma.sql`
      SELECT
        EXTRACT(EPOCH FROM date_bin(
          ${bucketSeconds}::double precision * INTERVAL '1 second',
          m."timestamp",
          TIMESTAMP '1970-01-01 00:00:00'
        ))::double precision AS "bucket",
        AVG(m."cpuUsage") AS "cpuAvg",
        MAX(m."cpuUsage") AS "cpuMax",
        AVG(m."memoryUsage") AS "memoryAvg",
        MAX(m."memoryUsage") AS "memoryMax",
	AVG(m."diskUsage") AS "diskAvg",
        MAX(m."diskUsage") AS "diskMax",
        COUNT(*)::int AS "samples"
      FROM "Metric" m
      WHERE m."serverId" = ANY(${serverIds}::text[])
        AND m."timestamp" >= ${from.toISOString()}::timestamp
        AND m."timestamp" <= ${to.toISOString()}::timestamp
      GROUP BY 1
      ORDER BY 1
    `)) as MetricRow[];

    // Buckets without any sample are not returned (not zero-filled): a chart shows a gap.
    // Number() also covers drivers that return numeric/bigint values as Decimal or bigint.
    const series = rows.map((row) => ({
      timestamp: new Date(Math.round(Number(row.bucket) * 1000)).toISOString(),
      cpu: { avg: round2(Number(row.cpuAvg)), max: round2(Number(row.cpuMax)) },
      memory: { avg: round2(Number(row.memoryAvg)), max: round2(Number(row.memoryMax)) },
      disk: { avg: round2(Number(row.diskAvg)), max: round2(Number(row.diskMax)) },
      samples: Number(row.samples),
    }));

    return { ...response, series };
  }

  /** Projects with their environments: the options of the project/environment filters. */
  async getFilters() {
    const projects = await this.prisma.project.findMany({
      select: {
        idProject: true,
        name: true,
        environments: { select: { idEnv: true, name: true }, orderBy: { name: 'asc' } },
      },
      orderBy: { name: 'asc' },
    });
    return { projects };
  }
}
