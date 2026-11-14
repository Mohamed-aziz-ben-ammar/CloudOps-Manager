import { MetricType } from '@prisma/client';

export type MetricField = 'cpuUsage' | 'memoryUsage' | 'diskUsage';

export interface MetricDescriptor {
  /** Field of Metric / MetricReading that is compared with the thresholds. */
  field: MetricField;
  /** Value stored in Alert.type. */
  alertType: string;
  label: string;
  /** Key used for this metric in the thresholds API (request body and response). */
  apiKey: 'cpu' | 'memory' | 'disk';
  /** Value stored in AlertThreshold.metric. */
  metricType: MetricType;
  /** Environment variable holding the default warning threshold (percent). */
  warningEnvKey: string;
  /** Environment variable holding the optional default critical threshold (percent). */
  criticalEnvKey: string;
}

export const METRIC_DESCRIPTORS: readonly MetricDescriptor[] = [
  {
    field: 'cpuUsage',
    alertType: 'HighCPU',
    label: 'CPU',
    apiKey: 'cpu',
    metricType: MetricType.CPU,
    warningEnvKey: 'ALERT_CPU_THRESHOLD',
    criticalEnvKey: 'ALERT_CPU_CRITICAL_THRESHOLD',
  },
  {
    field: 'memoryUsage',
    alertType: 'HighMemory',
    label: 'Memory',
    apiKey: 'memory',
    metricType: MetricType.Memory,
    warningEnvKey: 'ALERT_MEMORY_THRESHOLD',
    criticalEnvKey: 'ALERT_MEMORY_CRITICAL_THRESHOLD',
  },
  {
    field: 'diskUsage',
    alertType: 'HighDisk',
    label: 'Disk',
    apiKey: 'disk',
    metricType: MetricType.Disk,
    warningEnvKey: 'ALERT_DISK_THRESHOLD',
    criticalEnvKey: 'ALERT_DISK_CRITICAL_THRESHOLD',
  },
];

export const ALERT_TYPES: string[] = METRIC_DESCRIPTORS.map((d) => d.alertType);

/** Effective thresholds of one metric. `critical` is null when only a warning level exists. */
export interface ThresholdLevels {
  warning: number;
  critical: number | null;
}

/** Effective thresholds of a server; a metric that is missing is not evaluated. */
export type ServerThresholds = Partial<Record<MetricField, ThresholdLevels>>;
