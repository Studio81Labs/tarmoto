import { registerAs } from '@nestjs/config';

// Auth fields (`username`, `password`) are optional so dev (no auth)
// keeps working unchanged. Coolify-managed and other production Redis
// instances will set both — `default` is the standard ACL username.
export const redisConfig = registerAs('redis', () => ({
  host: process.env.TARMOTO_REDIS_HOST || 'localhost',
  port: parseInt(process.env.TARMOTO_REDIS_PORT || '6379', 10),
  username: process.env.TARMOTO_REDIS_USERNAME || undefined,
  password: process.env.TARMOTO_REDIS_PASSWORD || undefined,
}));
