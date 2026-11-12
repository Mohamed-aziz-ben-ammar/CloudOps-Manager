import { IsEmail, IsNotEmpty, IsString, MinLength, IsEnum, IsOptional } from 'class-validator';
import { Role } from '@prisma/client';
export class CreateUserDto {
@IsEmail({}, { message: 'Please provide a valid email address' })
@IsNotEmpty()
email: string;

@IsString()
@IsNotEmpty()
@MinLength(6, { message: 'Password must be at least 6 characters long' })
password: string;

@IsString()
@IsNotEmpty()
fullName: string;

@IsEnum(Role)
@IsOptional()
role?: Role;
}
