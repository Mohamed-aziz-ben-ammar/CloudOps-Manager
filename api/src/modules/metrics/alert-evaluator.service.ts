import { Injectable, Logger } from '@nestjs/common';
import { AlertSeverity, AlertStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AlertThresholdsService } from '../alerts/alert-thresholds.service.js';
import { METRIC_DESCRIPTORS, MetricDescriptor, ThresholdLevels } from '../alerts/alert-metrics.js';

export interface MetricReading {
  serverId: string;
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
}

export interface AlertEvaluationResult {
  created: number;
  updated: number;
  resolved: number;
}

interface Target {
  serverId: string;
  descriptor: MetricDescriptor;
  value: number;
  levels: ThresholdLevels;
  /** What the alert should be right now: a severity, or null when there should be none. */
  desired: AlertSeverity | null;
}

interface ActiveAlert {
  idAlert: string;
  serverId: string;
  type: string;
  severity: AlertSeverity;
}

/**
 * Single place where metrics are compared with thresholds and alerts are kept in
 * line with them (KAN-36, extended by KAN-34).
 *
 * Both write paths of the metrics module call it with the readings they just
 * stored: MetricsService.create (manual POST) and MetricsSimulatorService
 * (periodic simulation). For each metric of each server it works out the
 * severity the metric currently deserves and reconciles the Active alert of that
 * type with it:
 *
 *   value <= warning              -> no alert (an Active one is resolved)
 *   warning < value < critical    -> Warning
 *   value >= critical             -> Critical
 *
 *   no Active alert, severity wanted   -> create it (Critical at once if critical is reached)
 *   Active alert, other severity       -> update its severity (escalate or downgrade)
 *   Active alert, no severity wanted   -> resolve it (status Resolved + resolvedAt)
 *   Active alert, same severity        -> nothing
 *
 * Resolved alerts are history: they are never deleted or reopened. If the
 * condition returns, a new alert is created.
 *
 * Thresholds come from AlertThresholdsService (per-server rows over the
 * environment defaults); a metric without thresholds is not evaluated and its
 * alerts are left untouched.
 *
 * Concurrency: the database enforces at most one Active alert per (server, type)
 * with the partial unique index "Alert_one_active_per_server_type" (see the
 * KAN-34 migration). Alerts are inserted with skipDuplicates, so when two
 * evaluations race to create the same alert one insert is silently skipped
 * instead of failing or duplicating. Updates and resolutions are guarded with
 * status = Active, so they can never touch an alert that was resolved meanwhile.
 *
 * An alert message describes the reading that set its current severity; it is
 * not rewritten while the severity stays the same.
 *
 * evaluate() never throws: a failure is logged and must not fail the recording of
 * a metric that has already been stored.
 */
@Injectable()
export class AlertEvaluatorService {
  private readonly logger = new Logger(AlertEvaluatorService.name);

  constructor(
    private prisma: PrismaService,
    private thresholds: AlertThresholdsService,
  ) {}

  async evaluate(readings: MetricReading[]): Promise<AlertEvaluationResult> {
    try {
      // If a batch holds several readings of one server, the last one is the newest.
      const latest = new Map<string, MetricReading>();
      for (const reading of readings) latest.set(reading.serverId, reading);
      if (latest.size === 0) return this.none();

      const thresholdsByServer = await this.thresholds.findForServers([...latest.keys()]);

      const targets: Target[] = [];
      for (const [serverId, reading] of latest) {
        const serverThresholds = thresholdsByServer.get(serverId) ?? {};
        for (const descriptor of METRIC_DESCRIPTORS) {
          const levels = serverThresholds[descriptor.field];
          const value = reading[descriptor.field];
          if (!levels || !Number.isFinite(value)) continue;
          targets.push({ serverId, descriptor, value, levels, desired: this.severityFor(value, levels) });
        }
      }
      if (targets.length === 0) return this.none();

      const activeAlerts: ActiveAlert[] = await this.prisma.alert.findMany({
        where: {
          status: AlertStatus.Active,
          serverId: { in: [...new Set(targets.map((t) => t.serverId))] },
          type: { in: [...new Set(targets.map((t) => t.descriptor.alertType))] },
        },
        select: { idAlert: true, serverId: true, type: true, severity: true },
      });
      const activeByKey = new Map(activeAlerts.map((a) => [this.key(a.serverId, a.type), a] as const));

      const toCreate: { serverId: string; type: string; severity: AlertSeverity; message: string }[] = [];
      const toUpdate: { idAlert: string; severity: AlertSeverity; message: string }[] = [];
      const toResolve: string[] = [];

      for (const target of targets) {
        const existing = activeByKey.get(this.key(target.serverId, target.descriptor.alertType));
        if (target.desired === null) {
          if (existing) toResolve.push(existing.idAlert);
          continue;
        }
        const message = this.message(target.descriptor, target.desired, target.value, target.levels);
        if (!existing) {
          toCreate.push({
            serverId: target.serverId,
            type: target.descriptor.alertType,
            severity: target.desired,
            message,
          });
        } else if (existing.severity !== target.desired) {
          toUpdate.push({ idAlert: existing.idAlert, severity: target.desired, message });
        }
      }

      let resolved = 0;
      if (toResolve.length > 0) {
        const result = await this.prisma.alert.updateMany({
          where: { idAlert: { in: toResolve }, status: AlertStatus.Active },
          data: { status: AlertStatus.Resolved, resolvedAt: new Date() },
        });
        resolved = result.count;
      }

      const updates: { count: number }[] = await Promise.all(
        toUpdate.map((u) =>
          this.prisma.alert.updateMany({
            where: { idAlert: u.idAlert, status: AlertStatus.Active },
            data: { severity: u.severity, message: u.message },
          }),
        ),
      );
      const updated = updates.reduce((total, r) => total + r.count, 0);

      let created = 0;
      if (toCreate.length > 0) {
        const result = await this.prisma.alert.createMany({ data: toCreate, skipDuplicates: true });
        created = result.count;
      }

      return { created, updated, resolved };
    } catch (error) {
      this.logger.error(
        'Failed to evaluate metrics or update alerts',
        error instanceof Error ? error.stack : String(error),
      );
      return this.none();
    }
  }

  private severityFor(value: number, levels: ThresholdLevels): AlertSeverity | null {
    if (levels.critical !== null && value >= levels.critical) return AlertSeverity.Critical;
    if (value > levels.warning) return AlertSeverity.Warning;
    return null;
  }

  private message(d: MetricDescriptor, severity: AlertSeverity, value: number, levels: ThresholdLevels): string {
    return severity === AlertSeverity.Critical
      ? `${d.label} usage is ${value}%, at or above the ${levels.critical}% critical threshold`
      : `${d.label} usage is ${value}%, above the ${levels.warning}% warning threshold`;
  }

  private key(serverId: string, type: string): string {
    return `${serverId}:${type}`;
  }

  private none(): AlertEvaluationResult {
    return { created: 0, updated: 0, resolved: 0 };
  }
}
