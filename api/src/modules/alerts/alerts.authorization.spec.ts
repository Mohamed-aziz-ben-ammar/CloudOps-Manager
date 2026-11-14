import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { AlertsController } from './alerts.controller.js';
import { AlertThresholdsController } from './alert-thresholds.controller.js';

// Runs the project's real RolesGuard against the @Roles metadata of the real
// controllers, so the role rules of KAN-34 are checked without a second mechanism.

const READ = ['Admin', 'Devops', 'Viewer'];
const WRITE = ['Admin', 'Devops'];

type Controller = { prototype: object };

const endpoints: [string, Controller, string, string[]][] = [
  ['GET    /environments/:envId/alerts', AlertsController, 'findAll', READ],
  ['GET    /environments/:envId/alerts/:idAlert', AlertsController, 'findOne', READ],
  ['PATCH  /environments/:envId/alerts/:idAlert/resolve', AlertsController, 'resolve', WRITE],
  ['GET    /environments/:envId/servers/:serverId/alert-thresholds', AlertThresholdsController, 'get', READ],
  ['PUT    /environments/:envId/servers/:serverId/alert-thresholds', AlertThresholdsController, 'update', WRITE],
];

function canActivate(controller: Controller, handler: string, role?: string): boolean {
  const guard = new RolesGuard(new Reflector());
  const context = {
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
  };
  return guard.canActivate(context as never);
}

describe('alert management authorization', () => {
  for (const [label, controller, handler, allowed] of endpoints) {
    describe(label, () => {
      for (const role of ['Admin', 'Devops', 'Viewer']) {
        const expected = allowed.includes(role);
        it(`${expected ? 'allows' : 'forbids'} ${role}`, () => {
          expect(canActivate(controller, handler, role)).toBe(expected);
        });
      }

      it('forbids a request without a user or with an unknown role', () => {
        expect(canActivate(controller, handler, undefined)).toBe(false);
        expect(canActivate(controller, handler, 'Guest')).toBe(false);
      });
    });
  }

  it('tests every route handler of both controllers, so a new one cannot skip its roles', () => {
    for (const controller of [AlertsController, AlertThresholdsController]) {
      const handlers = Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor');
      const tested = endpoints.filter(([, c]) => c === controller).map(([, , handler]) => handler);
      expect(handlers.sort()).toEqual(tested.sort());
    }
  });

  it('puts the existing JWT and Roles guards on both controllers', () => {
    const reflector = new Reflector();
    for (const controller of [AlertsController, AlertThresholdsController]) {
      expect(reflector.get('__guards__', controller as never)).toEqual([JwtAuthGuard, RolesGuard]);
    }
  });
});
