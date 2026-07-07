import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Poi } from '../../entities/poi.entity.js';
import { isPoiConnectionError, withPoiRepo } from './poi-repo.js';

function connErr(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code });
}

describe('withPoiRepo', () => {
  it('rejects ServiceUnavailableException and never calls op when the DataSource is not initialized', async () => {
    const op = jest.fn();
    const ds = { isInitialized: false } as unknown as DataSource;

    await expect(withPoiRepo(ds, op)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(op).not.toHaveBeenCalled();
  });

  it('returns the resolved value and calls getRepository(Poi) once when connected', async () => {
    const repo = { marker: 'the-repo' } as unknown as Repository<Poi>;
    const getRepository = jest.fn().mockReturnValue(repo);
    const ds = { isInitialized: true, getRepository } as unknown as DataSource;
    const op = jest.fn().mockResolvedValue('the-value');

    await expect(withPoiRepo(ds, op)).resolves.toBe('the-value');
    expect(getRepository).toHaveBeenCalledTimes(1);
    expect(getRepository).toHaveBeenCalledWith(Poi);
    expect(op).toHaveBeenCalledWith(repo);
  });

  it('maps a runtime connection-loss error (op throws mid-query) to a 503, not the raw error', async () => {
    const repo = {} as unknown as Repository<Poi>;
    const ds = {
      isInitialized: true,
      getRepository: jest.fn().mockReturnValue(repo),
    } as unknown as DataSource;
    const op = jest
      .fn()
      .mockRejectedValue(
        connErr('08006', 'Connection terminated unexpectedly'),
      );

    await expect(withPoiRepo(ds, op)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('propagates a NON-connection error (e.g. a unique violation) unchanged', async () => {
    const repo = {} as unknown as Repository<Poi>;
    const ds = {
      isInitialized: true,
      getRepository: jest.fn().mockReturnValue(repo),
    } as unknown as DataSource;
    const dup = connErr('23505', 'dup');
    const op = jest.fn().mockRejectedValue(dup);

    await expect(withPoiRepo(ds, op)).rejects.toBe(dup);
  });
});

describe('isPoiConnectionError', () => {
  it.each([
    ['pg SQLSTATE 08006 (connection failure)', connErr('08006')],
    ['pg SQLSTATE 57P03 (cannot connect now)', connErr('57P03')],
    ['node socket code ECONNREFUSED', connErr('ECONNREFUSED')],
    [
      '"Connection terminated" message with no code',
      new Error('Connection terminated unexpectedly'),
    ],
  ])('returns true for %s', (_label, err) => {
    expect(isPoiConnectionError(err)).toBe(true);
  });

  it.each([
    ['a unique-violation (23505)', connErr('23505')],
    ['a plain logic error', new Error('bad geometry')],
    ['a non-Error thrown value', 'just a string'],
  ])('returns false for %s', (_label, err) => {
    expect(isPoiConnectionError(err)).toBe(false);
  });
});
