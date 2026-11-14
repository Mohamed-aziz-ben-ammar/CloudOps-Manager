import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AlertStatus } from '@prisma/client';
import { AlertsService, MAX_LIMIT } from './alerts.service.js';

const ENV_ID = 'env-1';
const SERVER_ID = 'srv-1';
const orderBy = [{ createdAt: 'desc' }, { idAlert: 'asc' }];

function createPrismaMock() {
  return {
    environment: { findUnique: vi.fn().mockResolvedValue({ idEnv: ENV_ID }) },
    server: { findUnique: vi.fn().mockResolvedValue({ idServer: SERVER_ID, envId: ENV_ID }) },
    // No delete / deleteMany on purpose: alerts are history and must never be deleted.
    alert: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

// An alert as returned by findUnique with `include: { server: { select: { envId } } }`.
const stored = (overrides: Record<string, unknown> = {}, envId = ENV_ID) => ({
  idAlert: 'alert-1',
  type: 'HighCPU',
  severity: 'Warning',
  message: 'CPU usage is 85%, above the 80% warning threshold',
  status: 'Active',
  isConfigurable: true,
  createdAt: new Date('2026-11-13T10:00:00.000Z'),
  resolvedAt: null,
  serverId: SERVER_ID,
  server: { envId },
  ...overrides,
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the promise to reject');
}

describe('AlertsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: AlertsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new AlertsService(prisma as never);
  });

  describe('findAll', () => {
    it('lists the alerts of the environment, newest first, with pagination metadata', async () => {
      const rows = [{ idAlert: 'alert-2' }, { idAlert: 'alert-1' }];
      prisma.alert.findMany.mockResolvedValue(rows);
      prisma.alert.count.mockResolvedValue(25);

      const result = await service.findAll(ENV_ID);

      expect(prisma.alert.findMany).toHaveBeenCalledWith({
        where: { server: { envId: ENV_ID } },
        orderBy,
        skip: 0,
        take: 10,
      });
      expect(prisma.alert.count).toHaveBeenCalledWith({ where: { server: { envId: ENV_ID } } });
      expect(result).toEqual({ data: rows, meta: { total: 25, page: 1, limit: 10, totalPages: 3 } });
    });

    it('includes resolved alerts unless a status filter says otherwise (alert history)', async () => {
      await service.findAll(ENV_ID);

      const [{ where }] = prisma.alert.findMany.mock.calls[0];
      expect('status' in where).toBe(false);
    });

    it('filters by server, after checking that the server exists in the environment', async () => {
      await service.findAll(ENV_ID, { serverId: SERVER_ID });

      expect(prisma.server.findUnique).toHaveBeenCalledWith({ where: { idServer: SERVER_ID } });
      expect(prisma.alert.findMany).toHaveBeenCalledWith({
        where: { server: { envId: ENV_ID }, serverId: SERVER_ID },
        orderBy,
        skip: 0,
        take: 10,
      });
    });

    it('filters by type', async () => {
      await service.findAll(ENV_ID, { type: 'HighDisk' });

      expect(prisma.alert.count).toHaveBeenCalledWith({ where: { server: { envId: ENV_ID }, type: 'HighDisk' } });
    });

    it('filters by severity', async () => {
      await service.findAll(ENV_ID, { severity: 'Critical' });

      expect(prisma.alert.count).toHaveBeenCalledWith({ where: { server: { envId: ENV_ID }, severity: 'Critical' } });
    });

    it('filters by status', async () => {
      await service.findAll(ENV_ID, { status: 'Resolved' });

      expect(prisma.alert.count).toHaveBeenCalledWith({ where: { server: { envId: ENV_ID }, status: 'Resolved' } });
    });

    it('combines every filter with pagination', async () => {
      prisma.alert.count.mockResolvedValue(12);

      const result = await service.findAll(ENV_ID, {
        serverId: SERVER_ID,
        type: 'HighMemory',
        severity: 'Warning',
        status: 'Active',
        page: 3,
        limit: 5,
      });

      expect(prisma.alert.findMany).toHaveBeenCalledWith({
        where: {
          server: { envId: ENV_ID },
          serverId: SERVER_ID,
          type: 'HighMemory',
          severity: 'Warning',
          status: 'Active',
        },
        orderBy,
        skip: 10,
        take: 5,
      });
      expect(result.meta).toEqual({ total: 12, page: 3, limit: 5, totalPages: 3 });
    });

    it('returns an empty page with totalPages 0 when nothing matches', async () => {
      const result = await service.findAll(ENV_ID);

      expect(result).toEqual({ data: [], meta: { total: 0, page: 1, limit: 10, totalPages: 0 } });
    });

    const invalidQueries: [string, Parameters<AlertsService['findAll']>[1], string][] = [
      ['page 0', { page: 0 }, 'page must be an integer greater than or equal to 1'],
      ['a fractional page', { page: 1.5 }, 'page must be an integer greater than or equal to 1'],
      ['limit 0', { limit: 0 }, `limit must be an integer between 1 and ${MAX_LIMIT}`],
      ['limit above the maximum', { limit: MAX_LIMIT + 1 }, `limit must be an integer between 1 and ${MAX_LIMIT}`],
      ['an unknown type', { type: 'HighGPU' }, 'type must be one of: HighCPU, HighMemory, HighDisk'],
      ['an unknown severity', { severity: 'Fatal' }, 'severity must be one of: Critical, Warning, Info'],
      ['an unknown status', { status: 'Closed' }, 'status must be one of: Active, Resolved'],
      ['an empty type', { type: '' }, 'type must be one of: HighCPU, HighMemory, HighDisk'],
    ];
    for (const [label, query, message] of invalidQueries) {
      it(`rejects ${label} with BadRequestException`, async () => {
        const error = await rejection(service.findAll(ENV_ID, query));

        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe(message);
        expect(prisma.alert.findMany).not.toHaveBeenCalled();
      });
    }

    it('throws NotFoundException when the environment does not exist', async () => {
      prisma.environment.findUnique.mockResolvedValue(null);

      const error = await rejection(service.findAll(ENV_ID));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(`Environment with ID ${ENV_ID} not found`);
      expect(prisma.alert.findMany).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the filtered server is missing or in another environment', async () => {
      prisma.server.findUnique.mockResolvedValueOnce(null);
      prisma.server.findUnique.mockResolvedValueOnce({ idServer: SERVER_ID, envId: 'other-env' });

      for (let i = 0; i < 2; i++) {
        const error = await rejection(service.findAll(ENV_ID, { serverId: SERVER_ID }));
        expect(error).toBeInstanceOf(NotFoundException);
        expect(error.message).toBe(`Server with ID ${SERVER_ID} not found in environment ${ENV_ID}`);
      }
      expect(prisma.alert.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('returns the alert, without the helper relation used for the ownership check', async () => {
      prisma.alert.findUnique.mockResolvedValue(stored());

      const result = await service.findOne(ENV_ID, 'alert-1');

      expect(prisma.alert.findUnique).toHaveBeenCalledWith({
        where: { idAlert: 'alert-1' },
        include: { server: { select: { envId: true } } },
      });
      expect(result.idAlert).toBe('alert-1');
      expect('server' in result).toBe(false);
    });

    it('returns resolved alerts too', async () => {
      const resolvedAt = new Date('2026-11-13T11:00:00.000Z');
      prisma.alert.findUnique.mockResolvedValue(stored({ status: 'Resolved', resolvedAt }));

      const result = await service.findOne(ENV_ID, 'alert-1');

      expect([result.status, result.resolvedAt]).toEqual(['Resolved', resolvedAt]);
    });

    it('throws NotFoundException when the alert does not exist', async () => {
      prisma.alert.findUnique.mockResolvedValue(null);

      const error = await rejection(service.findOne(ENV_ID, 'missing'));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(`Alert with ID missing not found in environment ${ENV_ID}`);
    });

    it('throws NotFoundException when the alert belongs to another environment', async () => {
      prisma.alert.findUnique.mockResolvedValue(stored({}, 'other-env'));

      const error = await rejection(service.findOne(ENV_ID, 'alert-1'));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(`Alert with ID alert-1 not found in environment ${ENV_ID}`);
    });

    it('throws NotFoundException when the environment does not exist', async () => {
      prisma.environment.findUnique.mockResolvedValue(null);

      const error = await rejection(service.findOne(ENV_ID, 'alert-1'));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(prisma.alert.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('resolve', () => {
    it('resolves an active alert, setting status and resolvedAt', async () => {
      const resolvedAt = new Date('2026-11-13T11:00:00.000Z');
      prisma.alert.findUnique
        .mockResolvedValueOnce(stored())
        .mockResolvedValueOnce(stored({ status: 'Resolved', resolvedAt }));

      const result = await service.resolve(ENV_ID, 'alert-1');

      const [{ where, data }] = prisma.alert.updateMany.mock.calls[0];
      expect(where).toEqual({ idAlert: 'alert-1', status: AlertStatus.Active });
      expect(data.status).toBe(AlertStatus.Resolved);
      expect(data.resolvedAt instanceof Date).toBe(true);
      expect(result.message).toBe('Alert resolved successfully');
      expect([result.alert.status, result.alert.resolvedAt]).toEqual(['Resolved', resolvedAt]);
    });

    it('never deletes the alert: it stays in the history', async () => {
      prisma.alert.findUnique.mockResolvedValue(stored());

      await service.resolve(ENV_ID, 'alert-1');

      expect('delete' in prisma.alert || 'deleteMany' in prisma.alert).toBe(false);
    });

    it('throws ConflictException when the alert is already resolved, without changing it', async () => {
      prisma.alert.findUnique.mockResolvedValue(stored({ status: 'Resolved', resolvedAt: new Date() }));

      const error = await rejection(service.resolve(ENV_ID, 'alert-1'));

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toBe('Alert with ID alert-1 is already resolved');
      expect(prisma.alert.updateMany).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the alert was resolved meanwhile (lost race)', async () => {
      prisma.alert.findUnique.mockResolvedValue(stored());
      prisma.alert.updateMany.mockResolvedValue({ count: 0 });

      const error = await rejection(service.resolve(ENV_ID, 'alert-1'));

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toBe('Alert with ID alert-1 is already resolved');
    });

    it('throws NotFoundException when the alert does not exist or belongs to another environment', async () => {
      prisma.alert.findUnique.mockResolvedValueOnce(null);
      prisma.alert.findUnique.mockResolvedValueOnce(stored({}, 'other-env'));

      for (let i = 0; i < 2; i++) {
        const error = await rejection(service.resolve(ENV_ID, 'alert-1'));
        expect(error).toBeInstanceOf(NotFoundException);
      }
      expect(prisma.alert.updateMany).not.toHaveBeenCalled();
    });
  });
});
