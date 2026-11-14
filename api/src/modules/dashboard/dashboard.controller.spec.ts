import { DashboardController } from './dashboard.controller.js';

describe('DashboardController', () => {
  function setup() {
    const service = {
      getSummary: vi.fn().mockResolvedValue({ summary: true }),
      getMetrics: vi.fn().mockResolvedValue({ metrics: true }),
      getFilters: vi.fn().mockResolvedValue({ filters: true }),
    };
    return { service, controller: new DashboardController(service as never) };
  }

  it('passes the summary filters to the service unchanged', async () => {
    const { service, controller } = setup();
    const query = { projectId: 'p1', environmentId: 'e1' };

    expect(await controller.getSummary(query)).toEqual({ summary: true });
    expect(service.getSummary).toHaveBeenCalledWith(query);
  });

  it('passes the metrics filters and range to the service unchanged', async () => {
    const { service, controller } = setup();
    const query = { projectId: 'p1', environmentId: 'e1', range: '7d' as const };

    expect(await controller.getMetrics(query)).toEqual({ metrics: true });
    expect(service.getMetrics).toHaveBeenCalledWith(query);
  });

  it('returns the filter options from the service', async () => {
    const { service, controller } = setup();

    expect(await controller.getFilters()).toEqual({ filters: true });
    expect(service.getFilters).toHaveBeenCalledTimes(1);
  });
});
