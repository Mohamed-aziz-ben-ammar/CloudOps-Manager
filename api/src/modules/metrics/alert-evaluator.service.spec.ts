import { AlertStatus } from '@prisma/client';
import { AlertEvaluatorService } from './alert-evaluator.service.js';

const ALL_THRESHOLDS = {
  ALERT_CPU_THRESHOLD: '80',
  ALERT_MEMORY_THRESHOLD: '85',
  ALERT_DISK_THRESHOLD: '90',
};

function setup(env: Record<string, string | undefined> = ALL_THRESHOLDS, activeAlerts: unknown[] = []) {
  const prisma = {
    alert: {
      findMany: vi.fn().mockResolvedValue(activeAlerts),
      createMany: vi.fn(async ({ data }: { data: { serverId: string; type: string; message: string }[] }) => ({ count: data.length })),
    },
  };
  const config = { get: vi.fn((key: string) => env[key]) };
  const service = new AlertEvaluatorService(prisma as never, config as never);
  // Keep test output clean and let tests assert on logging.
  const logger = { warn: vi.fn(), error: vi.fn() };
  (service as unknown as { logger: typeof logger }).logger = logger;
  return { prisma, service, logger };
}

const within = { cpuUsage: 10, memoryUsage: 10, diskUsage: 10 };
const reading = (overrides: Partial<typeof within> = {}, serverId = 'srv-1') => ({
  serverId,
  ...within,
  ...overrides,
});

