import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { UpdateAlertThresholdsDto } from './dto/update-alert-thresholds.dto.js';
import {
  METRIC_DESCRIPTORS,
  MetricDescriptor,
  MetricField,
  ServerThresholds,
  ThresholdLevels,
} from './alert-metrics.js';
import { ensureServerInEnvironment } from './server-lookup.js';

export interface ThresholdView {
  warning: number | null;
  critical: number | null;
  source: 'custom' | 'default';
}

export interface ServerThresholdsView {
  serverId: string;
  cpu: ThresholdView;
  memory: ThresholdView;
  disk: ThresholdView;
}

type ParsedPercent = { kind: 'unset' } | { kind: 'invalid' } | { kind: 'ok'; value: number };

function parsePercent(raw: unknown): ParsedPercent {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { kind: 'unset' };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) return { kind: 'invalid' };
  return { kind: 'ok', value };
}

/**
 * Per-server alert thresholds (KAN-34).
 *
 * A server's effective thresholds for a metric are its own row in AlertThreshold
 * when it has one, otherwise the environment defaults:
 *  - ALERT_CPU_THRESHOLD / ALERT_MEMORY_THRESHOLD / ALERT_DISK_THRESHOLD: the
 *    default WARNING threshold (the variables introduced by KAN-36, so servers
 *    without custom thresholds keep behaving as before).
 *  - ALERT_CPU_CRITICAL_THRESHOLD / ALERT_MEMORY_CRITICAL_THRESHOLD /
 *    ALERT_DISK_CRITICAL_THRESHOLD: optional default CRITICAL threshold. Without
 *    one, a metric can only reach Warning by default.
 * A metric with neither a custom row nor a valid default warning threshold is not
 * evaluated. Nothing is assumed or hardcoded.
 *
 * The environment is parsed once, in the constructor, never per evaluation.
 */
@Injectable()
export class AlertThresholdsService implements OnModuleInit {
  private readonly logger = new Logger(AlertThresholdsService.name);
  private readonly defaults: ServerThresholds = {};
  private readonly configWarnings: string[] = [];

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    for (const descriptor of METRIC_DESCRIPTORS) this.readDefault(descriptor);
  }

  onModuleInit() {
    for (const warning of this.configWarnings) this.logger.warn(warning);
  }

  private readDefault(d: MetricDescriptor) {
    const warning = parsePercent(this.config.get(d.warningEnvKey));
    const rawCritical = this.config.get(d.criticalEnvKey);
    const critical = parsePercent(rawCritical);

    if (warning.kind !== 'ok') {
      this.configWarnings.push(
        warning.kind === 'unset'
          ? `${d.warningEnvKey} is not set: ${d.label} usage is not evaluated for servers without custom thresholds`
          : `${d.warningEnvKey}="${String(this.config.get(d.warningEnvKey))}" is not a number between 0 and 100: ${d.label} usage is not evaluated for servers without custom thresholds`,
      );
      if (critical.kind !== 'unset') {
        this.configWarnings.push(`${d.criticalEnvKey} is ignored because ${d.warningEnvKey} is not valid`);
      }
      return;
    }

    if (critical.kind === 'ok' && critical.value > warning.value) {
      this.defaults[d.field] = { warning: warning.value, critical: critical.value };
      return;
    }
    if (critical.kind !== 'unset') {
      this.configWarnings.push(
        `${d.criticalEnvKey}="${String(rawCritical)}" is ignored: it must be a number between 0 and 100 that is strictly greater than ${d.warningEnvKey} (${warning.value})`,
      );
    }
    this.defaults[d.field] = { warning: warning.value, critical: null };
  }

  /** Environment defaults, resolved once at startup. */
  getDefaults(): ServerThresholds {
    return this.defaults;
  }

  private fieldOf(metric: MetricType): MetricField {
    return METRIC_DESCRIPTORS.find((d) => d.metricType === metric)!.field;
  }

  /** Custom thresholds stored for the given servers (one query). */
  private async loadCustom(serverIds: string[]): Promise<Map<string, ServerThresholds>> {
    const rows = await this.prisma.alertThreshold.findMany({ where: { serverId: { in: serverIds } } });
    const custom = new Map<string, ServerThresholds>();
    for (const row of rows as { serverId: string; metric: MetricType; warning: number; critical: number }[]) {
      const forServer = custom.get(row.serverId) ?? {};
      forServer[this.fieldOf(row.metric)] = { warning: row.warning, critical: row.critical };
      custom.set(row.serverId, forServer);
    }
    return custom;
  }

  /**
   * Effective thresholds for each given server: its own rows over the defaults, metric
   * by metric. One database query for the whole batch. Used by AlertEvaluatorService.
   */
  async findForServers(serverIds: string[]): Promise<Map<string, ServerThresholds>> {
    const custom = await this.loadCustom(serverIds);
    const effective = new Map<string, ServerThresholds>();
    for (const serverId of serverIds) {
      effective.set(serverId, { ...this.defaults, ...(custom.get(serverId) ?? {}) });
    }
    return effective;
  }

  private async buildView(serverId: string): Promise<ServerThresholdsView> {
    const custom = (await this.loadCustom([serverId])).get(serverId) ?? {};
    const view = (d: MetricDescriptor): ThresholdView => {
      const own: ThresholdLevels | undefined = custom[d.field];
      if (own) return { warning: own.warning, critical: own.critical, source: 'custom' };
      const fallback = this.defaults[d.field];
      return { warning: fallback?.warning ?? null, critical: fallback?.critical ?? null, source: 'default' };
    };
    const [cpu, memory, disk] = METRIC_DESCRIPTORS.map(view);
    return { serverId, cpu, memory, disk };
  }

  async get(envId: string, serverId: string) {
    await ensureServerInEnvironment(this.prisma, envId, serverId);
    return this.buildView(serverId);
  }

  private assertPercentage(field: string, value: unknown) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new BadRequestException(`${field} must be a number between 0 and 100`);
    }
  }

  async upsert(envId: string, serverId: string, dto: UpdateAlertThresholdsDto) {
    const provided = METRIC_DESCRIPTORS.filter((d) => dto[d.apiKey] !== undefined && dto[d.apiKey] !== null);
    if (provided.length === 0) {
      throw new BadRequestException('At least one of cpu, memory or disk must be provided');
    }
    for (const d of provided) {
      const { warning, critical } = dto[d.apiKey]!;
      this.assertPercentage(`${d.apiKey}.warning`, warning);
      this.assertPercentage(`${d.apiKey}.critical`, critical);
      if (!(critical > warning)) {
        throw new BadRequestException(`${d.apiKey}.critical must be greater than ${d.apiKey}.warning`);
      }
    }

    await ensureServerInEnvironment(this.prisma, envId, serverId);

    // All-or-nothing: either every provided metric is saved or none is.
    await this.prisma.$transaction(
      provided.map((d) => {
        const { warning, critical } = dto[d.apiKey]!;
        return this.prisma.alertThreshold.upsert({
          where: { serverId_metric: { serverId, metric: d.metricType } },
          create: { serverId, metric: d.metricType, warning, critical },
          update: { warning, critical },
        });
      }),
    );

    return { message: 'Alert thresholds saved successfully', thresholds: await this.buildView(serverId) };
  }
}
