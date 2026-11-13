import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface MetricReading {
  serverId: string;
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
}

type MetricField = 'cpuUsage' | 'memoryUsage' | 'diskUsage';

interface MetricCheck {
  field: MetricField;
  /** Value stored in Alert.type. */
  type: string;
  label: string;
  /** Environment variable holding the threshold, as a percentage from 0 to 100. */
  envKey: string;
}

export const METRIC_CHECKS: readonly MetricCheck[] = [
  { field: 'cpuUsage', type: 'HighCPU', label: 'CPU', envKey: 'ALERT_CPU_THRESHOLD' },
  { field: 'memoryUsage', type: 'HighMemory', label: 'Memory', envKey: 'ALERT_MEMORY_THRESHOLD' },
  { field: 'diskUsage', type: 'HighDisk', label: 'Disk', envKey: 'ALERT_DISK_THRESHOLD' },
];

interface AlertCandidate {
  serverId: string;
  type: string;
  message: string;
}

/**
 * Single place where a metric is compared with its threshold (KAN-36).
 *
 * Both write paths of the metrics module call it with the readings they just
 * stored: MetricsService.create (manual POST) and MetricsSimulatorService
 * (periodic simulation). An Alert is created only when a value is strictly
 * greater than its threshold.
 *
 * Thresholds: the ticket does not define any, so none are assumed. Each one is
 * read from an optional environment variable (through the global ConfigService):
 *  - ALERT_CPU_THRESHOLD
 *  - ALERT_MEMORY_THRESHOLD
 *  - ALERT_DISK_THRESHOLD
 * A metric whose variable is unset, empty or not a number from 0 to 100 is not
 * evaluated, so nothing is created until thresholds are provided. Full,
 * per-server threshold management is KAN-34 and is not part of this class.
 *
 * Decisions that go beyond the ticket text:
 *  - Severity and status are left to the Alert model defaults (Warning / Active).
 *  - No new alert is created while an Active alert of the same type already
 *    exists for the server. Without this the simulator would add one alert per
 *    server per tick for as long as a value stays above its threshold.
 *    Resolving alerts is out of scope here, so an alert stays Active until
 *    something else resolves it.
 *
 * evaluate() never throws: a failure to create an alert is logged and must not
 * fail the recording of a metric that has already been stored.
 */
@Injectable()
export class AlertEvaluatorService implements OnModuleInit {
  private readonly logger = new Logger(AlertEvaluatorService.name);
  private readonly thresholds: Partial<Record<MetricField, number>> = {};
  private readonly configWarnings: string[] = [];

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    for (const check of METRIC_CHECKS) {
      const raw = this.config.get(check.envKey);
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        this.configWarnings.push(`${check.envKey} is not set: ${check.label} usage will not be evaluated for alerts`);
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        this.configWarnings.push(
          `${check.envKey}="${String(raw)}" is not a number between 0 and 100: ${check.label} usage will not be evaluated for alerts`,
        );
        continue;
      }
      this.thresholds[check.field] = value;
    }
  }

  onModuleInit() {
    for (const warning of this.configWarnings) this.logger.warn(warning);
  }

  /** Creates the alerts for the readings that exceed a threshold. Returns how many were created. */
  async evaluate(readings: MetricReading[]): Promise<number> {
    try {
      const candidates = this.findBreaches(readings);
      if (candidates.length === 0) return 0;

      const activeAlerts = await this.prisma.alert.findMany({
        where: {
          status: AlertStatus.Active,
          serverId: { in: [...new Set(candidates.map((c) => c.serverId))] },
          type: { in: [...new Set(candidates.map((c) => c.type))] },
        },
        select: { serverId: true, type: true },
      });
      const alreadyActive = new Set(
        activeAlerts.map((a: { serverId: string; type: string }) => this.key(a.serverId, a.type)),
      );

      const toCreate: AlertCandidate[] = [];
      for (const candidate of candidates) {
        const key = this.key(candidate.serverId, candidate.type);
        if (alreadyActive.has(key)) continue;
        alreadyActive.add(key); // also collapses duplicates inside one batch
        toCreate.push(candidate);
      }
      if (toCreate.length === 0) return 0;

      const { count } = await this.prisma.alert.createMany({ data: toCreate });
      return count;
    } catch (error) {
      this.logger.error(
        'Failed to evaluate metrics or create alerts',
        error instanceof Error ? error.stack : String(error),
      );
      return 0;
    }
  }

  private findBreaches(readings: MetricReading[]): AlertCandidate[] {
    const breaches: AlertCandidate[] = [];
    for (const reading of readings) {
      for (const check of METRIC_CHECKS) {
        const threshold = this.thresholds[check.field];
        if (threshold === undefined) continue;
        const value = reading[check.field];
        if (!Number.isFinite(value) || value <= threshold) continue;
        breaches.push({
          serverId: reading.serverId,
          type: check.type,
          message: `${check.label} usage is ${value}%, above the ${threshold}% threshold`,
        });
      }
    }
    return breaches;
  }

  private key(serverId: string, type: string): string {
    return `${serverId}:${type}`;
  }
}
