import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';

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
    const config = new DocumentBuilder()
      .setTitle('Tarmoto API')
      .setDescription('Know the road before you ride it')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(process.env.TARMOTO_PORT ?? 3000);
}

void bootstrap();
