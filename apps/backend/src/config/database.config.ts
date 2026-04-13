import { registerAs } from '@nestjs/config';

export const databaseConfig = registerAs('database', () => ({
  host: process.env.TARMOTO_DATABASE_HOST || 'localhost',
  port: parseInt(process.env.TARMOTO_DATABASE_PORT || '5432', 10),
  database: process.env.TARMOTO_DATABASE_NAME || 'tarmoto',
  username: process.env.TARMOTO_DATABASE_USER || 'tarmoto',
  password: process.env.TARMOTO_DATABASE_PASSWORD || 'tarmoto',
}));
