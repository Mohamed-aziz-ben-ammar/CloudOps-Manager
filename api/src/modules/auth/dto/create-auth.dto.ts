import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAuthDto {
@IsEmail({}, { message: 'Please provide a valid email address' })
email: string;
@IsString()
@MinLength(6, { message: 'Password must be at least 6 characters long' })
password: string;





}
