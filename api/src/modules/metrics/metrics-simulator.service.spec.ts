import { ServerStatus } from '@prisma/client';
import {
  DEFAULT_SIMULATION_INTERVAL_MS,
  MetricsSimulatorService,
} from './metrics-simulator.service.js';

function setup(env: Record<string, string | undefined> = {}) {
  const prisma = {
    server: { findMany: vi.fn() },
    metric: { createMany: vi.fn() },
  };
  const config = { get: vi.fn((key: string) => env[key]) };
  const alertEvaluator = { evaluate: vi.fn().mockResolvedValue({ created: 0, updated: 0, resolved: 0 }) };
  const service = new MetricsSimulatorService(prisma as never, config as never, alertEvaluator as never);
  // Keep test output clean and let tests assert on logging.
  const logger = { log: vi.fn(), error: vi.fn() };
  (service as unknown as { logger: typeof logger }).logger = logger;
  return { prisma, service, logger, alertEvaluator };
}

const timerOf = (service: MetricsSimulatorService) => (service as unknown as { timer?: unknown }).timer;
const stateOf = (service: MetricsSimulatorService) =>
  (service as unknown as { state: Map<string, unknown> }).state;

describe('MetricsSimulatorService', () => {
  describe('configuration', () => {
    it('is enabled with a 60 s interval by default', () => {
      const { service } = setup();

      expect(service.enabled).toBe(true);
      expect(service.intervalMs).toBe(DEFAULT_SIMULATION_INTERVAL_MS);
    });

    for (const value of ['false', '0', 'off', 'NO', ' False ']) {
      it(`can be disabled with METRICS_SIMULATION_ENABLED="${value}"`, () => {
        const { service } = setup({ METRICS_SIMULATION_ENABLED: value });

        expect(service.enabled).toBe(false);
        service.onModuleInit();
        expect(timerOf(service)).toBeUndefined();
      });
    }

    it('honours a valid METRICS_SIMULATION_INTERVAL_MS', () => {
      const { service } = setup({ METRICS_SIMULATION_INTERVAL_MS: '5000' });

      expect(service.intervalMs).toBe(5000);
    });

    for (const value of ['500', 'abc', '', '-10']) {
      it(`falls back to the default interval for METRICS_SIMULATION_INTERVAL_MS="${value}"`, () => {
        const { service } = setup({ METRICS_SIMULATION_INTERVAL_MS: value });

        expect(service.intervalMs).toBe(DEFAULT_SIMULATION_INTERVAL_MS);
      });
    }

    it('starts a timer on init and clears it on destroy', () => {
      const { service } = setup();

      service.onModuleInit();
      expect(timerOf(service)).toBeDefined();

      service.onModuleDestroy();
      expect(timerOf(service)).toBeUndefined();
    });
  });

  describe('generateMetrics', () => {
    it('only looks at Running servers and writes one sample per server with a shared timestamp', async () => {
      const { prisma, service } = setup();
      prisma.server.findMany.mockResolvedValue([{ idServer: 'a' }, { idServer: 'b' }]);
      prisma.metric.createMany.mockResolvedValue({ count: 2 });

      const written = await service.generateMetrics();

      expect(written).toBe(2);
      expect(prisma.server.findMany).toHaveBeenCalledWith({
        where: { status: ServerStatus.Running },
        select: { idServer: true },
      });
      const { data } = prisma.metric.createMany.mock.calls[0][0];
      expect(data.length).toBe(2);
      expect(data.map((row: { serverId: string }) => row.serverId)).toEqual(['a', 'b']);
      expect(data[0].timestamp).toBe(data[1].timestamp);
      for (const row of data) {
        for (const field of ['cpuUsage', 'memoryUsage', 'diskUsage']) {
          expect(row[field]).toBeGreaterThanOrEqual(0);
          expect(row[field]).toBeLessThanOrEqual(100);
        }
      }
    });

    it('hands every generated batch to the alert evaluator after storing it', async () => {
      const { prisma, service, alertEvaluator } = setup();
      prisma.server.findMany.mockResolvedValue([{ idServer: 'a' }, { idServer: 'b' }]);
      prisma.metric.createMany.mockResolvedValue({ count: 2 });

      await service.generateMetrics();

      const { data } = prisma.metric.createMany.mock.calls[0][0];
      expect(alertEvaluator.evaluate).toHaveBeenCalledTimes(1);
      expect(alertEvaluator.evaluate).toHaveBeenCalledWith(data);
    });

    it('does not evaluate alerts when no metric was stored', async () => {
      const { prisma, service, alertEvaluator } = setup();
      prisma.server.findMany.mockResolvedValueOnce([]);
      expect(await service.generateMetrics()).toBe(0);

      prisma.server.findMany.mockResolvedValueOnce([{ idServer: 'a' }]);
      prisma.metric.createMany.mockRejectedValueOnce(new Error('insert failed'));
      expect(await service.generateMetrics()).toBe(0);

      expect(alertEvaluator.evaluate).not.toHaveBeenCalled();
    });

    it('writes nothing when no server is running', async () => {
      const { prisma, service } = setup();
      prisma.server.findMany.mockResolvedValue([]);

      const written = await service.generateMetrics();

      expect(written).toBe(0);
      expect(prisma.metric.createMany).not.toHaveBeenCalled();
    });

    for (const [label, random] of [
      ['maximum', () => 1],
      ['minimum', () => 0],
    ] as const) {
      it(`keeps every value within 0-100 under ${label} random drift`, async () => {
        const { prisma, service } = setup();
        service.random = random;
        prisma.server.findMany.mockResolvedValue([{ idServer: 'a' }]);
        prisma.metric.createMany.mockResolvedValue({ count: 1 });

        for (let i = 0; i < 300; i++) await service.generateMetrics();

        expect(prisma.metric.createMany).toHaveBeenCalledTimes(300);
        for (const [{ data }] of prisma.metric.createMany.mock.calls) {
          for (const field of ['cpuUsage', 'memoryUsage', 'diskUsage']) {
            expect(data[0][field]).toBeGreaterThanOrEqual(0);
            expect(data[0][field]).toBeLessThanOrEqual(100);
          }
        }
      });
    }

    it('forgets servers that are no longer running', async () => {
      const { prisma, service } = setup();
      prisma.metric.createMany.mockResolvedValue({ count: 1 });

      prisma.server.findMany.mockResolvedValueOnce([{ idServer: 'a' }, { idServer: 'b' }]);
      await service.generateMetrics();
      expect(stateOf(service).size).toBe(2);

      prisma.server.findMany.mockResolvedValueOnce([{ idServer: 'a' }]);
      await service.generateMetrics();
      expect(stateOf(service).size).toBe(1);
    });

    it('skips a tick while the previous one is still running', async () => {
      const { prisma, service } = setup();
      let release!: (servers: { idServer: string }[]) => void;
      prisma.server.findMany.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

      const first = service.generateMetrics();
      const second = await service.generateMetrics();

      expect(second).toBe(0);
      expect(prisma.server.findMany).toHaveBeenCalledTimes(1);

      release([]);
      await first;
    });

    it('logs and swallows database errors, then recovers on the next tick', async () => {
      const { prisma, service, logger } = setup();
      prisma.server.findMany.mockRejectedValueOnce(new Error('db down'));

      expect(await service.generateMetrics()).toBe(0);
      expect(logger.error).toHaveBeenCalledTimes(1);

      prisma.server.findMany.mockResolvedValueOnce([{ idServer: 'a' }]);
      prisma.metric.createMany.mockResolvedValue({ count: 1 });
      expect(await service.generateMetrics()).toBe(1);
    });
  });
});
