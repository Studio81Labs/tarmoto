import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { createSwaggerConfig } from './config/swagger.config.js';

async function bootstrap() {
  const isProd = process.env.TARMOTO_NODE_ENV === 'production';
  const app = await NestFactory.create(AppModule);

  app.use(isProd ? helmet() : helmet({ contentSecurityPolicy: false }));
  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  if (!isProd) {
    const document = SwaggerModule.createDocument(app, createSwaggerConfig());
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(process.env.TARMOTO_PORT ?? 3000);
}

void bootstrap();
