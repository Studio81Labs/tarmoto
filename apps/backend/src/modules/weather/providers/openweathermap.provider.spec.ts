import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OpenWeatherMapProvider } from './openweathermap.provider.js';

describe('OpenWeatherMapProvider', () => {
  let provider: OpenWeatherMapProvider;

  const mockOWMResponse = {
    main: { temp: 14.2, humidity: 65 },
    weather: [{ id: 800, main: 'Clear', description: 'clear sky' }],
    wind: { speed: 3.5 },
    clouds: { all: 10 },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenWeatherMapProvider,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('test-api-key'),
          },
        },
      ],
    }).compile();

    provider = module.get<OpenWeatherMapProvider>(OpenWeatherMapProvider);

    // Mock global fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockOWMResponse),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should call OWM API with correct URL', async () => {
    await provider.getCurrentWeather(49.1, 16.75);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('lat=49.1&lon=16.75'),
    );
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('units=metric'));
  });

  it('should normalize clear weather correctly', async () => {
    const result = await provider.getCurrentWeather(49.1, 16.75);

    expect(result.temperature_c).toBe(14.2);
    expect(result.condition).toBe('clear');
    expect(result.wind_kmh).toBeCloseTo(12.6, 0);
    expect(result.road_condition).toBe('dry');
    expect(result.precipitation_chance).toBe(0);
  });

  it('should map rain conditions', async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ...mockOWMResponse,
          weather: [{ id: 500, main: 'Rain', description: 'light rain' }],
          rain: { '1h': 1.5 },
        }),
    });

    const result = await provider.getCurrentWeather(49.1, 16.75);

    expect(result.condition).toBe('rain');
    expect(result.road_condition).toBe('wet');
    expect(result.precipitation_chance).toBe(1.0);
  });

  it('should detect icy conditions from snow', async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ...mockOWMResponse,
          main: { temp: -2, humidity: 80 },
          weather: [{ id: 601, main: 'Snow', description: 'snow' }],
          snow: { '1h': 2.0 },
        }),
    });

    const result = await provider.getCurrentWeather(49.1, 16.75);

    expect(result.condition).toBe('snow');
    expect(result.road_condition).toBe('icy');
  });

  it('should detect icy from rain + freezing temp', async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ...mockOWMResponse,
          main: { temp: -1, humidity: 90 },
          weather: [{ id: 500, main: 'Rain', description: 'freezing rain' }],
          rain: { '1h': 0.5 },
        }),
    });

    const result = await provider.getCurrentWeather(49.1, 16.75);

    expect(result.road_condition).toBe('icy');
  });

  it('should map storm conditions', async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ...mockOWMResponse,
          weather: [
            { id: 211, main: 'Thunderstorm', description: 'thunderstorm' },
          ],
          rain: { '1h': 5.0 },
        }),
    });

    const result = await provider.getCurrentWeather(49.1, 16.75);

    expect(result.condition).toBe('storm');
    expect(result.road_condition).toBe('wet');
  });

  it('should throw on API error', async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(provider.getCurrentWeather(49.1, 16.75)).rejects.toThrow(
      'OpenWeatherMap API error: 401 Unauthorized',
    );
  });
});
