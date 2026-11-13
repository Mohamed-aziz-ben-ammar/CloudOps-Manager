import { AlertEvaluatorService } from './alert-evaluator.service.js';
import { MetricsService } from './metrics.service.js';
import { MetricsSimulatorService } from './metrics-simulator.service.js';

// Real AlertEvaluatorService wired into the real MetricsService and
// MetricsSimulatorService; only Prisma and the config source are mocked.

const THRESHOLDS = {
  ALERT_CPU_THRESHOLD: '50',
  ALERT_MEMORY_THRESHOLD: '50',
  ALERT_DISK_THRESHOLD: '50',
};

function wire() {
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
    alert: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn(async ({ data }: { data: { serverId: string; type: string; message: string }[] }) => ({ count: data.length })),
    },
  };
  const config = { get: vi.fn((key: string) => (THRESHOLDS as Record<string, string>)[key]) };

  const evaluator = new AlertEvaluatorService(prisma as never, config as never);
  (evaluator as unknown as { logger: object }).logger = { warn: vi.fn(), error: vi.fn() };
  const evaluate = vi.fn(evaluator.evaluate.bind(evaluator));
  evaluator.evaluate = evaluate;

  const metrics = new MetricsService(prisma as never, evaluator as never);
  const simulator = new MetricsSimulatorService(prisma as never, config as never, evaluator as never);
  return { prisma, evaluate, metrics, simulator };
}

describe('alert evaluation is shared by manual and simulated metrics', () => {
  it('a simulated tick and a manual POST with the same values create identical alerts', async () => {
    // random() === 1 makes the first simulated sample deterministic:
    // cpu 60 + 8 = 68, memory 70 + 4 = 74, disk 60 + 0.3 = 60.3 (all above 50).
    const simulated = wire();
    simulated.simulator.random = () => 1;
    await simulated.simulator.generateMetrics();

    const manual = wire();
    await manual.metrics.create('env-1', 'srv-1', { cpuUsage: 68, memoryUsage: 74, diskUsage: 60.3 });

    const simulatedAlerts = simulated.prisma.alert.createMany.mock.calls[0][0];
    const manualAlerts = manual.prisma.alert.createMany.mock.calls[0][0];
    expect(simulatedAlerts.data.length).toBe(3);
    expect(manualAlerts).toEqual(simulatedAlerts);
    expect(manualAlerts.data[0]).toEqual({
      serverId: 'srv-1',
      type: 'HighCPU',
      message: 'CPU usage is 68%, above the 50% threshold',
    });
  });

  it('neither path creates an alert when every value is within its threshold', async () => {
    // random() === 0.5 gives cpu 40, memory 50 (equal to the threshold), disk 40.15.
    const simulated = wire();
    simulated.simulator.random = () => 0.5;
    await simulated.simulator.generateMetrics();
    const manual = wire();
    await manual.metrics.create('env-1', 'srv-1', { cpuUsage: 40, memoryUsage: 50, diskUsage: 40.15 });

    expect(simulated.prisma.metric.createMany).toHaveBeenCalledTimes(1);
    expect(manual.prisma.metric.create).toHaveBeenCalledTimes(1);
    expect(simulated.prisma.alert.createMany).not.toHaveBeenCalled();
    expect(manual.prisma.alert.createMany).not.toHaveBeenCalled();
  });

  it('both write paths call the very same evaluator instance', async () => {
    const { evaluate, metrics, simulator } = wire();

    await metrics.create('env-1', 'srv-1', { cpuUsage: 1, memoryUsage: 1, diskUsage: 1 });
    await simulator.generateMetrics();

    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('a metric is still recorded when alert creation fails, on both paths', async () => {
    const simulated = wire();
    simulated.simulator.random = () => 1;
    simulated.prisma.alert.createMany.mockRejectedValueOnce(new Error('insert failed'));
    const manual = wire();
    manual.prisma.alert.createMany.mockRejectedValueOnce(new Error('insert failed'));

    const written = await simulated.simulator.generateMetrics();
    const result = await manual.metrics.create('env-1', 'srv-1', { cpuUsage: 99, memoryUsage: 99, diskUsage: 99 });

    expect(written).toBe(1);
    expect(result.message).toBe('Metric recorded successfully');
  });
});
