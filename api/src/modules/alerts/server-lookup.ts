import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

// Same ownership rules and messages as ServersService.findOne, shared by the alerts
// services so the Servers module does not have to be modified or export anything.

export async function ensureEnvironment(prisma: PrismaService, envId: string) {
  const env = await prisma.environment.findUnique({ where: { idEnv: envId } });
  if (!env) throw new NotFoundException(`Environment with ID ${envId} not found`);
  return env;
}

export async function ensureServerInEnvironment(prisma: PrismaService, envId: string, idServer: string) {
  await ensureEnvironment(prisma, envId);

  const server = await prisma.server.findUnique({ where: { idServer } });
  if (!server || server.envId !== envId) {
    throw new NotFoundException(`Server with ID ${idServer} not found in environment ${envId}`);
  }
  return server;
}
