import { AlertSeverity, AlertStatus } from '@prisma/client';
import { AlertEvaluatorService } from './alert-evaluator.service.js';
import { ServerThresholds } from '../alerts/alert-metrics.js';

// cpu 80/95, memory 70/90, disk 60/85 (warning/critical): different on purpose, so a
// metric compared with the wrong thresholds is noticed.
const DEFAULT_THRESHOLDS: ServerThresholds = {
  cpuUsage: { warning: 80, critical: 95 },
  memoryUsage: { warning: 70, critical: 90 },
  diskUsage: { warning: 60, critical: 85 },
};

type Row = {
  idAlert: string;
  serverId: string;
  type: string;
  severity: string;
  message: string;
  status: string;
  resolvedAt: Date | null;
};
type NewAlert = { serverId: string; type: string; severity: string; message: string };
type IdFilter = string | { in: string[] };
type Where = { idAlert?: IdFilter; status?: string; serverId?: { in: string[] }; type?: { in: string[] } };

/**
 * In-memory stand-in for the Alert table. It enforces the same rule as the partial
 * unique index "Alert_one_active_per_server_type": a second Active alert of one type
 * for a server is a unique violation, or is skipped when skipDuplicates is set.
 */
function createFakeAlertTable(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  let sequence = 0;
  const idMatches = (filter: IdFilter | undefined, id: string) =>
    filter === undefined || (typeof filter === 'string' ? filter === id : filter.in.includes(id));
  const matches = (row: Row, where: Where) =>
    idMatches(where.idAlert, row.idAlert) &&
    (where.status === undefined || row.status === where.status) &&
    (where.serverId === undefined || where.serverId.in.includes(row.serverId)) &&
    (where.type === undefined || where.type.in.includes(row.type));

  return {
    rows,
    findMany: vi.fn(async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where))),
    createMany: vi.fn(async ({ data, skipDuplicates }: { data: NewAlert[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const alert of data) {
        const duplicate = rows.some(
          (r) => r.status === 'Active' && r.serverId === alert.serverId && r.type === alert.type,
        );
        if (duplicate) {
          if (!skipDuplicates) throw new Error('Unique constraint failed on Alert_one_active_per_server_type');
          continue;
        }
        rows.push({ ...alert, idAlert: `alert-${++sequence}`, status: 'Active', resolvedAt: null });
        count++;
      }
      return { count };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
  };
}

function setup(options: { active?: Row[]; thresholds?: ServerThresholds } = {}) {
  const alert = createFakeAlertTable(options.active);
  const prisma = { alert };
  const thresholds = {
    findForServers: vi.fn(
      async (ids: string[]) => new Map(ids.map((id) => [id, options.thresholds ?? DEFAULT_THRESHOLDS])),
    ),
  };
  const service = new AlertEvaluatorService(prisma as never, thresholds as never);
  // Keep test output clean and let tests assert on logging.
  const logger = { warn: vi.fn(), error: vi.fn() };
  (service as unknown as { logger: typeof logger }).logger = logger;
  return { alert, prisma, thresholds, service, logger };
}

const within = { cpuUsage: 10, memoryUsage: 10, diskUsage: 10 };
const reading = (overrides: Partial<typeof within> = {}, serverId = 'srv-1') => ({
  serverId,
  ...within,
  ...overrides,
});
const active = (type: string, severity: string, serverId = 'srv-1', idAlert = `a-${type}-${serverId}`): Row => ({
  idAlert,
  serverId,
  type,
  severity,
  message: 'existing',
  status: 'Active',
  resolvedAt: null,
});

describe('AlertEvaluatorService', () => {
  describe('no alert at or below the warning threshold', () => {
    const cases: [string, Partial<typeof within>][] = [
      ['well below every warning threshold', { cpuUsage: 10, memoryUsage: 10, diskUsage: 10 }],
      ['exactly at every warning threshold', { cpuUsage: 80, memoryUsage: 70, diskUsage: 60 }],
      ['just below every warning threshold', { cpuUsage: 79.99, memoryUsage: 69.99, diskUsage: 59.99 }],
      ['zero usage', { cpuUsage: 0, memoryUsage: 0, diskUsage: 0 }],
    ];

    for (const [label, values] of cases) {
      it(`creates nothing for usage ${label}`, async () => {
        const { alert, service } = setup();

        const result = await service.evaluate([reading(values)]);

        expect(result).toEqual({ created: 0, updated: 0, resolved: 0 });
        expect(alert.createMany).not.toHaveBeenCalled();
        expect(alert.updateMany).not.toHaveBeenCalled();
      });
    }

    it('handles an empty batch without touching the database', async () => {
      const { alert, thresholds, service } = setup();

      expect(await service.evaluate([])).toEqual({ created: 0, updated: 0, resolved: 0 });
      expect(thresholds.findForServers).not.toHaveBeenCalled();
      expect(alert.findMany).not.toHaveBeenCalled();
    });

    it('ignores readings that are not finite numbers', async () => {
      const { alert, service } = setup();

      const result = await service.evaluate([
        reading({ cpuUsage: Number.NaN, memoryUsage: Number.POSITIVE_INFINITY, diskUsage: undefined as never }),
      ]);

      expect(result).toEqual({ created: 0, updated: 0, resolved: 0 });
      expect(alert.createMany).not.toHaveBeenCalled();
    });
  });

  describe('Warning alert creation', () => {
    it('creates a Warning for CPU above its warning threshold', async () => {
      const { alert, service } = setup();

      const result = await service.evaluate([reading({ cpuUsage: 85 })]);

      expect(result).toEqual({ created: 1, updated: 0, resolved: 0 });
      expect(alert.createMany).toHaveBeenCalledWith({
        data: [
          {
            serverId: 'srv-1',
            type: 'HighCPU',
            severity: AlertSeverity.Warning,
            message: 'CPU usage is 85%, above the 80% warning threshold',
          },
        ],
        skipDuplicates: true,
      });
    });

    it('creates a Warning for memory above its warning threshold', async () => {
      const { alert, service } = setup();

      await service.evaluate([reading({ memoryUsage: 75.5 })]);

      expect(alert.rows.map((r) => [r.type, r.severity, r.message])).toEqual([
        ['HighMemory', 'Warning', 'Memory usage is 75.5%, above the 70% warning threshold'],
      ]);
    });

    it('creates a Warning for disk above its warning threshold', async () => {
      const { alert, service } = setup();

      await service.evaluate([reading({ diskUsage: 61 })]);

      expect(alert.rows.map((r) => [r.type, r.severity, r.message])).toEqual([
        ['HighDisk', 'Warning', 'Disk usage is 61%, above the 60% warning threshold'],
      ]);
    });

    it('stays at Warning just below the critical threshold', async () => {
      const { alert, service } = setup();

      await service.evaluate([reading({ cpuUsage: 94.99 })]);

      expect(alert.rows[0].severity).toBe('Warning');
    });

    it('creates a Warning when the threshold has no critical level', async () => {
      const { alert, service } = setup({ thresholds: { cpuUsage: { warning: 80, critical: null } } });

      await service.evaluate([reading({ cpuUsage: 100 })]);

      expect(alert.rows.map((r) => r.severity)).toEqual(['Warning']);
    });

    it('creates the alert as Active with no resolution time', async () => {
      const { alert, service } = setup();

      await service.evaluate([reading({ cpuUsage: 85 })]);

      expect(alert.rows[0].status).toBe('Active');
      expect(alert.rows[0].resolvedAt).toBe(null);
    });
  });

  describe('Critical alert creation', () => {
    it('creates a Critical immediately when CPU reaches the critical threshold exactly', async () => {
      const { alert, service } = setup();

      const result = await service.evaluate([reading({ cpuUsage: 95 })]);

      expect(result).toEqual({ created: 1, updated: 0, resolved: 0 });
      expect(alert.createMany).toHaveBeenCalledWith({
        data: [
          {
            serverId: 'srv-1',
            type: 'HighCPU',
            severity: AlertSeverity.Critical,
            message: 'CPU usage is 95%, at or above the 95% critical threshold',
          },
        ],
        skipDuplicates: true,
      });
    });

    it('creates a Critical for memory above its critical threshold', async () => {
      const { alert, service } = setup();

      await service.evaluate([reading({ memoryUsage: 97 })]);

      expect(alert.rows.map((r) => [r.type, r.severity])).toEqual([['HighMemory', 'Critical']]);
    });

    it('creates a Critical for disk reaching its critical threshold', async () => {
      const { alert, service } = setup();

      await service.evaluate([reading({ diskUsage: 85 })]);

      expect(alert.rows.map((r) => [r.type, r.severity])).toEqual([['HighDisk', 'Critical']]);
    });
  });

  describe('changing severity of an Active alert', () => {
    it('upgrades Warning to Critical', async () => {
      const { alert, service } = setup({ active: [active('HighCPU', 'Warning')] });

      const result = await service.evaluate([reading({ cpuUsage: 96 })]);

      expect(result).toEqual({ created: 0, updated: 1, resolved: 0 });
      expect(alert.updateMany).toHaveBeenCalledWith({
        where: { idAlert: 'a-HighCPU-srv-1', status: AlertStatus.Active },
        data: { severity: AlertSeverity.Critical, message: 'CPU usage is 96%, at or above the 95% critical threshold' },
      });
      expect(alert.createMany).not.toHaveBeenCalled();
      expect(alert.rows.length).toBe(1);
    });

    it('downgrades Critical to Warning while still above the warning threshold', async () => {
      const { alert, service } = setup({ active: [active('HighCPU', 'Critical')] });

      const result = await service.evaluate([reading({ cpuUsage: 90 })]);

      expect(result).toEqual({ created: 0, updated: 1, resolved: 0 });
      expect(alert.updateMany).toHaveBeenCalledWith({
        where: { idAlert: 'a-HighCPU-srv-1', status: AlertStatus.Active },
        data: { severity: AlertSeverity.Warning, message: 'CPU usage is 90%, above the 80% warning threshold' },
      });
      expect(alert.rows[0].status).toBe('Active');
    });

    it('leaves an Active alert alone while its severity is unchanged', async () => {
      const { alert, service } = setup({ active: [active('HighCPU', 'Warning')] });

      const result = await service.evaluate([reading({ cpuUsage: 88 })]);

      expect(result).toEqual({ created: 0, updated: 0, resolved: 0 });
      expect(alert.updateMany).not.toHaveBeenCalled();
      expect(alert.createMany).not.toHaveBeenCalled();
    });
  });

  describe('automatic resolution', () => {
    it('resolves an Active Warning once the metric is back at the warning threshold', async () => {
      const { alert, service } = setup({ active: [active('HighCPU', 'Warning')] });

      const result = await service.evaluate([reading({ cpuUsage: 80 })]);

      expect(result).toEqual({ created: 0, updated: 0, resolved: 1 });
      const [{ where, data }] = alert.updateMany.mock.calls[0];
      expect(where).toEqual({ idAlert: { in: ['a-HighCPU-srv-1'] }, status: AlertStatus.Active });
      expect(data.status).toBe(AlertStatus.Resolved);
      expect(data.resolvedAt instanceof Date).toBe(true);
    });

    it('resolves an Active Critical that falls straight below the warning threshold', async () => {
      const { alert, service } = setup({ active: [active('HighDisk', 'Critical')] });

      const result = await service.evaluate([reading({ diskUsage: 20 })]);

      expect(result.resolved).toBe(1);
      expect(alert.rows[0].status).toBe('Resolved');
      expect(alert.rows[0].resolvedAt instanceof Date).toBe(true);
    });

    it('keeps resolved alerts in the database: nothing is ever deleted', async () => {
      const { alert, prisma, service } = setup({ active: [active('HighCPU', 'Warning')] });

      await service.evaluate([reading({ cpuUsage: 10 })]);

      expect(alert.rows.length).toBe(1);
      expect(alert.rows[0].status).toBe('Resolved');
      expect('delete' in prisma.alert || 'deleteMany' in prisma.alert).toBe(false);
    });

    it('only looks at Active alerts, so history is never reopened', async () => {
      const { alert, service } = setup();

      await service.evaluate([reading({ cpuUsage: 85 })]);

      const [{ where }] = alert.findMany.mock.calls[0];
      expect(where.status).toBe(AlertStatus.Active);
    });
  });

  describe('duplicate prevention', () => {
    it('does not create a second alert while one is Active for the same server and type', async () => {
      const { alert, service } = setup({ active: [active('HighCPU', 'Warning')] });

      await service.evaluate([reading({ cpuUsage: 90 })]);
      await service.evaluate([reading({ cpuUsage: 91 })]);

      expect(alert.createMany).not.toHaveBeenCalled();
      expect(alert.rows.filter((r) => r.status === 'Active').length).toBe(1);
    });

    it('does not mix servers: another server still gets its own alert', async () => {
      const { alert, service } = setup({ active: [active('HighCPU', 'Warning', 'srv-1')] });

      await service.evaluate([reading({ cpuUsage: 90 }, 'srv-1'), reading({ cpuUsage: 90 }, 'srv-2')]);

      expect(alert.rows.filter((r) => r.status === 'Active').map((r) => r.serverId).sort()).toEqual([
        'srv-1',
        'srv-2',
      ]);
    });

    it('inserts with skipDuplicates, so simultaneous evaluations create exactly one alert and no error', async () => {
      const { alert, service, logger } = setup();

      // Both evaluations read "no Active alert" before either one inserts.
      const results = await Promise.all([
        service.evaluate([reading({ cpuUsage: 90 })]),
        service.evaluate([reading({ cpuUsage: 91 })]),
      ]);

      expect(results.reduce((total, r) => total + r.created, 0)).toBe(1);
      expect(alert.rows.filter((r) => r.status === 'Active').length).toBe(1);
      expect(alert.createMany).toHaveBeenCalledTimes(2);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('uses the newest reading when a batch holds several for one server', async () => {
      const { alert, service } = setup();

      await service.evaluate([reading({ cpuUsage: 99 }), reading({ cpuUsage: 10 })]);

      expect(alert.createMany).not.toHaveBeenCalled();
    });
  });

  describe('alert lifecycle', () => {
    it('Warning -> Critical -> Warning -> resolved -> a new alert, keeping the history', async () => {
      const { alert, service } = setup();

      expect((await service.evaluate([reading({ cpuUsage: 85 })])).created).toBe(1);
      const first = alert.rows[0];
      expect([first.severity, first.status]).toEqual(['Warning', 'Active']);

      expect((await service.evaluate([reading({ cpuUsage: 97 })])).updated).toBe(1);
      expect(first.severity).toBe('Critical');

      expect((await service.evaluate([reading({ cpuUsage: 90 })])).updated).toBe(1);
      expect(first.severity).toBe('Warning');

      expect((await service.evaluate([reading({ cpuUsage: 70 })])).resolved).toBe(1);
      expect(first.status).toBe('Resolved');
      const resolvedAt = first.resolvedAt;
      expect(resolvedAt instanceof Date).toBe(true);

      // The condition occurs again: a NEW record, the resolved one is left as it was.
      expect((await service.evaluate([reading({ cpuUsage: 90 })])).created).toBe(1);
      expect(alert.rows.length).toBe(2);
      expect(alert.rows[0]).toBe(first);
      expect(first.status).toBe('Resolved');
      expect(first.resolvedAt).toBe(resolvedAt);
      const second = alert.rows[1];
      expect(second.idAlert === first.idAlert).toBe(false);
      expect([second.severity, second.status, second.resolvedAt]).toEqual(['Warning', 'Active', null]);
    });
  });

  describe('CPU, memory and disk are independent', () => {
    it('creates, keeps and resolves alerts per metric in a single evaluation', async () => {
      const { alert, service } = setup({
        active: [active('HighMemory', 'Warning'), active('HighDisk', 'Warning')],
      });

      // cpu: new Critical; memory: back below warning -> resolve; disk: still Warning -> untouched
      const result = await service.evaluate([reading({ cpuUsage: 99, memoryUsage: 10, diskUsage: 70 })]);

      expect(result).toEqual({ created: 1, updated: 0, resolved: 1 });
      const byType = Object.fromEntries(alert.rows.map((r) => [r.type, [r.severity, r.status]]));
      expect(byType).toEqual({
        HighCPU: ['Critical', 'Active'],
        HighMemory: ['Warning', 'Resolved'],
        HighDisk: ['Warning', 'Active'],
      });
    });

    it('creates one alert per breached metric in a single insert', async () => {
      const { alert, service } = setup();

      await service.evaluate([reading({ cpuUsage: 96, memoryUsage: 75, diskUsage: 65 })]);

      expect(alert.createMany).toHaveBeenCalledTimes(1);
      expect(alert.rows.map((r) => [r.type, r.severity])).toEqual([
        ['HighCPU', 'Critical'],
        ['HighMemory', 'Warning'],
        ['HighDisk', 'Warning'],
      ]);
    });

    it('does not evaluate or touch a metric that has no thresholds', async () => {
      const { alert, service } = setup({
        thresholds: { cpuUsage: { warning: 80, critical: 95 } },
        active: [active('HighDisk', 'Warning')],
      });

      const result = await service.evaluate([reading({ cpuUsage: 10, diskUsage: 10 })]);

      expect(result).toEqual({ created: 0, updated: 0, resolved: 0 });
      expect(alert.rows[0].status).toBe('Active');
    });

    it('queries nothing when the server has no thresholds at all', async () => {
      const { alert, service } = setup({ thresholds: {} });

      const result = await service.evaluate([reading({ cpuUsage: 100, memoryUsage: 100, diskUsage: 100 })]);

      expect(result).toEqual({ created: 0, updated: 0, resolved: 0 });
      expect(alert.findMany).not.toHaveBeenCalled();
      expect(alert.createMany).not.toHaveBeenCalled();
    });
  });

  describe('per-server thresholds', () => {
    it('loads the thresholds of every server of the batch with one call and applies each its own', async () => {
      const { alert, thresholds, service } = setup();
      thresholds.findForServers.mockResolvedValueOnce(
        new Map<string, ServerThresholds>([
          ['srv-1', DEFAULT_THRESHOLDS],
          ['srv-2', { cpuUsage: { warning: 20, critical: 30 } }],
        ]),
      );

      // 25% CPU: fine for srv-1 (warning 80), a Warning for srv-2 (warning 20)
      await service.evaluate([reading({ cpuUsage: 25 }, 'srv-1'), reading({ cpuUsage: 25 }, 'srv-2')]);

      expect(thresholds.findForServers).toHaveBeenCalledTimes(1);
      expect(thresholds.findForServers).toHaveBeenCalledWith(['srv-1', 'srv-2']);
      expect(alert.rows.map((r) => [r.serverId, r.type, r.severity])).toEqual([['srv-2', 'HighCPU', 'Warning']]);
    });
  });

  describe('error handling', () => {
    it('never throws and logs when the thresholds cannot be loaded', async () => {
      const { alert, thresholds, service, logger } = setup();
      thresholds.findForServers.mockRejectedValueOnce(new Error('db down'));

      const result = await service.evaluate([reading({ cpuUsage: 99 })]);

      expect(result).toEqual({ created: 0, updated: 0, resolved: 0 });
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(alert.createMany).not.toHaveBeenCalled();
    });

    it('never throws and logs when the Active alerts cannot be read', async () => {
      const { alert, service, logger } = setup();
      alert.findMany.mockRejectedValueOnce(new Error('db down'));

      const result = await service.evaluate([reading({ cpuUsage: 99 })]);

      expect(result).toEqual({ created: 0, updated: 0, resolved: 0 });
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(alert.createMany).not.toHaveBeenCalled();
    });

    it('never throws and logs when creating alerts fails', async () => {
      const { alert, service, logger } = setup();
      alert.createMany.mockRejectedValueOnce(new Error('insert failed'));

      const result = await service.evaluate([reading({ cpuUsage: 99 })]);

      expect(result).toEqual({ created: 0, updated: 0, resolved: 0 });
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('never throws and logs when updating or resolving alerts fails', async () => {
      const { alert, service, logger } = setup({ active: [active('HighCPU', 'Warning')] });
      alert.updateMany.mockRejectedValueOnce(new Error('update failed'));

      const result = await service.evaluate([reading({ cpuUsage: 99 })]);

      expect(result).toEqual({ created: 0, updated: 0, resolved: 0 });
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('keeps working on the next call after a failure', async () => {
      const { alert, service } = setup();
      alert.createMany.mockRejectedValueOnce(new Error('insert failed'));

      await service.evaluate([reading({ cpuUsage: 99 })]);
      const result = await service.evaluate([reading({ cpuUsage: 99 })]);

      expect(result.created).toBe(1);
    });
  });
});
