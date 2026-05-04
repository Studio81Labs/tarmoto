import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import * as express from 'express';
import { User } from '../../entities/user.entity.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<express.Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException();
    }

    let userId: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; type: string }>(
        token,
      );
      if (payload.type !== 'access') {
        throw new UnauthorizedException('Invalid token type');
      }
      userId = payload.sub;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException();
    }

    // GDPR Art. 17 (US-62): once an account is soft-deleted, every
    // authenticated request must be rejected immediately — not on the
    // next access-token rotation. The query is a single PK lookup
    // selecting only the columns we need, so it adds ~1 indexed read
    // per authenticated request. Worth the cost vs. leaving deleted
    // accounts addressable for up to an hour after deletion.
    const account = await this.em.findOne(User, {
      where: { id: userId },
      select: { id: true, deleted_at: true },
    });
    if (!account || account.deleted_at != null) {
      throw new UnauthorizedException();
    }

    request['user'] = { userId };
    return true;
  }

  private extractToken(request: express.Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;

    const [type, token] = header.split(' ');
    return type === 'Bearer' ? token : undefined;
  }
}
