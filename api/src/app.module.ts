import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ServersModule } from './modules/servers/servers.module.js';

@Module({
  imports: [
    // Load .env variables globally across the application
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    UsersModule,
    AuthModule,
    ServersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}