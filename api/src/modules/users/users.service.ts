import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async createUser(createUserDto: CreateUserDto) {
    const { email, password, fullName, role } = createUserDto;

    // Check if user already exists
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    // Hash the password securely
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user in PostgreSQL via Prisma and exclude sensitive data from return
    const user = await this.prisma.user.create({
      data: {
        email,
        hashedPassword,
        fullName,
        role: role || Role.Viewer,
      },
      select: {
        idUser: true,
        email: true,
        fullName: true,
        role: true,
      },
    });

    return {
      message: 'User created successfully',
      user,
    };
  }

  // findAll with Pagination
  async findAll(page: number = 1, limit: number = 10) {
    const skip = (page - 1) * limit;

    // Fetch paginated users and total count concurrently
    const [users, totalCount] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: limit,
        select: {
          idUser: true,
          email: true,
          fullName: true,
          role: true,
        },
        orderBy: { email: 'asc' }, // Optional: keeps list ordered
      }),
      this.prisma.user.count(),
    ]);

    return {
      data: users,
      meta: {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit),
      },
    };
  }

  async findOne(idUser: string) {
    const user = await this.prisma.user.findUnique({
      where: { idUser },
      select: {
        idUser: true,
        email: true,
        fullName: true,
        role: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${idUser} not found`);
    }

    return user;
  }

  // Single function to update any attribute
  async update(idUser: string, updateUserDto: UpdateUserDto) {
    // 1. Verify user exists first
    const existingUser = await this.prisma.user.findUnique({ where: { idUser } });
    if (!existingUser) {
      throw new NotFoundException(`User with ID ${idUser} not found`);
    }

    // 2. If email is being changed, check if it's already taken by someone else
    if (updateUserDto.email && updateUserDto.email !== existingUser.email) {
      const emailTaken = await this.prisma.user.findUnique({
        where: { email: updateUserDto.email },
      });
      if (emailTaken) {
        throw new ConflictException('Email is already in use by another account');
      }
    }

    // 3. Prepare data payload (handle password hashing securely if password is provided)
    const dataToUpdate: any = { ...updateUserDto };
    if (updateUserDto.password) {
      dataToUpdate.hashedPassword = await bcrypt.hash(updateUserDto.password, 10);
      delete dataToUpdate.password; // Remove raw password from Prisma update call
    }

    // 4. Perform the update
    const updatedUser = await this.prisma.user.update({
      where: { idUser },
      data: dataToUpdate,
      select: {
        idUser: true,
        email: true,
        fullName: true,
        role: true,
      },
    });

    return {
      message: 'User updated successfully',
      user: updatedUser,
    };
  }

  // Delete a user
  async remove(idUser: string) {
    const existingUser = await this.prisma.user.findUnique({ where: { idUser } });
    if (!existingUser) {
      throw new NotFoundException(`User with ID ${idUser} not found`);
    }

    await this.prisma.user.delete({
      where: { idUser },
    });

    return {
      message: `User with ID ${idUser} deleted successfully`,
    };
  }
}