
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DASHBOARD_RANGES, DashboardRange } from './dashboard.constants.js';
import { DashboardService } from './dashboard.service.js';

const PROJECT_ID = 'proj-1';
const ENV_ID = 'env-1';
const NOW = new Date('2026-11-14T12:00:00.000Z');

// Only read operations exist on this mock: any write would fail with a TypeError.
function createPrismaMock() {
  return {
    project: {
      findUnique: vi.fn().mockResolvedValue({ idProject: PROJECT_ID }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(1),
    },
    environment: {
      findUnique: vi.fn().mockResolvedValue({ idEnv: ENV_ID, projectId: PROJECT_ID }),
      count: vi.fn().mockResolvedValue(1),
    },
    server: {
      findMany: vi.fn().mockResolvedValue([{ idServer: 'srv-1' }, { idServer: 'srv-2' }]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    application: { groupBy: vi.fn().mockResolvedValue([]) },
    alert: { groupBy: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the promise to reject');
}

type BoundSql = { strings: string[]; values: unknown[] };
const boundSql = (prisma: ReturnType<typeof createPrismaMock>, call = 0) => {
  const sql = prisma.$queryRaw.mock.calls[call][0] as BoundSql;
  return { text: sql.strings.join('?'), strings: sql.strings, values: sql.values };
};

const group = (field: string, key: string, count: number) => ({ [field]: key, _count: { _all: count } });
const epoch = (iso: string) => Date.parse(iso) / 1000;
const metricRow = (iso: string, overrides: Record<string, unknown> = {}) => ({
  bucket: epoch(iso),
  cpuAvg: 40,
  cpuMax: 60,
  memoryAvg: 50,
  memoryMax: 70,
  diskAvg: 30,
  diskMax: 50,
  samples: 10,
  ...overrides,
});

describe('DashboardService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: DashboardService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new DashboardService(prisma as never);
    service.now = () => NOW;
  });

  describe('getSummary: counters', () => {
    it('counts servers, applications and active alerts by status and severity', async () => {
      prisma.server.groupBy.mockResolvedValue([
        group('status', 'Running', 9),
        group('status', 'Stopped', 2),
        group('status', 'Maintenance', 1),
      ]);
      prisma.application.groupBy.mockResolvedValue([
        group('status', 'Deployed', 16),
        group('status', 'Failed', 2),
        group('status', 'Building', 2),
      ]);
      prisma.alert.groupBy.mockResolvedValue([group('severity', 'Critical', 1), group('severity', 'Warning', 3)]);
      prisma.project.count.mockResolvedValue(3);
      prisma.environment.count.mockResolvedValue(7);

      const result = await service.getSummary();

      expect(result).toEqual({
        filters: { projectId: null, environmentId: null },
        counters: {
          projects: 3,
          environments: 7,
          servers: { total: 12, running: 9, stopped: 2, maintenance: 1 },
          applications: { total: 20, deployed: 16, failed: 2, building: 2 },
          alerts: { active: 4, critical: 1, warning: 3, info: 0 },
        },
      });
    });

    it('reports 0 for statuses that have no row, and a total of 0 for no data (empty results)', async () => {
      prisma.project.count.mockResolvedValue(0);
      prisma.environment.count.mockResolvedValue(0);

      const result = await service.getSummary();

      expect(result.counters).toEqual({
        projects: 0,
        environments: 0,
        servers: { total: 0, running: 0, stopped: 0, maintenance: 0 },
        applications: { total: 0, deployed: 0, failed: 0, building: 0 },
        alerts: { active: 0, critical: 0, warning: 0, info: 0 },
      });
    });

    it('counts only Active alerts, never resolved ones', async () => {
      await service.getSummary();

      expect(prisma.alert.groupBy).toHaveBeenCalledWith({
        by: ['severity'],
        where: { status: 'Active' },
        _count: { _all: true },
      });
    });

    it('runs five aggregate queries in a single transaction, one per counter group (no N+1)', async () => {
      await service.getSummary();

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][0].length).toBe(5);
      for (const query of [
        prisma.server.groupBy,
        prisma.application.groupBy,
        prisma.alert.groupBy,
        prisma.project.count,
        prisma.environment.count,
      ]) {
        expect(query).toHaveBeenCalledTimes(1);
      }
      expect(prisma.server.findMany).not.toHaveBeenCalled();
      expect(prisma.project.findUnique).not.toHaveBeenCalled();
      expect(prisma.environment.findUnique).not.toHaveBeenCalled();
    });

    it('applies no scope when no filter is given', async () => {
      await service.getSummary();

      expect(prisma.server.groupBy).toHaveBeenCalledWith({ by: ['status'], where: {}, _count: { _all: true } });
      expect(prisma.application.groupBy).toHaveBeenCalledWith({ by: ['status'], where: {}, _count: { _all: true } });
      expect(prisma.project.count).toHaveBeenCalledWith({ where: {} });
      expect(prisma.environment.count).toHaveBeenCalledWith({ where: {} });
    });
  });

  describe('getSummary: filters', () => {
    it('scopes every counter to the project', async () => {
      const result = await service.getSummary({ projectId: PROJECT_ID });

      const scope = { env: { projectId: PROJECT_ID } };
      expect(prisma.project.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.environment.findUnique).not.toHaveBeenCalled();
      expect(prisma.server.groupBy).toHaveBeenCalledWith({ by: ['status'], where: scope, _count: { _all: true } });
      expect(prisma.application.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: { server: scope },
        _count: { _all: true },
      });
      expect(prisma.alert.groupBy).toHaveBeenCalledWith({
        by: ['severity'],
        where: { status: 'Active', server: scope },
        _count: { _all: true },
      });
      expect(prisma.project.count).toHaveBeenCalledWith({ where: { idProject: PROJECT_ID } });
      expect(prisma.environment.count).toHaveBeenCalledWith({ where: { projectId: PROJECT_ID } });
      expect(result.filters).toEqual({ projectId: PROJECT_ID, environmentId: null });
    });

    it('scopes every counter to the environment, and counts its project as the only project', async () => {
      const result = await service.getSummary({ environmentId: ENV_ID });

      const scope = { envId: ENV_ID };
      expect(prisma.environment.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.project.findUnique).not.toHaveBeenCalled();
      expect(prisma.server.groupBy).toHaveBeenCalledWith({ by: ['status'], where: scope, _count: { _all: true } });
      expect(prisma.application.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: { server: scope },
        _count: { _all: true },
      });
      expect(prisma.alert.groupBy).toHaveBeenCalledWith({
        by: ['severity'],
        where: { status: 'Active', server: scope },
        _count: { _all: true },
      });
      expect(prisma.project.count).toHaveBeenCalledWith({ where: { idProject: PROJECT_ID } });
      expect(prisma.environment.count).toHaveBeenCalledWith({ where: { idEnv: ENV_ID } });
      expect(result.filters).toEqual({ projectId: null, environmentId: ENV_ID });
    });

    it('with both filters, validates the pair and then filters on the environment alone', async () => {
      const result = await service.getSummary({ projectId: PROJECT_ID, environmentId: ENV_ID });

      expect(prisma.project.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.environment.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.server.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: { envId: ENV_ID },
        _count: { _all: true },
      });
      expect(prisma.project.count).toHaveBeenCalledWith({ where: { idProject: PROJECT_ID } });
      expect(prisma.environment.count).toHaveBeenCalledWith({ where: { idEnv: ENV_ID } });
      expect(result.filters).toEqual({ projectId: PROJECT_ID, environmentId: ENV_ID });
    });

    it('returns zero counters, not an error, for a project that has no servers', async () => {
      const result = await service.getSummary({ projectId: PROJECT_ID });

      expect(result.counters.servers).toEqual({ total: 0, running: 0, stopped: 0, maintenance: 0 });
      expect(result.counters.alerts.active).toBe(0);
    });

    const invalid: [string, { projectId?: string; environmentId?: string }, string][] = [
      ['an unknown project', { projectId: 'nope' }, 'Project with ID nope not found'],
      ['an unknown environment', { environmentId: 'nope' }, 'Environment with ID nope not found'],
    ];
    for (const [label, filters, message] of invalid) {
      it(`rejects ${label} with NotFoundException and runs no aggregate query`, async () => {
        prisma.project.findUnique.mockResolvedValue(null);
        prisma.environment.findUnique.mockResolvedValue(null);

        const error = await rejection(service.getSummary(filters));

        expect(error).toBeInstanceOf(NotFoundException);
        expect(error.message).toBe(message);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    }

    it('rejects an environment that belongs to another project (no cross-project data)', async () => {
      prisma.environment.findUnique.mockResolvedValue({ idEnv: ENV_ID, projectId: 'other-project' });

      const error = await rejection(service.getSummary({ projectId: PROJECT_ID, environmentId: ENV_ID }));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(`Environment with ID ${ENV_ID} not found in project ${PROJECT_ID}`);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('reports an unknown project before looking at the environment', async () => {
      prisma.project.findUnique.mockResolvedValue(null);

      const error = await rejection(service.getSummary({ projectId: 'nope', environmentId: ENV_ID }));

      expect(error.message).toBe('Project with ID nope not found');
    });
  });

  describe('getMetrics: time ranges', () => {
    const ranges: [DashboardRange, number, number][] = [
      ['1h', 3600, 60],
      ['6h', 21600, 300],
      ['24h', 86400, 900],
      ['7d', 604800, 3600],
    ];

    for (const [range, windowSeconds, bucketSeconds] of ranges) {
      it(`supports ${range}: a ${windowSeconds}s window ending now in ${bucketSeconds}s buckets`, async () => {
        const result = await service.getMetrics({ range });

        const from = new Date(NOW.getTime() - windowSeconds * 1000).toISOString();
        expect(result.range).toBe(range);
        expect(result.bucketSeconds).toBe(bucketSeconds);
        expect(result.to).toBe(NOW.toISOString());
        expect(result.from).toBe(from);
        const { values } = boundSql(prisma);
        expect(values).toEqual([bucketSeconds, ['srv-1', 'srv-2'], from, NOW.toISOString()]);
      });
    }

    it('defaults to 24h', async () => {
      const result = await service.getMetrics();

      expect(result.range).toBe('24h');
      expect(result.bucketSeconds).toBe(900);
    });

    it('keeps every series to at most 168 points', () => {
      for (const { seconds, bucketSeconds } of Object.values(DASHBOARD_RANGES)) {
        expect(seconds / bucketSeconds).toBeLessThanOrEqual(168);
      }
    });

    for (const range of ['3d', '', '24H', 'constructor', 'toString']) {
      it(`rejects the unsupported range "${range}" with BadRequestException before any query`, async () => {
        const error = await rejection(service.getMetrics({ range }));

        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe('range must be one of: 1h, 6h, 24h, 7d');
        expect(prisma.project.findUnique).not.toHaveBeenCalled();
        expect(prisma.server.findMany).not.toHaveBeenCalled();
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      });
    }
  });

  describe('getMetrics: aggregation', () => {
    it('maps aggregated CPU/RAM/disk rows to a time series, rounded to 2 decimals', async () => {
      prisma.$queryRaw.mockResolvedValue([
        metricRow('2026-11-14T10:00:00.000Z', {
          cpuAvg: 41.23456,
          cpuMax: 78.1,
          memoryAvg: 55.555,
          memoryMax: 99.999,
          diskAvg: 42.3456,
          diskMax: 67.891,
          samples: 75,
        }),
      ]);

      const result = await service.getMetrics({ range: '24h' });

      expect(result.series).toEqual([
        {
          timestamp: '2026-11-14T10:00:00.000Z',
          cpu: { avg: 41.23, max: 78.1 },
          memory: { avg: 55.56, max: 100 },
          disk: { avg: 42.35, max: 67.89 },
          samples: 75,
        },
      ]);
    });

    it('keeps the order of the buckets and does not fill empty ones', async () => {
      prisma.$queryRaw.mockResolvedValue([
        metricRow('2026-11-14T09:00:00.000Z'),
        metricRow('2026-11-14T11:00:00.000Z'),
      ]);

      const result = await service.getMetrics({ range: '24h' });

      expect(result.series.map((p) => p.timestamp)).toEqual(['2026-11-14T09:00:00.000Z', '2026-11-14T11:00:00.000Z']);
    });

    it('accepts numeric and bigint values returned as strings or bigint by the driver', async () => {
      prisma.$queryRaw.mockResolvedValue([
        metricRow('2026-11-14T10:00:00.000Z', {
          bucket: String(epoch('2026-11-14T10:00:00.000Z')),
          cpuAvg: '41.5',
          cpuMax: '60',
          memoryAvg: '50',
          memoryMax: '70',
          diskAvg: '35.5',
          diskMax: '80',
          samples: BigInt(12),
        }),
      ]);

      const result = await service.getMetrics({ range: '24h' });

      expect(result.series[0]).toEqual({
        timestamp: '2026-11-14T10:00:00.000Z',
        cpu: { avg: 41.5, max: 60 },
        memory: { avg: 50, max: 70 },
        disk: { avg: 35.5, max: 80 },
        samples: 12,
      });
    });

    it('returns an empty series, with the window and server count, when there are no samples (empty results)', async () => {
      const result = await service.getMetrics({ range: '1h' });

      expect(result).toEqual({
        filters: { projectId: null, environmentId: null },
        range: '1h',
        from: '2026-11-14T11:00:00.000Z',
        to: '2026-11-14T12:00:00.000Z',
        bucketSeconds: 60,
        serverCount: 2,
        series: [],
      });
    });

    it('does not query Metric at all when the scope has no server', async () => {
      prisma.server.findMany.mockResolvedValue([]);

      const result = await service.getMetrics({ projectId: PROJECT_ID });

      expect(result.serverCount).toBe(0);
      expect(result.series).toEqual([]);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('aggregates all selected servers in one query, not one query per server (no N+1)', async () => {
      prisma.server.findMany.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ idServer: `srv-${i}` })));

      await service.getMetrics();

      expect(prisma.server.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect((boundSql(prisma).values[1] as string[]).length).toBe(50);
    });
  });

  describe('getMetrics: filters', () => {
    it('selects the servers of the project only, and queries metrics for those servers only', async () => {
      prisma.server.findMany.mockResolvedValue([{ idServer: 'p-srv-1' }]);

      const result = await service.getMetrics({ projectId: PROJECT_ID });

      expect(prisma.server.findMany).toHaveBeenCalledWith({
        where: { env: { projectId: PROJECT_ID } },
        select: { idServer: true },
      });
      expect(boundSql(prisma).values[1]).toEqual(['p-srv-1']);
      expect(result.filters).toEqual({ projectId: PROJECT_ID, environmentId: null });
      expect(result.serverCount).toBe(1);
    });

    it('selects the servers of the environment only', async () => {
      await service.getMetrics({ environmentId: ENV_ID });

      expect(prisma.server.findMany).toHaveBeenCalledWith({ where: { envId: ENV_ID }, select: { idServer: true } });
    });

    it('with both filters, validates the pair and selects the servers of the environment', async () => {
      const result = await service.getMetrics({ projectId: PROJECT_ID, environmentId: ENV_ID, range: '6h' });

      expect(prisma.project.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.environment.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.server.findMany).toHaveBeenCalledWith({ where: { envId: ENV_ID }, select: { idServer: true } });
      expect(result.filters).toEqual({ projectId: PROJECT_ID, environmentId: ENV_ID });
    });

    it('selects every server when no filter is given', async () => {
      await service.getMetrics();

      expect(prisma.server.findMany).toHaveBeenCalledWith({ where: {}, select: { idServer: true } });
    });

    it('rejects unknown ids and an environment of another project before reading any server or metric', async () => {
      prisma.project.findUnique.mockResolvedValueOnce(null);
      const unknownProject = await rejection(service.getMetrics({ projectId: 'nope' }));

      prisma.environment.findUnique.mockResolvedValueOnce(null);
      const unknownEnvironment = await rejection(service.getMetrics({ environmentId: 'nope' }));

      prisma.environment.findUnique.mockResolvedValueOnce({ idEnv: ENV_ID, projectId: 'other-project' });
      const mismatch = await rejection(service.getMetrics({ projectId: PROJECT_ID, environmentId: ENV_ID }));

      for (const error of [unknownProject, unknownEnvironment, mismatch]) {
        expect(error).toBeInstanceOf(NotFoundException);
      }
      expect(mismatch.message).toBe(`Environment with ID ${ENV_ID} not found in project ${PROJECT_ID}`);
      expect(prisma.server.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('getMetrics: the aggregation statement', () => {
    // Guards on the shape of the SQL. They cannot prove how PostgreSQL plans it: that needs
    // EXPLAIN (ANALYZE, BUFFERS) on a real database.
    it('is a single read-only aggregation on Metric by server list and time range, with no join', async () => {
      await service.getMetrics();

      const { text } = boundSql(prisma);
      expect(text.includes('FROM "Metric" m')).toBe(true);
      expect(text.includes('m."serverId" = ANY(')).toBe(true);
      expect(text.includes('m."timestamp" >=')).toBe(true);
      expect(text.includes('m."timestamp" <=')).toBe(true);
      expect(text.includes('date_bin(')).toBe(true);
      expect(text.includes('COUNT(*)::int')).toBe(true);
      expect(text.includes('GROUP BY 1')).toBe(true);
      expect(text.includes('ORDER BY 1')).toBe(true);
      expect(text.includes('JOIN')).toBe(false);
      for (const write of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE']) {
        expect(text.includes(write)).toBe(false);
      }
    });

    it('reads CPU, memory and disk columns for dashboard aggregation', async () => {
      await service.getMetrics();

      const { text } = boundSql(prisma);
      expect(text.includes('"cpuUsage"')).toBe(true);
      expect(text.includes('"memoryUsage"')).toBe(true);
      expect(text.includes('"diskUsage"')).toBe(true);
    });

    it('binds every variable value: four parameters, none written into the statement', async () => {
      await service.getMetrics({ range: '6h' });

      const { strings, values, text } = boundSql(prisma);
      expect(strings.length - 1).toBe(4);
      expect(values.length).toBe(4);
      for (const value of [values[2], values[3], 'srv-1', 'srv-2']) {
        expect(text.includes(String(value))).toBe(false);
      }
    });

    it('is the same statement text whatever the filters, range and server ids', async () => {
      await service.getMetrics({ range: '1h' });
      prisma.server.findMany.mockResolvedValueOnce([{ idServer: `x'); DROP TABLE "Metric"; --` }]);
      await service.getMetrics({ projectId: PROJECT_ID, range: '7d' });

      const first = boundSql(prisma, 0);
      const second = boundSql(prisma, 1);
      expect(second.strings).toEqual(first.strings);
      expect(second.values[1]).toEqual([`x'); DROP TABLE "Metric"; --`]);
      expect(second.text.includes('DROP')).toBe(false);
    });
  });

  describe('getFilters', () => {
    it('lists projects with their environments, sorted by name', async () => {
      const projects = [
        { idProject: 'p1', name: 'Alpha', environments: [{ idEnv: 'e1', name: 'Development' }] },
        { idProject: 'p2', name: 'Beta', environments: [] },
      ];
      prisma.project.findMany.mockResolvedValue(projects);

      const result = await service.getFilters();

      expect(prisma.project.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.project.findMany).toHaveBeenCalledWith({
        select: {
          idProject: true,
          name: true,
          environments: { select: { idEnv: true, name: true }, orderBy: { name: 'asc' } },
        },
        orderBy: { name: 'asc' },
      });
      expect(result).toEqual({ projects });
    });

    it('returns an empty list when there is no project', async () => {
      expect(await service.getFilters()).toEqual({ projects: [] });
    });
  });
});
