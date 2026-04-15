import { createSwaggerConfig } from './swagger.config.js';

describe('createSwaggerConfig', () => {
  it('should return a valid OpenAPI config', () => {
    const config = createSwaggerConfig();
    expect(config).toBeDefined();
    expect(config.info.title).toBe('Tarmoto API');
    expect(config.info.version).toBe('1.0');
  });

  it('should include the API description', () => {
    const config = createSwaggerConfig();
    expect(config.info.description).toBe('Know the road before you ride it');
  });

  it('should configure bearer auth', () => {
    const config = createSwaggerConfig();
    expect(config.components?.securitySchemes).toBeDefined();
  });

  it('should have bearer security scheme of type http', () => {
    const config = createSwaggerConfig();
    const schemes = config.components?.securitySchemes ?? {};
    const bearerScheme = Object.values(schemes).find(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        'scheme' in s &&
        s.scheme === 'bearer',
    ) as { type: string; scheme: string } | undefined;
    expect(bearerScheme).toBeDefined();
    expect(bearerScheme!.type).toBe('http');
  });
});
