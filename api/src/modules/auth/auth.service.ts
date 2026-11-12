import { Injectable, UnauthorizedException } from '@nestjs/common';import { CreateAuthDto } from './dto/create-auth.dto.js';
import { UpdateAuthDto } from './dto/update-auth.dto.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
@Injectable()
export class AuthService {
constructor(private prisma: PrismaService,
  private jwtService: JwtService
) {}
async login(loginDto: CreateAuthDto) {
    // Find user by email
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Compare hashed password
    const isPasswordValid = await bcrypt.compare(loginDto.password, user.hashedPassword);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const payload = { sub: user.idUser, email: user.email, role: user.role };
    return {
      message: 'Login successful',
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.idUser,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        },
    };
  }
}
