import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServerStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AlertEvaluatorService } from './alert-evaluator.service.js';

export const DEFAULT_SIMULATION_INTERVAL_MS = 60_000;
export const MIN_SIMULATION_INTERVAL_MS = 1_000;

interface Sample {
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
}

/**
 * Simulates the monitoring agents of the project specification by periodically
 * recording CPU, RAM and disk usage for every server whose status is Running.
 *
 * It only writes Metric rows and hands each batch to AlertEvaluatorService, the
 * same evaluator used for manually submitted metrics, so the threshold rule
 * lives in one place (KAN-36).
 *
 * Configuration (read through the global ConfigService, all optional):
 *  - METRICS_SIMULATION_ENABLED      "false" | "0" | "off" | "no" disables it (default: enabled)
 *  - METRICS_SIMULATION_INTERVAL_MS  tick interval, minimum 1000 (default: 60000)
 */
@Injectable()
export class MetricsSimulatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsSimulatorService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  // Last generated sample per server, so values follow a plausible random walk.
  private readonly state = new Map<string, Sample>();

  readonly enabled: boolean;
  readonly intervalMs: number;

  // Overridable randomness source (deterministic in unit tests).
  random: () => number = Math.random;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private alertEvaluator: AlertEvaluatorService,
  ) {
    const rawEnabled = String(this.config.get('METRICS_SIMULATION_ENABLED') ?? 'true')
      .trim()
      .toLowerCase();
    this.enabled = !['false', '0', 'off', 'no'].includes(rawEnabled);

    const rawInterval = Number(this.config.get('METRICS_SIMULATION_INTERVAL_MS'));
    this.intervalMs =
      Number.isFinite(rawInterval) && rawInterval >= MIN_SIMULATION_INTERVAL_MS
        ? rawInterval
        : DEFAULT_SIMULATION_INTERVAL_MS;
  }

  onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Metric simulation disabled (METRICS_SIMULATION_ENABLED)');
      return;
    }
    this.timer = setInterval(() => void this.generateMetrics(), this.intervalMs);
    // Never keep the process alive just for the simulation.
    this.timer.unref();
    this.logger.log(`Metric simulation started (every ${this.intervalMs} ms)`);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Records one sample for each Running server. Returns the number of samples written. */
  async generateMetrics(): Promise<number> {
    // A slow database must not cause overlapping ticks to pile up.
    if (this.running) return 0;
    this.running = true;
    try {
      const servers = await this.prisma.server.findMany({
        where: { status: ServerStatus.Running },
        select: { idServer: true },
      });

      // Forget servers that were stopped or deleted so the map cannot grow forever.
      const activeIds = new Set(servers.map((s: { idServer: string }) => s.idServer));
      for (const id of this.state.keys()) {
        if (!activeIds.has(id)) this.state.delete(id);
      }

      if (servers.length === 0) return 0;

      const timestamp = new Date();
      const data = servers.map(({ idServer }: { idServer: string }) => ({
        serverId: idServer,
        timestamp,
        ...this.nextSample(idServer),
      }));
      const { count } = await this.prisma.metric.createMany({ data });
      await this.alertEvaluator.evaluate(data);
      return count;
    } catch (error) {
      this.logger.error(
        'Failed to generate simulated metrics',
        error instanceof Error ? error.stack : String(error),
      );
      return 0;
    } finally {
      this.running = false;
    }
  }

  private nextSample(serverId: string): Sample {
    const prev = this.state.get(serverId) ?? this.initialSample();
    const next: Sample = {
      cpuUsage: this.clampRound(prev.cpuUsage + this.drift(8)),
      memoryUsage: this.clampRound(prev.memoryUsage + this.drift(4)),
      diskUsage: this.nextDisk(prev.diskUsage),
    };
    this.state.set(serverId, next);
    return next;
  }

  private initialSample(): Sample {
    return {
      cpuUsage: this.between(20, 60),
      memoryUsage: this.between(30, 70),
      diskUsage: this.between(20, 60),
    };
  }

  // Disk only grows slowly; when nearly full it drops, as if logs were cleaned up.
  private nextDisk(previous: number): number {
    const grown = previous + this.random() * 0.3;
    return this.clampRound(grown > 95 ? this.between(40, 60) : grown);
  }

  private between(min: number, max: number): number {
    return min + this.random() * (max - min);
  }

  private drift(maxStep: number): number {
    return (this.random() * 2 - 1) * maxStep;
  }

  private clampRound(value: number): number {
    return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
  }
}
