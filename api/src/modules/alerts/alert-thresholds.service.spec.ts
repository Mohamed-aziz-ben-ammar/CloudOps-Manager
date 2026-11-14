import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AlertThresholdsService } from './alert-thresholds.service.js';

const ENV_ID = 'env-1';
const SERVER_ID = 'srv-1';

type UpsertArgs = {
  where: { serverId_metric: { serverId: string; metric: string } };
  create: { serverId: string; metric: string; warning: number; critical: number };
  update: { warning: number; critical: number };
};

function setup(env: Record<string, string | undefined> = {}) {
  const prisma = {
    environment: { findUnique: vi.fn().mockResolvedValue({ idEnv: ENV_ID }) },
    server: { findUnique: vi.fn().mockResolvedValue({ idServer: SERVER_ID, envId: ENV_ID }) },
    alertThreshold: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(async (args: UpsertArgs) => args),
    },
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  const config = { get: vi.fn((key: string) => env[key]) };
  const service = new AlertThresholdsService(prisma as never, config as never);
  // Keep test output clean and let tests assert on logging.
  const logger = { warn: vi.fn(), error: vi.fn() };
  (service as unknown as { logger: typeof logger }).logger = logger;
  return { prisma, config, service, logger };
}

// Starts from a valid 80/95 CPU configuration and lets a test change one part of it.
const cpu = (warning: number, critical: number) => ({ cpu: { warning, critical } });
const warnings = (logger: { warn: { mock: { calls: string[][] } } }) => logger.warn.mock.calls.map((c) => c[0]);

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the promise to reject');
}

