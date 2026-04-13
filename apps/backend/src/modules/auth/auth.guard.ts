import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as express from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<express.Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException();
    }

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; type: string }>(
        token,
      );
      if (payload.type !== 'access') {
        throw new UnauthorizedException('Invalid token type');
      }
      request['user'] = { userId: payload.sub };
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException();
    }

    return true;
  }

  private extractToken(request: express.Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;

    const [type, token] = header.split(' ');
    return type === 'Bearer' ? token : undefined;
  }
}
