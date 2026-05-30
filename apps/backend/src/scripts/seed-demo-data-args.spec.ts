import { parseArgs } from './seed-demo-data-args.js';

describe('seed-demo-data-args', () => {
  describe('defaults', () => {
    it('returns inert defaults for an empty argv', () => {
      const { options } = parseArgs([]);
      expect(options).toEqual({
        only: null,
        clean: false,
        force: false,
        help: false,
      });
    });
  });

  describe('valueless flags', () => {
    it('parses --clean', () => {
      expect(parseArgs(['--clean']).options.clean).toBe(true);
    });

    it('parses --force', () => {
      expect(parseArgs(['--force']).options.force).toBe(true);
    });

    it('parses --help', () => {
      expect(parseArgs(['--help']).options.help).toBe(true);
    });

    it('rejects a value passed to a valueless flag', () => {
      expect(() => parseArgs(['--clean=yes'])).toThrow(
        /--clean does not take a value/,
      );
    });
  });

  describe('--only', () => {
    it('captures the persona email', () => {
      expect(parseArgs(['--only=newbie@tarmoto.app']).options.only).toBe(
        'newbie@tarmoto.app',
      );
    });

    it('lowercases and trims the email so it matches the catalog', () => {
      expect(parseArgs(['--only=  Newbie@Tarmoto.App ']).options.only).toBe(
        'newbie@tarmoto.app',
      );
    });

    it('rejects an empty --only value', () => {
      expect(() => parseArgs(['--only='])).toThrow(/--only: value is empty/);
    });

    it('requires a value (use --only=email)', () => {
      expect(() => parseArgs(['--only'])).toThrow(/requires a value/);
    });
  });

  describe('strict parsing', () => {
    it('rejects unknown flags', () => {
      expect(() => parseArgs(['--wat'])).toThrow(/Unknown argument: --wat/);
    });

    it('rejects bare (non --) tokens including single-dash typos', () => {
      expect(() => parseArgs(['-clean'])).toThrow(/must start with "--"/);
    });

    it('parses several flags together', () => {
      const { options } = parseArgs([
        '--only=road.hunter@tarmoto.app',
        '--force',
      ]);
      expect(options).toEqual({
        only: 'road.hunter@tarmoto.app',
        clean: false,
        force: true,
        help: false,
      });
    });
  });
});
