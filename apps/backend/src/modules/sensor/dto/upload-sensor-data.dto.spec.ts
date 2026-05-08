import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CALIBRATION_SAMPLE_RATE_HZ,
  CALIBRATION_TARGET_SECONDS,
} from '@tarmoto/shared';
import { UploadSensorDataDto } from './upload-sensor-data.dto.js';

/**
 * Field-level validation tests for the sensor-upload DTO. The
 * service-level behaviour (calibration quality classification,
 * persistence, etc.) is covered in `sensor.service.spec.ts`; these
 * specs lock in the validation 400s the controller layer is supposed
 * to deliver before the service ever sees the payload.
 */
describe('UploadSensorDataDto field-level validation', () => {
  async function validatePayload(payload: Record<string, unknown>) {
    const dto = plainToInstance(UploadSensorDataDto, payload);
    return validate(dto, { whitelist: false });
  }

  function makeBaseUpload(
    calibrationOverrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ride_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      readings: [
        {
          t: 0,
          ax: 0,
          ay: 0,
          az: 9.81,
        },
      ],
      calibration: {
        axis_mean_x: 0,
        axis_mean_y: 0,
        axis_mean_z: 9.81,
        axis_std_x: 0.1,
        axis_std_y: 0.1,
        axis_std_z: 0.1,
        sample_count: 1500,
        truncated: false,
        ...calibrationOverrides,
      },
    };
  }

  it('accepts a calibration with sample_count at the natural target', async () => {
    const errors = await validatePayload(makeBaseUpload());
    expect(errors).toHaveLength(0);
  });

  it('rejects a calibration whose sample_count would overflow the rides.calibration_sample_count INT column', async () => {
    // Regression: a buggy / malicious client could otherwise ship
    // `3e9`, which exceeds Postgres' 4-byte INT range (~2.1B). The DTO
    // has to reject it at validation so the request 400s instead of
    // taking down the persistence path with a DB-driver 500.
    const errors = await validatePayload(
      makeBaseUpload({ sample_count: 3_000_000_000 }),
    );

    expect(errors.length).toBeGreaterThan(0);
    // Drill into the nested ValidationError tree (the violation is on
    // `calibration.sample_count`, not the top-level body).
    const calibrationError = errors.find((e) => e.property === 'calibration');
    const sampleCountError = calibrationError?.children?.find(
      (e) => e.property === 'sample_count',
    );
    expect(sampleCountError?.constraints?.max).toBeDefined();
  });

  it('caps at the documented 10× headroom over the calibrator target', async () => {
    // Pin the upper bound so a future relax that pushes it close to
    // PG INT max (and re-introduces the overflow risk) fails loudly
    // here instead of in production. 10× headroom on the on-device
    // target is plenty for any future sample-rate or window-duration
    // tweak.
    const limit = CALIBRATION_TARGET_SECONDS * CALIBRATION_SAMPLE_RATE_HZ * 10;

    const inBounds = await validatePayload(
      makeBaseUpload({ sample_count: limit }),
    );
    expect(inBounds).toHaveLength(0);

    const outOfBounds = await validatePayload(
      makeBaseUpload({ sample_count: limit + 1 }),
    );
    expect(outOfBounds.length).toBeGreaterThan(0);
  });
});
