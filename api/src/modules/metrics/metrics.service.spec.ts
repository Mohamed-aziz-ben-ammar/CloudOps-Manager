import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FUTURE_TOLERANCE_MS, MAX_LIMIT, MetricsService } from './metrics.service.js';

const ENV_ID = 'env-1';
const SERVER_ID = 'srv-1';

function createPrismaMock() {
  return {
    environment: { findUnique: vi.fn() },
    server: { findUnique: vi.fn() },
    metric: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
  };
}

function createAlertEvaluatorMock() {
  return { evaluate: vi.fn().mockResolvedValue({ created: 0, updated: 0, resolved: 0 }) };
}

// Resolves with the rejection reason (and fails if the promise does not reject),
// so assertions can check both the exception type and its message.
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the promise to reject');
}

describe('MetricsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let alertEvaluator: ReturnType<typeof createAlertEvaluatorMock>;
  let service: MetricsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.environment.findUnique.mockResolvedValue({ idEnv: ENV_ID });
    prisma.server.findUnique.mockResolvedValue({ idServer: SERVER_ID, envId: ENV_ID });
    alertEvaluator = createAlertEvaluatorMock();
    service = new MetricsService(prisma as never, alertEvaluator as never);
  });

  describe('server / environment resolution', () => {
    const calls: [string, () => Promise<unknown>][] = [
      ['create', () => service.create(ENV_ID, SERVER_ID, { cpuUsage: 1, memoryUsage: 1, diskUsage: 1 })],
      ['findAll', () => service.findAll(ENV_ID, SERVER_ID)],
      ['findLatest', () => service.findLatest(ENV_ID, SERVER_ID)],
      ['findOne', () => service.findOne(ENV_ID, SERVER_ID, 'metric-1')],
    ];

    for (const [name, call] of calls) {
      it(`${name} throws NotFoundException when the environment does not exist`, async () => {
        prisma.environment.findUnique.mockResolvedValue(null);

        const error = await rejection(call());

        expect(error).toBeInstanceOf(NotFoundException);
        expect(error.message).toBe(`Environment with ID ${ENV_ID} not found`);
        expect(prisma.server.findUnique).not.toHaveBeenCalled();
      });

      it(`${name} throws NotFoundException when the server does not exist`, async () => {
        prisma.server.findUnique.mockResolvedValue(null);

        const error = await rejection(call());

        expect(error).toBeInstanceOf(NotFoundException);
        expect(error.message).toBe(`Server with ID ${SERVER_ID} not found in environment ${ENV_ID}`);
        expect(prisma.metric.create).not.toHaveBeenCalled();
        expect(prisma.metric.findMany).not.toHaveBeenCalled();
        expect(prisma.metric.findFirst).not.toHaveBeenCalled();
        expect(prisma.metric.findUnique).not.toHaveBeenCalled();
      });

      it(`${name} throws NotFoundException when the server belongs to another environment`, async () => {
        prisma.server.findUnique.mockResolvedValue({ idServer: SERVER_ID, envId: 'other-env' });

        const error = await rejection(call());

        expect(error).toBeInstanceOf(NotFoundException);
        expect(error.message).toBe(`Server with ID ${SERVER_ID} not found in environment ${ENV_ID}`);
      });
    }
  });

  describe('create', () => {
    const valid = { cpuUsage: 45.5, memoryUsage: 62.3, diskUsage: 71.8 };

    it('records a metric and lets the database default the timestamp', async () => {
      const metric = { idMetric: 'm-1', serverId: SERVER_ID, ...valid };
      prisma.metric.create.mockResolvedValue(metric);

      const result = await service.create(ENV_ID, SERVER_ID, valid);

      expect(prisma.metric.create).toHaveBeenCalledWith({ data: { serverId: SERVER_ID, ...valid } });
      expect(result).toEqual({ message: 'Metric recorded successfully', metric });
    });

    it('passes an explicit timestamp to Prisma as a Date', async () => {
      prisma.metric.create.mockResolvedValue({});

      await service.create(ENV_ID, SERVER_ID, { ...valid, timestamp: '2026-11-12T10:30:00.000Z' });

      expect(prisma.metric.create).toHaveBeenCalledWith({
        data: { serverId: SERVER_ID, ...valid, timestamp: new Date('2026-11-12T10:30:00.000Z') },
      });
    });

    it('accepts the boundary values 0 and 100', async () => {
      prisma.metric.create.mockResolvedValue({});

      await service.create(ENV_ID, SERVER_ID, { cpuUsage: 0, memoryUsage: 100, diskUsage: 0 });

      expect(prisma.metric.create).toHaveBeenCalledTimes(1);
    });

    it('accepts a timestamp slightly ahead of the server clock (within tolerance)', async () => {
      prisma.metric.create.mockResolvedValue({});
      const slightlyAhead = new Date(Date.now() + FUTURE_TOLERANCE_MS / 2).toISOString();

      await service.create(ENV_ID, SERVER_ID, { ...valid, timestamp: slightlyAhead });

      expect(prisma.metric.create).toHaveBeenCalledTimes(1);
    });

    const invalidValues: [string, unknown][] = [
      ['cpuUsage', -1],
      ['cpuUsage', 100.01],
      ['memoryUsage', 101],
      ['memoryUsage', Number.POSITIVE_INFINITY],
      ['diskUsage', -0.5],
      ['diskUsage', Number.NaN],
      ['cpuUsage', '50'],
      ['memoryUsage', undefined],
    ];

    for (const [field, value] of invalidValues) {
      it(`rejects ${field} = ${String(value)} with BadRequestException`, async () => {
        const dto = { ...valid, [field]: value } as never;

        const error = await rejection(service.create(ENV_ID, SERVER_ID, dto));

        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe(`${field} must be a number between 0 and 100`);
        expect(prisma.metric.create).not.toHaveBeenCalled();
      });
    }

    it('hands the stored reading to the alert evaluator after the metric is saved', async () => {
      const order: string[] = [];
      prisma.metric.create = vi.fn(async () => {
        order.push('create');
        return { idMetric: 'm-1' };
      });
      alertEvaluator.evaluate = vi.fn(async () => {
        order.push('evaluate');
        return { created: 0, updated: 0, resolved: 0 };
      });

      await service.create(ENV_ID, SERVER_ID, valid);

      expect(order).toEqual(['create', 'evaluate']);
      expect(alertEvaluator.evaluate).toHaveBeenCalledTimes(1);
      expect(alertEvaluator.evaluate).toHaveBeenCalledWith([{ serverId: SERVER_ID, ...valid }]);
    });

    it('still returns the recorded metric when the evaluator creates no alert', async () => {
      const metric = { idMetric: 'm-1', serverId: SERVER_ID, ...valid };
      prisma.metric.create.mockResolvedValue(metric);

      const result = await service.create(ENV_ID, SERVER_ID, valid);

      expect(result).toEqual({ message: 'Metric recorded successfully', metric });
    });

    it('does not evaluate alerts when the values are invalid', async () => {
      await rejection(service.create(ENV_ID, SERVER_ID, { ...valid, cpuUsage: 150 }));

      expect(alertEvaluator.evaluate).not.toHaveBeenCalled();
    });

    it('does not evaluate alerts when the server does not exist', async () => {
      prisma.server.findUnique.mockResolvedValue(null);

      await rejection(service.create(ENV_ID, SERVER_ID, valid));

      expect(alertEvaluator.evaluate).not.toHaveBeenCalled();
    });

    it('rejects a timestamp that is not a valid date', async () => {
      const error = await rejection(service.create(ENV_ID, SERVER_ID, { ...valid, timestamp: 'not-a-date' }));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe('timestamp must be a valid ISO 8601 date');
      expect(prisma.metric.create).not.toHaveBeenCalled();
    });

    it('rejects a timestamp in the future', async () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const error = await rejection(service.create(ENV_ID, SERVER_ID, { ...valid, timestamp: tomorrow }));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe('timestamp cannot be in the future');
      expect(prisma.metric.create).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    const orderBy = [{ timestamp: 'desc' }, { idMetric: 'asc' }];

    it('returns the newest metrics with default pagination metadata', async () => {
      const rows = [{ idMetric: 'm-2' }, { idMetric: 'm-1' }];
      prisma.metric.findMany.mockResolvedValue(rows);
      prisma.metric.count.mockResolvedValue(25);

      const result = await service.findAll(ENV_ID, SERVER_ID);

      expect(prisma.metric.findMany).toHaveBeenCalledWith({
        where: { serverId: SERVER_ID },
        orderBy,
        skip: 0,
        take: 10,
      });
      expect(prisma.metric.count).toHaveBeenCalledWith({ where: { serverId: SERVER_ID } });
      expect(result).toEqual({ data: rows, meta: { total: 25, page: 1, limit: 10, totalPages: 3 } });
    });

    it('applies the date range and pagination', async () => {
      prisma.metric.findMany.mockResolvedValue([]);
      prisma.metric.count.mockResolvedValue(0);

      await service.findAll(ENV_ID, SERVER_ID, {
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-02T00:00:00.000Z',
        page: 3,
        limit: 5,
      });

      const where = {
        serverId: SERVER_ID,
        timestamp: { gte: new Date('2026-11-01T00:00:00.000Z'), lte: new Date('2026-11-02T00:00:00.000Z') },
      };
      expect(prisma.metric.findMany).toHaveBeenCalledWith({ where, orderBy, skip: 10, take: 5 });
      expect(prisma.metric.count).toHaveBeenCalledWith({ where });
    });

    it('only filters on the bound that was provided', async () => {
      prisma.metric.findMany.mockResolvedValue([]);
      prisma.metric.count.mockResolvedValue(0);

      await service.findAll(ENV_ID, SERVER_ID, { from: '2026-11-01T00:00:00.000Z' });

      expect(prisma.metric.count).toHaveBeenCalledWith({
        where: { serverId: SERVER_ID, timestamp: { gte: new Date('2026-11-01T00:00:00.000Z') } },
      });
    });

    it('returns an empty page with totalPages 0 when there are no metrics', async () => {
      prisma.metric.findMany.mockResolvedValue([]);
      prisma.metric.count.mockResolvedValue(0);

      const result = await service.findAll(ENV_ID, SERVER_ID);

      expect(result).toEqual({ data: [], meta: { total: 0, page: 1, limit: 10, totalPages: 0 } });
    });

    const invalidQueries: [string, Parameters<MetricsService['findAll']>[2], string][] = [
      ['page 0', { page: 0 }, 'page must be an integer greater than or equal to 1'],
      ['a fractional page', { page: 1.5 }, 'page must be an integer greater than or equal to 1'],
      ['limit 0', { limit: 0 }, `limit must be an integer between 1 and ${MAX_LIMIT}`],
      ['limit above the maximum', { limit: MAX_LIMIT + 1 }, `limit must be an integer between 1 and ${MAX_LIMIT}`],
      ['an invalid from date', { from: 'yesterday-ish' }, 'from must be a valid ISO 8601 date'],
      ['an invalid to date', { to: '31/02/2026' }, 'to must be a valid ISO 8601 date'],
      [
        'from later than to',
        { from: '2026-11-02T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
        'from must be earlier than or equal to to',
      ],
    ];

    for (const [label, query, message] of invalidQueries) {
      it(`rejects ${label} with BadRequestException`, async () => {
        const error = await rejection(service.findAll(ENV_ID, SERVER_ID, query));

        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe(message);
        expect(prisma.metric.findMany).not.toHaveBeenCalled();
      });
    }
  });

  describe('findLatest', () => {
    it('returns the most recent metric of the server', async () => {
      const latest = { idMetric: 'm-9', serverId: SERVER_ID };
      prisma.metric.findFirst.mockResolvedValue(latest);

      const result = await service.findLatest(ENV_ID, SERVER_ID);

      expect(prisma.metric.findFirst).toHaveBeenCalledWith({
        where: { serverId: SERVER_ID },
        orderBy: [{ timestamp: 'desc' }, { idMetric: 'asc' }],
      });
      expect(result).toBe(latest);
    });

    it('throws NotFoundException when the server has no metrics yet', async () => {
      prisma.metric.findFirst.mockResolvedValue(null);

      const error = await rejection(service.findLatest(ENV_ID, SERVER_ID));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(`No metrics recorded for server ${SERVER_ID}`);
    });
  });

  describe('findOne', () => {
    it('returns the metric when it belongs to the server', async () => {
      const metric = { idMetric: 'm-1', serverId: SERVER_ID };
      prisma.metric.findUnique.mockResolvedValue(metric);

      const result = await service.findOne(ENV_ID, SERVER_ID, 'm-1');

      expect(prisma.metric.findUnique).toHaveBeenCalledWith({ where: { idMetric: 'm-1' } });
      expect(result).toBe(metric);
    });

    it('throws NotFoundException when the metric does not exist', async () => {
      prisma.metric.findUnique.mockResolvedValue(null);

      const error = await rejection(service.findOne(ENV_ID, SERVER_ID, 'missing'));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(`Metric with ID missing not found for server ${SERVER_ID}`);
    });

    it('does not leak a metric that belongs to another server', async () => {
      prisma.metric.findUnique.mockResolvedValue({ idMetric: 'm-1', serverId: 'other-server' });

      const error = await rejection(service.findOne(ENV_ID, SERVER_ID, 'm-1'));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(`Metric with ID m-1 not found for server ${SERVER_ID}`);
    });
  });
});
