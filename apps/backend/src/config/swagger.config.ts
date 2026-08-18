import { DocumentBuilder } from '@nestjs/swagger';

export function createSwaggerConfig() {
  return (
    new DocumentBuilder()
      .setTitle('Tarmoto API')
      .setDescription('Know the road before you ride it')
      .setVersion('1.0')
      // Informational for spec consumers (clients resolve their base URL from
      // runtime config, not from here). Without at least one entry the export
      // emits `servers: []`, which the redocly gate rejects (no-empty-servers).
      .addServer('https://api.tarmoto.app', 'Production')
      .addServer('https://api-staging.tarmoto.app', 'Staging')
      .addServer('http://localhost:3000', 'Local development')
      .addBearerAuth()
      .build()
  );
}
