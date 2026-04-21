import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as express from 'express';

/**
 * Permissive JWT guard: lets the request through whether or not a valid
 * access token is present. When a valid token is found, it attaches
 * `req.user` the same way `AuthGuard` would; otherwise `req.user` stays
 * undefined. Handlers can then personalize the response (e.g. include
 * the caller's own vote) without forcing readers to sign in.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<express.Request>();
    const token = this.extractToken(request);
    if (!token) return true;

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; type: string }>(
        token,
      );
      if (payload.type === 'access') {
        request['user'] = { userId: payload.sub };
      }
    } catch {
      // Invalid / expired tokens on an optional path are simply ignored —
      // the client will still see the anonymous response and can refresh.
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
