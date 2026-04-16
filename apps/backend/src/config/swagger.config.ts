import { DocumentBuilder } from '@nestjs/swagger';

export function createSwaggerConfig() {
  return new DocumentBuilder()
    .setTitle('Tarmoto API')
    .setDescription('Know the road before you ride it')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
}