describe('AlertEvaluatorService', () => {
  describe('a metric above its threshold creates an alert', () => {
    it('CPU usage', async () => {
      const { prisma, service } = setup();

      const created = await service.evaluate([reading({ cpuUsage: 80.5 })]);

      expect(created).toBe(1);
      expect(prisma.alert.createMany).toHaveBeenCalledWith({
        data: [{ serverId: 'srv-1', type: 'HighCPU', message: 'CPU usage is 80.5%, above the 80% threshold' }],
      });
    });

    it('memory usage', async () => {
      const { prisma, service } = setup();

      const created = await service.evaluate([reading({ memoryUsage: 91 })]);

      expect(created).toBe(1);
      expect(prisma.alert.createMany).toHaveBeenCalledWith({
        data: [{ serverId: 'srv-1', type: 'HighMemory', message: 'Memory usage is 91%, above the 85% threshold' }],
      });
    });

    it('disk usage', async () => {
      const { prisma, service } = setup();

      const created = await service.evaluate([reading({ diskUsage: 97.2 })]);

      expect(created).toBe(1);
      expect(prisma.alert.createMany).toHaveBeenCalledWith({
        data: [{ serverId: 'srv-1', type: 'HighDisk', message: 'Disk usage is 97.2%, above the 90% threshold' }],
      });
    });

    it('creates one alert per exceeded metric in a single insert', async () => {
      const { prisma, service } = setup();

      const created = await service.evaluate([reading({ cpuUsage: 99, memoryUsage: 99, diskUsage: 99 })]);

      expect(created).toBe(3);
      expect(prisma.alert.createMany).toHaveBeenCalledTimes(1);
      const { data } = prisma.alert.createMany.mock.calls[0][0];
      expect(data.map((a: { type: string }) => a.type)).toEqual(['HighCPU', 'HighMemory', 'HighDisk']);
    });

    it('evaluates every reading of a batch, each for its own server', async () => {
      const { prisma, service } = setup();

      const created = await service.evaluate([
        reading({ cpuUsage: 95 }, 'srv-1'),
        reading({}, 'srv-2'),
        reading({ diskUsage: 95 }, 'srv-3'),
      ]);

      expect(created).toBe(2);
      const { data } = prisma.alert.createMany.mock.calls[0][0];
      expect(data.map((a: { serverId: string; type: string }) => `${a.serverId}:${a.type}`)).toEqual([
        'srv-1:HighCPU',
        'srv-3:HighDisk',
      ]);
    });

    it('leaves severity and status to the Alert model defaults', async () => {
      const { prisma, service } = setup();

      await service.evaluate([reading({ cpuUsage: 99 })]);

      const [alert] = prisma.alert.createMany.mock.calls[0][0].data;
      expect(Object.keys(alert).sort()).toEqual(['message', 'serverId', 'type']);
    });
  });

  describe('a metric within its threshold creates nothing', () => {
    const cases: [string, Partial<typeof within>][] = [
      ['well below the thresholds', { cpuUsage: 10, memoryUsage: 10, diskUsage: 10 }],
      ['exactly at every threshold', { cpuUsage: 80, memoryUsage: 85, diskUsage: 90 }],
      ['just below every threshold', { cpuUsage: 79.99, memoryUsage: 84.99, diskUsage: 89.99 }],
      ['zero usage', { cpuUsage: 0, memoryUsage: 0, diskUsage: 0 }],
    ];

    for (const [label, values] of cases) {
      it(`${label}`, async () => {
        const { prisma, service } = setup();

        const created = await service.evaluate([reading(values)]);

        expect(created).toBe(0);
        expect(prisma.alert.findMany).not.toHaveBeenCalled();
        expect(prisma.alert.createMany).not.toHaveBeenCalled();
      });
    }

    it('an empty batch', async () => {
      const { prisma, service } = setup();

      expect(await service.evaluate([])).toBe(0);
      expect(prisma.alert.createMany).not.toHaveBeenCalled();
    });

    it('readings that are not finite numbers', async () => {
      const { prisma, service } = setup();

      const created = await service.evaluate([
        reading({ cpuUsage: Number.NaN, memoryUsage: Number.POSITIVE_INFINITY, diskUsage: undefined as never }),
      ]);

      expect(created).toBe(0);
      expect(prisma.alert.createMany).not.toHaveBeenCalled();
    });
  });

  describe('threshold configuration', () => {
    it('evaluates nothing, and queries nothing, when no threshold is configured', async () => {
      const { prisma, service } = setup({});

      const created = await service.evaluate([reading({ cpuUsage: 100, memoryUsage: 100, diskUsage: 100 })]);

      expect(created).toBe(0);
      expect(prisma.alert.findMany).not.toHaveBeenCalled();
      expect(prisma.alert.createMany).not.toHaveBeenCalled();
    });

    it('only evaluates the metrics that have a threshold', async () => {
      const { prisma, service } = setup({ ALERT_DISK_THRESHOLD: '50' });

      await service.evaluate([reading({ cpuUsage: 100, memoryUsage: 100, diskUsage: 60 })]);

      const { data } = prisma.alert.createMany.mock.calls[0][0];
      expect(data.map((a: { type: string }) => a.type)).toEqual(['HighDisk']);
    });

    for (const value of ['abc', '-1', '100.5', '', '   ', 'NaN']) {
      it(`ignores the invalid threshold "${value}"`, async () => {
        const { prisma, service } = setup({ ALERT_CPU_THRESHOLD: value });

        const created = await service.evaluate([reading({ cpuUsage: 100 })]);

        expect(created).toBe(0);
        expect(prisma.alert.createMany).not.toHaveBeenCalled();
      });
    }

    it('accepts 0 as a threshold: any usage above 0 alerts, usage of exactly 0 does not', async () => {
      const { prisma, service } = setup({ ALERT_CPU_THRESHOLD: '0' });

      expect(await service.evaluate([reading({ cpuUsage: 0 })])).toBe(0);
      expect(await service.evaluate([reading({ cpuUsage: 0.01 })])).toBe(1);
      expect(prisma.alert.createMany).toHaveBeenCalledTimes(1);
    });

    it('warns once per unset or invalid threshold when the module starts', () => {
      const { service, logger } = setup({ ALERT_CPU_THRESHOLD: '80', ALERT_MEMORY_THRESHOLD: 'abc' });

      service.onModuleInit();

      expect(logger.warn).toHaveBeenCalledTimes(2);
      const messages = logger.warn.mock.calls.map((c: string[]) => c[0]);
      expect(messages.some((m: string) => m.includes('ALERT_MEMORY_THRESHOLD'))).toBe(true);
      expect(messages.some((m: string) => m.includes('ALERT_DISK_THRESHOLD'))).toBe(true);
    });

    for (const value of ['150', '-1', '101']) {
      it(`warns that "${value}" is outside 0-100 and does not use it`, async () => {
        const { prisma, service, logger } = setup({ ...ALL_THRESHOLDS, ALERT_DISK_THRESHOLD: value });

        service.onModuleInit();
        const created = await service.evaluate([reading({ diskUsage: 100 })]);

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0].includes('ALERT_DISK_THRESHOLD')).toBe(true);
        expect(created).toBe(0);
        expect(prisma.alert.createMany).not.toHaveBeenCalled();
      });
    }

    it('does not warn when every threshold is configured', () => {
      const { service, logger } = setup();

      service.onModuleInit();

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('no duplicate alerts while one is already Active', () => {
    it('skips a type that already has an Active alert for the server', async () => {
      const { prisma, service } = setup(ALL_THRESHOLDS, [{ serverId: 'srv-1', type: 'HighCPU' }]);

      const created = await service.evaluate([reading({ cpuUsage: 99, diskUsage: 99 })]);

      expect(created).toBe(1);
      expect(prisma.alert.findMany).toHaveBeenCalledWith({
        where: {
          status: AlertStatus.Active,
          serverId: { in: ['srv-1'] },
          type: { in: ['HighCPU', 'HighDisk'] },
        },
        select: { serverId: true, type: true },
      });
      const { data } = prisma.alert.createMany.mock.calls[0][0];
      expect(data.map((a: { type: string }) => a.type)).toEqual(['HighDisk']);
    });

    it('does not insert at all when every breach is already Active', async () => {
      const { prisma, service } = setup(ALL_THRESHOLDS, [{ serverId: 'srv-1', type: 'HighCPU' }]);

      expect(await service.evaluate([reading({ cpuUsage: 99 })])).toBe(0);
      expect(prisma.alert.createMany).not.toHaveBeenCalled();
    });

    it('only suppresses the same server: another server still gets its alert', async () => {
      const { prisma, service } = setup(ALL_THRESHOLDS, [{ serverId: 'srv-1', type: 'HighCPU' }]);

      await service.evaluate([reading({ cpuUsage: 99 }, 'srv-1'), reading({ cpuUsage: 99 }, 'srv-2')]);

      const { data } = prisma.alert.createMany.mock.calls[0][0];
      expect(data.map((a: { serverId: string }) => a.serverId)).toEqual(['srv-2']);
    });

    it('collapses duplicates inside one batch', async () => {
      const { prisma, service } = setup();

      await service.evaluate([reading({ cpuUsage: 99 }), reading({ cpuUsage: 98 })]);

      expect(prisma.alert.createMany.mock.calls[0][0].data.length).toBe(1);
    });
  });

  describe('alert creation errors', () => {
    it('logs and swallows a failure while creating alerts', async () => {
      const { prisma, service, logger } = setup();
      prisma.alert.createMany.mockRejectedValueOnce(new Error('insert failed'));

      const created = await service.evaluate([reading({ cpuUsage: 99 })]);

      expect(created).toBe(0);
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('logs and swallows a failure while looking for existing alerts, without inserting', async () => {
      const { prisma, service, logger } = setup();
      prisma.alert.findMany.mockRejectedValueOnce(new Error('db down'));

      const created = await service.evaluate([reading({ cpuUsage: 99 })]);

      expect(created).toBe(0);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(prisma.alert.createMany).not.toHaveBeenCalled();
    });

    it('keeps working on the next call after a failure', async () => {
      const { prisma, service } = setup();
      prisma.alert.createMany.mockRejectedValueOnce(new Error('insert failed'));

      await service.evaluate([reading({ cpuUsage: 99 })]);
      const created = await service.evaluate([reading({ cpuUsage: 99 })]);

      expect(created).toBe(1);
    });
  });
});
