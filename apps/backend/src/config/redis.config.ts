import { registerAs } from '@nestjs/config';

export const redisConfig = registerAs('redis', () => ({
  host: process.env.TARMOTO_REDIS_HOST || 'localhost',
  port: parseInt(process.env.TARMOTO_REDIS_PORT || '6379', 10),
}));
