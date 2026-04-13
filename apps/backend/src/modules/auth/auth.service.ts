import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../../entities/user.entity.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';

const ACCESS_TOKEN_EXPIRY = 60 * 60; // 1 hour
const REFRESH_TOKEN_EXPIRY = 90 * 24 * 60 * 60; // 90 days
const BCRYPT_ROUNDS = 12;
// Dummy hash for constant-time login rejection when user not found
const DUMMY_HASH =
  '$2b$12$000000000000000000000uGhtZ2nTis4GxVpCR7tOZXaKQfGKqaJi';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const password_hash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = this.userRepo.create({
      email: dto.email,
      password_hash,
      display_name: dto.display_name,
    });

    let saved: User;
    try {
      saved = await this.userRepo.save(user);
    } catch (err: unknown) {
      // PostgreSQL unique_violation code
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        throw new ConflictException('Email already registered');
      }
      throw err;
    }

    return this.buildAuthResponse(saved);
  }

  async login(dto: LoginDto) {
    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.email = :email', { email: dto.email })
      .getOne();
    // Always run bcrypt.compare to prevent timing-based email enumeration
    const hash = user?.password_hash || DUMMY_HASH;
    const valid = await bcrypt.compare(dto.password, hash);
    if (!user || !valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.buildAuthResponse(user);
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; type: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid token type');
    }

    const user = await this.userRepo.findOne({ where: { id: payload.sub } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return this.buildAuthResponse(user);
  }

  private buildAuthResponse(user: User) {
    const accessToken = this.jwt.sign(
      { sub: user.id, type: 'access' },
      { expiresIn: ACCESS_TOKEN_EXPIRY },
    );

    const refreshToken = this.jwt.sign(
      { sub: user.id, type: 'refresh' },
      { expiresIn: REFRESH_TOKEN_EXPIRY },
    );

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_EXPIRY,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        phone: user.phone,
        created_at: user.created_at.toISOString(),
      },
    };
  }
}
