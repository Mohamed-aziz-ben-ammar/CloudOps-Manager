import { AlertThresholdsService } from '../alerts/alert-thresholds.service.js';
import { AlertEvaluatorService } from './alert-evaluator.service.js';
import { MetricsService } from './metrics.service.js';
import { MetricsSimulatorService } from './metrics-simulator.service.js';

// Real AlertThresholdsService + AlertEvaluatorService wired into the real
// MetricsService and MetricsSimulatorService; only Prisma and the config source are mocked.

const WARNING_ONLY = {
  ALERT_CPU_THRESHOLD: '50',
  ALERT_MEMORY_THRESHOLD: '50',
  ALERT_DISK_THRESHOLD: '50',
};

type AlertRow = { idAlert: string; serverId: string; type: string; severity: string };
type NewAlert = { serverId: string; type: string; severity: string; message: string };

function wire(options: { env?: Record<string, string>; custom?: unknown[]; active?: AlertRow[] } = {}) {
  const prisma = {
    environment: { findUnique: vi.fn().mockResolvedValue({ idEnv: 'env-1' }) },
    server: {
      findUnique: vi.fn().mockResolvedValue({ idServer: 'srv-1', envId: 'env-1' }),
      findMany: vi.fn().mockResolvedValue([{ idServer: 'srv-1' }]),
    },
    metric: {
      create: vi.fn().mockResolvedValue({ idMetric: 'm-1' }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    alertThreshold: { findMany: vi.fn().mockResolvedValue(options.custom ?? []) },
    alert: {
      findMany: vi.fn().mockResolvedValue(options.active ?? []),
      createMany: vi.fn(async ({ data }: { data: NewAlert[] }) => ({ count: data.length })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const env: Record<string, string> = options.env ?? WARNING_ONLY;
  const config = { get: vi.fn((key: string) => env[key]) };

  const thresholds = new AlertThresholdsService(prisma as never, config as never);
  const evaluator = new AlertEvaluatorService(prisma as never, thresholds);
  (evaluator as unknown as { logger: object }).logger = { warn: vi.fn(), error: vi.fn() };
  const evaluate = vi.fn(evaluator.evaluate.bind(evaluator));
  evaluator.evaluate = evaluate;

  const metrics = new MetricsService(prisma as never, evaluator);
  const simulator = new MetricsSimulatorService(prisma as never, config as never, evaluator);
  return { prisma, evaluate, metrics, simulator };
}

// Simulated sample for random() === 1 on the first tick: cpu 60 + 8 = 68, memory 70 + 4 = 74, disk 60 + 0.3 = 60.3.
const MAXED = { cpuUsage: 68, memoryUsage: 74, diskUsage: 60.3 };
// For random() === 0.5: cpu 40, memory 50, disk 40.15.
const MIDDLE = { cpuUsage: 40, memoryUsage: 50, diskUsage: 40.15 };

async function simulate(w: ReturnType<typeof wire>, random: () => number) {
  w.simulator.random = random;
  await w.simulator.generateMetrics();
}
const manual = (w: ReturnType<typeof wire>, values: typeof MAXED) => w.metrics.create('env-1', 'srv-1', values);

describe('alert evaluation is shared by manual and simulated metrics', () => {
  it('a simulated tick and a manual POST with the same values create identical alerts', async () => {
    const simulated = wire();
    await simulate(simulated, () => 1);
    const posted = wire();
    await manual(posted, MAXED);

    const simulatedAlerts = simulated.prisma.alert.createMany.mock.calls[0][0];
    const postedAlerts = posted.prisma.alert.createMany.mock.calls[0][0];
    expect(simulatedAlerts.data.length).toBe(3);
    expect(postedAlerts).toEqual(simulatedAlerts);
    expect(postedAlerts.data[0]).toEqual({
      serverId: 'srv-1',
      type: 'HighCPU',
      severity: 'Warning',
      message: 'CPU usage is 68%, above the 50% warning threshold',
    });
  });

  it('neither path creates an alert when every value is within its threshold', async () => {
    const simulated = wire();
    await simulate(simulated, () => 0.5);
    const posted = wire();
    await manual(posted, MIDDLE);

    expect(simulated.prisma.metric.createMany).toHaveBeenCalledTimes(1);
    expect(posted.prisma.metric.create).toHaveBeenCalledTimes(1);
    expect(simulated.prisma.alert.createMany).not.toHaveBeenCalled();
    expect(posted.prisma.alert.createMany).not.toHaveBeenCalled();
  });

  it('both paths create Critical alerts from the default critical thresholds', async () => {
    const env = { ...WARNING_ONLY, ALERT_CPU_CRITICAL_THRESHOLD: '65' };
    const simulated = wire({ env });
    await simulate(simulated, () => 1);
    const posted = wire({ env });
    await manual(posted, MAXED);

    for (const w of [simulated, posted]) {
      const [{ data }] = w.prisma.alert.createMany.mock.calls[0];
      expect(data[0].type).toBe('HighCPU');
      expect(data[0].severity).toBe('Critical');
    }
  });

  it('both paths apply the custom thresholds of the server', async () => {
    // CPU 68% is above the default warning (50) but below this server's custom one (90).
    const custom = [{ serverId: 'srv-1', metric: 'CPU', warning: 90, critical: 99 }];
    const simulated = wire({ custom });
    await simulate(simulated, () => 1);
    const posted = wire({ custom });
    await manual(posted, MAXED);

    for (const w of [simulated, posted]) {
      const [{ data }] = w.prisma.alert.createMany.mock.calls[0];
      expect(data.map((a: { type: string }) => a.type)).toEqual(['HighMemory', 'HighDisk']);
    }
  });

  it('both paths resolve an Active alert once the metric is back within its threshold', async () => {
    const active = [{ idAlert: 'a-1', serverId: 'srv-1', type: 'HighCPU', severity: 'Warning' }];
    const simulated = wire({ active });
    await simulate(simulated, () => 0.5);
    const posted = wire({ active });
    await manual(posted, MIDDLE);

    for (const w of [simulated, posted]) {
      expect(w.prisma.alert.updateMany).toHaveBeenCalledTimes(1);
      const [{ where, data }] = w.prisma.alert.updateMany.mock.calls[0];
      expect(where).toEqual({ idAlert: { in: ['a-1'] }, status: 'Active' });
      expect(data.status).toBe('Resolved');
      expect(data.resolvedAt instanceof Date).toBe(true);
    }
  });

  it('both write paths call the very same evaluator instance', async () => {
    const { evaluate, metrics, simulator } = wire();

    await metrics.create('env-1', 'srv-1', { cpuUsage: 1, memoryUsage: 1, diskUsage: 1 });
    await simulator.generateMetrics();

    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('a metric is still recorded when alert evaluation fails, on both paths', async () => {
    const simulated = wire();
    simulated.prisma.alert.createMany.mockRejectedValueOnce(new Error('insert failed'));
    simulated.simulator.random = () => 1;
    const posted = wire();
    posted.prisma.alert.createMany.mockRejectedValueOnce(new Error('insert failed'));

    const written = await simulated.simulator.generateMetrics();
    const result = await posted.metrics.create('env-1', 'srv-1', { cpuUsage: 99, memoryUsage: 99, diskUsage: 99 });

    expect(written).toBe(1);
    expect(result.message).toBe('Metric recorded successfully');
  });

  it('a metric is still recorded when the thresholds cannot be loaded, on both paths', async () => {
    const simulated = wire();
    simulated.prisma.alertThreshold.findMany.mockRejectedValueOnce(new Error('db down'));
    simulated.simulator.random = () => 1;
    const posted = wire();
    posted.prisma.alertThreshold.findMany.mockRejectedValueOnce(new Error('db down'));

    const written = await simulated.simulator.generateMetrics();
    const result = await posted.metrics.create('env-1', 'srv-1', { cpuUsage: 99, memoryUsage: 99, diskUsage: 99 });

    expect(written).toBe(1);
    expect(result.message).toBe('Metric recorded successfully');
  });
});
