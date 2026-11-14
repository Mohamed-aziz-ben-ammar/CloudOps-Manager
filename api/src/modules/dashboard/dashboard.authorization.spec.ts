import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { DashboardController } from './dashboard.controller.js';

// Runs the project's real RolesGuard against the @Roles metadata of the real controller:
// no second authorization mechanism.

const ALL_ROLES = ['Admin', 'Devops', 'Viewer'];

const endpoints: [string, string][] = [
  ['GET /dashboard/summary', 'getSummary'],
  ['GET /dashboard/metrics', 'getMetrics'],
  ['GET /dashboard/filters', 'getFilters'],
];

function canActivate(handler: string, role?: string): boolean {
  const guard = new RolesGuard(new Reflector());
  const context = {
    getHandler: () => (DashboardController.prototype as unknown as Record<string, unknown>)[handler],
    getClass: () => DashboardController,
    switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
  };
  return guard.canActivate(context as never);
}

describe('dashboard authorization', () => {
  for (const [label, handler] of endpoints) {
    describe(label, () => {
      for (const role of ALL_ROLES) {
        it(`allows ${role}`, () => {
          expect(canActivate(handler, role)).toBe(true);
        });
      }

      it('forbids a request without a user or with an unknown role', () => {
        expect(canActivate(handler, undefined)).toBe(false);
        expect(canActivate(handler, 'Guest')).toBe(false);
      });
    });
  }

  it('tests every route handler, so a new one cannot skip its roles', () => {
    const handlers = Object.getOwnPropertyNames(DashboardController.prototype).filter((name) => name !== 'constructor');
    expect(handlers.sort()).toEqual(endpoints.map(([, handler]) => handler).sort());
  });

  it('is read-only: every handler is a GET', () => {
    const reflector = new Reflector();
    for (const [, handler] of endpoints) {
      const target = (DashboardController.prototype as unknown as Record<string, unknown>)[handler];
      expect(reflector.get('method', target as never)).toBe(RequestMethod.GET);
    }
  });

  it('puts the existing JWT and Roles guards on the controller', () => {
    expect(new Reflector().get('__guards__', DashboardController as never)).toEqual([JwtAuthGuard, RolesGuard]);
  });
});
