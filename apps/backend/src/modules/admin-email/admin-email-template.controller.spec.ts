import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ADMIN_ROLES_KEY } from '../admin-auth/admin-role.decorator.js';
import type { AdminRequest } from '../admin/internal.guard.js';
import { AdminEmailTemplateController } from './admin-email-template.controller.js';
import type { AdminEmailTemplateService } from './admin-email-template.service.js';

describe('AdminEmailTemplateController', () => {
  const service = {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ tag: 'weekly-digest' }),
    saveDraft: jest.fn().mockResolvedValue({ tag: 'weekly-digest' }),
    preview: jest
      .fn()
      .mockResolvedValue({ subject: 's', html: 'h', text: 't' }),
    testSend: jest.fn().mockResolvedValue({ status: 'sent' }),
    publish: jest.fn().mockResolvedValue({ tag: 'weekly-digest' }),
    reset: jest.fn().mockResolvedValue(undefined),
    history: jest.fn().mockResolvedValue([]),
    revert: jest.fn().mockResolvedValue({ tag: 'weekly-digest' }),
  } as unknown as jest.Mocked<AdminEmailTemplateService>;
  const controller = new AdminEmailTemplateController(service);
  const adminReq = () =>
    ({
      adminUser: { id: 'admin-1', email: 'admin@tarmoto.app' },
    }) as unknown as AdminRequest;

  // Call counts must not leak across tests that share this `service` mock —
  // e.g. the "unsupported locale" test asserts `service.get` was NOT called,
  // which would be a false negative if an earlier test's call to the same
  // mock were still on the tape. `clearAllMocks` (not `resetAllMocks`) wipes
  // call history only, leaving each method's `mockResolvedValue` intact.
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('role metadata', () => {
    it('requires super_admin on publish', () => {
      expect(
        Reflect.getMetadata(
          ADMIN_ROLES_KEY,
          // eslint-disable-next-line @typescript-eslint/unbound-method -- read for its metadata, never called unbound.
          AdminEmailTemplateController.prototype.publish,
        ),
      ).toEqual(['super_admin']);
    });

    it('requires super_admin on reset', () => {
      expect(
        Reflect.getMetadata(
          ADMIN_ROLES_KEY,
          // eslint-disable-next-line @typescript-eslint/unbound-method -- read for its metadata, never called unbound.
          AdminEmailTemplateController.prototype.reset,
        ),
      ).toEqual(['super_admin']);
    });

    it('requires super_admin on revert', () => {
      expect(
        Reflect.getMetadata(
          ADMIN_ROLES_KEY,
          // eslint-disable-next-line @typescript-eslint/unbound-method -- read for its metadata, never called unbound.
          AdminEmailTemplateController.prototype.revert,
        ),
      ).toEqual(['super_admin']);
    });

    it.each([
      'list',
      'get',
      'saveDraft',
      'preview',
      'testSend',
      'history',
    ] as const)('requires support on %s', (method) => {
      expect(
        Reflect.getMetadata(
          ADMIN_ROLES_KEY,
          // eslint-disable-next-line @typescript-eslint/unbound-method -- prototype method used as a metadata key, never invoked
          AdminEmailTemplateController.prototype[method],
        ),
      ).toEqual(['support']);
    });
  });

  describe('behavior', () => {
    it('get forwards the narrowed locale to the service', async () => {
      await controller.get('weekly-digest', 'en');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.get).toHaveBeenCalledWith('weekly-digest', 'en');
    });

    it('get rejects an unsupported locale without calling the service', () => {
      expect(() => controller.get('weekly-digest', 'xx')).toThrow(
        BadRequestException,
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.get).not.toHaveBeenCalled();
    });

    it('testSend threads the requesting admin email through to the service', async () => {
      const req = adminReq();
      const dto = { subject: 's', blocks: [] };

      await controller.testSend(req, 'weekly-digest', 'en', dto);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.testSend).toHaveBeenCalledWith(
        'weekly-digest',
        'en',
        dto,
        'admin@tarmoto.app',
      );
    });

    it('testSend rejects when the authenticated admin has no email', () => {
      const req = { adminUser: undefined } as unknown as AdminRequest;
      const dto = { subject: 's', blocks: [] };

      expect(() =>
        controller.testSend(req, 'weekly-digest', 'en', dto),
      ).toThrow(BadRequestException);
    });

    it('publish forwards (tag, locale, actorId) to the service', async () => {
      const req = adminReq();
      await controller.publish(req, 'weekly-digest', 'en');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.publish).toHaveBeenCalledWith(
        'weekly-digest',
        'en',
        'admin-1',
      );
    });

    it('saveDraft forwards (tag, locale, dto, actorId) to the service', async () => {
      const req = adminReq();
      const dto = { subject: 's', blocks: [] };
      await controller.saveDraft(req, 'weekly-digest', 'en', dto);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.saveDraft).toHaveBeenCalledWith(
        'weekly-digest',
        'en',
        dto,
        'admin-1',
      );
    });

    it('history forwards the narrowed locale to the service', async () => {
      await controller.history('weekly-digest', 'en');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.history).toHaveBeenCalledWith('weekly-digest', 'en');
    });

    it('revert parses the version and forwards (tag, locale, version, actorId)', async () => {
      const req = adminReq();
      await controller.revert(req, 'weekly-digest', 'en', '3');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.revert).toHaveBeenCalledWith(
        'weekly-digest',
        'en',
        3,
        'admin-1',
      );
    });

    it('revert rejects a non-numeric version without calling the service', () => {
      const req = adminReq();
      expect(() =>
        controller.revert(req, 'weekly-digest', 'en', 'abc'),
      ).toThrow(BadRequestException);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.revert).not.toHaveBeenCalled();
    });
  });
});