describe('AlertThresholdsService', () => {
  describe('defaults from the environment', () => {
    it('uses ALERT_*_THRESHOLD as the warning level, with no critical level', () => {
      const { service } = setup({
        ALERT_CPU_THRESHOLD: '80',
        ALERT_MEMORY_THRESHOLD: '70.5',
        ALERT_DISK_THRESHOLD: '0',
      });

      expect(service.getDefaults()).toEqual({
        cpuUsage: { warning: 80, critical: null },
        memoryUsage: { warning: 70.5, critical: null },
        diskUsage: { warning: 0, critical: null },
      });
    });

    it('adds the optional ALERT_*_CRITICAL_THRESHOLD as the critical level', () => {
      const { service, logger } = setup({
        ALERT_CPU_THRESHOLD: '80',
        ALERT_CPU_CRITICAL_THRESHOLD: '95',
        ALERT_DISK_THRESHOLD: '60',
        ALERT_DISK_CRITICAL_THRESHOLD: '85',
      });

      service.onModuleInit();

      expect(service.getDefaults().cpuUsage).toEqual({ warning: 80, critical: 95 });
      expect(service.getDefaults().diskUsage).toEqual({ warning: 60, critical: 85 });
      expect(service.getDefaults().memoryUsage).toBeUndefined();
    });

    it('has no defaults, and warns once per metric, when nothing is configured', () => {
      const { service, logger } = setup({});

      service.onModuleInit();

      expect(service.getDefaults()).toEqual({});
      const messages = warnings(logger);
      expect(messages.length).toBe(3);
      for (const key of ['ALERT_CPU_THRESHOLD', 'ALERT_MEMORY_THRESHOLD', 'ALERT_DISK_THRESHOLD']) {
        expect(messages.some((m) => m.includes(key))).toBe(true);
      }
    });

    for (const value of ['abc', '-1', '100.5', 'NaN']) {
      it(`ignores the invalid warning default "${value}" with a warning`, () => {
        const { service, logger } = setup({ ALERT_CPU_THRESHOLD: value });

        service.onModuleInit();

        expect(service.getDefaults().cpuUsage).toBeUndefined();
        expect(warnings(logger).some((m) => m.includes('ALERT_CPU_THRESHOLD') && m.includes('between 0 and 100'))).toBe(
          true,
        );
      });
    }

    it('treats an empty or blank variable as not set', () => {
      const { service } = setup({ ALERT_CPU_THRESHOLD: '', ALERT_MEMORY_THRESHOLD: '   ' });

      expect(service.getDefaults()).toEqual({});
    });

    const badCriticals: [string, string, string][] = [
      ['equal to the warning level', '80', '80'],
      ['below the warning level', '80', '70'],
      ['not a number', '80', 'abc'],
      ['above 100', '80', '150'],
    ];
    for (const [label, warning, critical] of badCriticals) {
      it(`ignores a critical default that is ${label}, keeping the warning level`, () => {
        const { service, logger } = setup({
          ALERT_CPU_THRESHOLD: warning,
          ALERT_CPU_CRITICAL_THRESHOLD: critical,
        });

        service.onModuleInit();

        expect(service.getDefaults().cpuUsage).toEqual({ warning: Number(warning), critical: null });
        expect(warnings(logger).some((m) => m.includes('ALERT_CPU_CRITICAL_THRESHOLD'))).toBe(true);
      });
    }

    it('ignores a critical default when there is no valid warning default', () => {
      const { service, logger } = setup({ ALERT_CPU_CRITICAL_THRESHOLD: '95' });

      service.onModuleInit();

      expect(service.getDefaults().cpuUsage).toBeUndefined();
      expect(warnings(logger).some((m) => m.includes('ALERT_CPU_CRITICAL_THRESHOLD is ignored'))).toBe(true);
    });

    it('reads the environment once, never while evaluating', async () => {
      const { service, config } = setup({ ALERT_CPU_THRESHOLD: '80' });
      const readsAfterStartup = config.get.mock.calls.length;

      await service.findForServers(['srv-1', 'srv-2']);
      await service.findForServers(['srv-3']);
      await service.get(ENV_ID, SERVER_ID);

      expect(readsAfterStartup > 0).toBe(true);
      expect(config.get.mock.calls.length).toBe(readsAfterStartup);
    });
  });

  describe('findForServers (effective thresholds for the evaluator)', () => {
    it('falls back to the defaults for servers without custom thresholds, with one query', async () => {
      const { prisma, service } = setup({ ALERT_CPU_THRESHOLD: '80', ALERT_CPU_CRITICAL_THRESHOLD: '95' });

      const result = await service.findForServers(['srv-1', 'srv-2']);

      expect(prisma.alertThreshold.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.alertThreshold.findMany).toHaveBeenCalledWith({ where: { serverId: { in: ['srv-1', 'srv-2'] } } });
      expect(result.get('srv-1')).toEqual({ cpuUsage: { warning: 80, critical: 95 } });
      expect(result.get('srv-2')).toEqual({ cpuUsage: { warning: 80, critical: 95 } });
    });

    it('lets a custom row override the default of that metric only, for that server only', async () => {
      const { prisma, service } = setup({
        ALERT_CPU_THRESHOLD: '80',
        ALERT_MEMORY_THRESHOLD: '70',
        ALERT_DISK_THRESHOLD: '60',
      });
      prisma.alertThreshold.findMany.mockResolvedValue([
        { serverId: 'srv-1', metric: 'CPU', warning: 50, critical: 75 },
        { serverId: 'srv-1', metric: 'Disk', warning: 40, critical: 55 },
      ]);

      const result = await service.findForServers(['srv-1', 'srv-2']);

      expect(result.get('srv-1')).toEqual({
        cpuUsage: { warning: 50, critical: 75 },
        memoryUsage: { warning: 70, critical: null },
        diskUsage: { warning: 40, critical: 55 },
      });
      expect(result.get('srv-2')).toEqual({
        cpuUsage: { warning: 80, critical: null },
        memoryUsage: { warning: 70, critical: null },
        diskUsage: { warning: 60, critical: null },
      });
    });

    it('evaluates a metric with a custom row even when no default exists', async () => {
      const { prisma, service } = setup({});
      prisma.alertThreshold.findMany.mockResolvedValue([
        { serverId: 'srv-1', metric: 'Memory', warning: 60, critical: 80 },
      ]);

      const result = await service.findForServers(['srv-1']);

      expect(result.get('srv-1')).toEqual({ memoryUsage: { warning: 60, critical: 80 } });
    });

    it('returns an empty configuration for a server with neither custom row nor defaults', async () => {
      const { service } = setup({});

      expect((await service.findForServers(['srv-1'])).get('srv-1')).toEqual({});
    });
  });

  describe('get', () => {
    it('reports defaults, with their source, for a server without custom thresholds', async () => {
      const { service } = setup({ ALERT_CPU_THRESHOLD: '80', ALERT_CPU_CRITICAL_THRESHOLD: '95' });

      const result = await service.get(ENV_ID, SERVER_ID);

      expect(result).toEqual({
        serverId: SERVER_ID,
        cpu: { warning: 80, critical: 95, source: 'default' },
        memory: { warning: null, critical: null, source: 'default' },
        disk: { warning: null, critical: null, source: 'default' },
      });
    });

    it('reports custom thresholds with their source, next to defaults for the other metrics', async () => {
      const { prisma, service } = setup({ ALERT_DISK_THRESHOLD: '60' });
      prisma.alertThreshold.findMany.mockResolvedValue([
        { serverId: SERVER_ID, metric: 'CPU', warning: 50, critical: 75 },
      ]);

      const result = await service.get(ENV_ID, SERVER_ID);

      expect(result.cpu).toEqual({ warning: 50, critical: 75, source: 'custom' });
      expect(result.disk).toEqual({ warning: 60, critical: null, source: 'default' });
    });

    it('throws NotFoundException when the environment does not exist', async () => {
      const { prisma, service } = setup();
      prisma.environment.findUnique.mockResolvedValue(null);

      const error = await rejection(service.get(ENV_ID, SERVER_ID));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(`Environment with ID ${ENV_ID} not found`);
    });

    it('throws NotFoundException when the server does not exist or belongs to another environment', async () => {
      const { prisma, service } = setup();
      prisma.server.findUnique.mockResolvedValueOnce(null);
      prisma.server.findUnique.mockResolvedValueOnce({ idServer: SERVER_ID, envId: 'other-env' });

      for (let i = 0; i < 2; i++) {
        const error = await rejection(service.get(ENV_ID, SERVER_ID));
        expect(error).toBeInstanceOf(NotFoundException);
        expect(error.message).toBe(`Server with ID ${SERVER_ID} not found in environment ${ENV_ID}`);
      }
    });
  });

  describe('upsert', () => {
    it('saves a valid configuration for one metric and returns the resulting thresholds', async () => {
      const { prisma, service } = setup();
      prisma.alertThreshold.findMany.mockResolvedValue([
        { serverId: SERVER_ID, metric: 'CPU', warning: 70, critical: 90 },
      ]);

      const result = await service.upsert(ENV_ID, SERVER_ID, cpu(70, 90));

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.alertThreshold.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.alertThreshold.upsert).toHaveBeenCalledWith({
        where: { serverId_metric: { serverId: SERVER_ID, metric: 'CPU' } },
        create: { serverId: SERVER_ID, metric: 'CPU', warning: 70, critical: 90 },
        update: { warning: 70, critical: 90 },
      });
      expect(result.message).toBe('Alert thresholds saved successfully');
      expect(result.thresholds.cpu).toEqual({ warning: 70, critical: 90, source: 'custom' });
    });

    it('saves cpu, memory and disk together, all in one transaction', async () => {
      const { prisma, service } = setup();

      await service.upsert(ENV_ID, SERVER_ID, {
        cpu: { warning: 70, critical: 90 },
        memory: { warning: 60, critical: 80 },
        disk: { warning: 50, critical: 75 },
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const saved = prisma.alertThreshold.upsert.mock.calls.map(([args]) => [args.create.metric, args.create.warning, args.create.critical]);
      expect(saved).toEqual([
        ['CPU', 70, 90],
        ['Memory', 60, 80],
        ['Disk', 50, 75],
      ]);
    });

    it('only touches the metrics that were provided', async () => {
      const { prisma, service } = setup();

      await service.upsert(ENV_ID, SERVER_ID, { disk: { warning: 50, critical: 75 } });

      expect(prisma.alertThreshold.upsert.mock.calls.map(([args]) => args.create.metric)).toEqual(['Disk']);
    });

    it('updates an existing configuration through the update branch of the upsert', async () => {
      const { prisma, service } = setup();
      prisma.alertThreshold.findMany.mockResolvedValue([
        { serverId: SERVER_ID, metric: 'CPU', warning: 55, critical: 65 },
      ]);

      const result = await service.upsert(ENV_ID, SERVER_ID, cpu(55, 65));

      const [args] = prisma.alertThreshold.upsert.mock.calls[0];
      expect(args.update).toEqual({ warning: 55, critical: 65 });
      expect(args.where).toEqual({ serverId_metric: { serverId: SERVER_ID, metric: 'CPU' } });
      expect(result.thresholds.cpu).toEqual({ warning: 55, critical: 65, source: 'custom' });
    });

    it('accepts the boundary values 0 and 100', async () => {
      const { prisma, service } = setup();

      await service.upsert(ENV_ID, SERVER_ID, cpu(0, 100));
      await service.upsert(ENV_ID, SERVER_ID, cpu(99.9, 100));

      expect(prisma.alertThreshold.upsert).toHaveBeenCalledTimes(2);
    });

    const outOfRange: [string, number][] = [
      ['below 0', -0.1],
      ['above 100', 100.1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ];
    for (const [label, value] of outOfRange) {
      it(`rejects a warning threshold ${label}`, async () => {
        const { prisma, service } = setup();

        const error = await rejection(service.upsert(ENV_ID, SERVER_ID, cpu(value, 90)));

        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe('cpu.warning must be a number between 0 and 100');
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it(`rejects a critical threshold ${label}`, async () => {
        const { prisma, service } = setup();

        const error = await rejection(service.upsert(ENV_ID, SERVER_ID, { memory: { warning: 50, critical: value } }));

        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe('memory.critical must be a number between 0 and 100');
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    }

    it('rejects values that are not numbers', async () => {
      const { prisma, service } = setup();

      const error = await rejection(service.upsert(ENV_ID, SERVER_ID, cpu('80' as never, 90)));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a critical threshold equal to the warning threshold', async () => {
      const { prisma, service } = setup();

      const error = await rejection(service.upsert(ENV_ID, SERVER_ID, cpu(80, 80)));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe('cpu.critical must be greater than cpu.warning');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a critical threshold below the warning threshold', async () => {
      const { prisma, service } = setup();

      const error = await rejection(service.upsert(ENV_ID, SERVER_ID, { disk: { warning: 90, critical: 70 } }));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe('disk.critical must be greater than disk.warning');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('saves nothing when only one of several metrics is invalid', async () => {
      const { prisma, service } = setup();

      const error = await rejection(
        service.upsert(ENV_ID, SERVER_ID, { cpu: { warning: 70, critical: 90 }, disk: { warning: 80, critical: 80 } }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(prisma.alertThreshold.upsert).not.toHaveBeenCalled();
    });

    it('rejects a request that provides no metric', async () => {
      const { prisma, service } = setup();

      const error = await rejection(service.upsert(ENV_ID, SERVER_ID, {}));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe('At least one of cpu, memory or disk must be provided');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the environment does not exist', async () => {
      const { prisma, service } = setup();
      prisma.environment.findUnique.mockResolvedValue(null);

      const error = await rejection(service.upsert(ENV_ID, SERVER_ID, cpu(70, 90)));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the server does not exist or belongs to another environment', async () => {
      const { prisma, service } = setup();
      prisma.server.findUnique.mockResolvedValueOnce(null);
      prisma.server.findUnique.mockResolvedValueOnce({ idServer: SERVER_ID, envId: 'other-env' });

      for (let i = 0; i < 2; i++) {
        const error = await rejection(service.upsert(ENV_ID, SERVER_ID, cpu(70, 90)));
        expect(error).toBeInstanceOf(NotFoundException);
        expect(error.message).toBe(`Server with ID ${SERVER_ID} not found in environment ${ENV_ID}`);
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
