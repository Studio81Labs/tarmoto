import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { EmailTemplate } from '../../entities/email-template.entity.js';
import type { EmailService } from '../email/email.service.js';
import { AdminEmailTemplateService } from './admin-email-template.service.js';

function make() {
  const templates = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(
      (partial: Partial<EmailTemplate>) => partial as EmailTemplate,
    ),
    save: jest.fn((row: EmailTemplate) => Promise.resolve(row)),
    delete: jest.fn(),
  };

  const manager = {
    findOne: jest.fn(),
    delete: jest.fn(),
    save: jest.fn((row: EmailTemplate) => Promise.resolve(row)),
  };

  const dataSource = {
    transaction: jest.fn(async (cb: (m: typeof manager) => Promise<unknown>) =>
      cb(manager),
    ),
  };

  const email = {
    sendRendered: jest.fn(),
    resolvePreferencesUrl: jest.fn(
      () => 'https://app.tarmoto.example/settings/notifications',
    ),
  };

  const service = new AdminEmailTemplateService(
    templates as unknown as Repository<EmailTemplate>,
    dataSource as unknown as DataSource,
    email as unknown as EmailService,
  );

  return { service, templates, manager, dataSource, email };
}

describe('AdminEmailTemplateService', () => {
  it('saveDraft rejects an invalid doc (empty subject) with a 400', async () => {
    const { service } = make();
    await expect(
      service.saveDraft('weekly-digest', 'en', { subject: '', blocks: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('saveDraft upserts a valid doc as a new draft row', async () => {
    const { service, templates } = make();
    templates.findOne.mockResolvedValue(null);

    const result = await service.saveDraft('weekly-digest', 'en', {
      subject: 'Hi {displayName}',
      blocks: [{ type: 'paragraph', text: 'You rode {distance}' }],
    });

    expect(templates.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
    expect(result.status).toBe('draft');
  });

  it('saveDraft updates an existing draft row in place', async () => {
    const { service, templates } = make();
    const existing = {
      id: 'd1',
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'draft',
      version: 1,
      subject: 'old',
      blocks: [],
    };
    templates.findOne.mockResolvedValue(existing);

    const result = await service.saveDraft('weekly-digest', 'en', {
      subject: 'New {displayName}',
      blocks: [{ type: 'heading', text: '{distance}' }],
    });

    expect(existing.subject).toBe('New {displayName}');
    expect(existing.blocks).toEqual([{ type: 'heading', text: '{distance}' }]);
    expect(existing.status).toBe('draft');
    expect(templates.create).not.toHaveBeenCalled();
    // Same row object mutated in place, not a freshly created one.
    expect(templates.save).toHaveBeenCalledWith(existing);
    expect(result.status).toBe('draft');
  });

  it('preview renders via renderBlocks against the fixed sample presentation', async () => {
    const { service } = make();
    const result = await service.preview('weekly-digest', 'en', {
      subject: 'Hi {displayName}',
      blocks: [{ type: 'heading', text: '{distance} ridden' }],
    });
    // SAMPLE_PRESENTATION['weekly-digest'] — deterministic, real renderBlocks.
    expect(result.subject).toContain('Riku');
    expect(result.html).toContain('213 km');
  });

  it('testSend renders and dispatches, reporting sent on a truthy send result', async () => {
    const { service, email } = make();
    email.sendRendered.mockResolvedValue({ id: 'sent-1' });

    const result = await service.testSend(
      'weekly-digest',
      'en',
      {
        subject: 'Hi {displayName}',
        blocks: [{ type: 'paragraph', text: 'You rode {distance}' }],
      },
      'admin@tarmoto.app',
    );

    expect(result).toEqual({ status: 'sent' });
    expect(email.sendRendered).toHaveBeenCalledWith(
      'admin@tarmoto.app',
      expect.objectContaining({
        tag: 'weekly-digest',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() returns any; asymmetric matcher is intentional
        subject: expect.any(String),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() returns any; asymmetric matcher is intentional
        html: expect.any(String),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() returns any; asymmetric matcher is intentional
        text: expect.any(String),
      }),
    );
  });

  it('testSend reports failed when the send result is falsy', async () => {
    const { service, email } = make();
    email.sendRendered.mockResolvedValue(null);

    const result = await service.testSend(
      'weekly-digest',
      'en',
      {
        subject: 'Hi {displayName}',
        blocks: [{ type: 'paragraph', text: 'You rode {distance}' }],
      },
      'admin@tarmoto.app',
    );

    expect(result).toEqual({ status: 'failed' });
  });

  it('testSend rejects an invalid doc with a 400 before dispatching a send', async () => {
    const { service, email } = make();

    await expect(
      service.testSend(
        'weekly-digest',
        'en',
        { subject: '', blocks: [] },
        'admin@tarmoto.app',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(email.sendRendered).not.toHaveBeenCalled();
  });

  it('publish 404s when there is no draft to promote', async () => {
    const { service, manager } = make();
    manager.findOne.mockResolvedValue(null);
    await expect(service.publish('weekly-digest', 'en')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('publish deletes the prior published row before promoting the draft', async () => {
    const { service, manager } = make();
    const draftRow = {
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'draft',
      version: 1,
      subject: 'x',
      blocks: [],
    };
    // publish() now reads twice: once for the draft, once for the prior
    // published row (to continue its version) — query-aware by `where.status`.
    manager.findOne.mockImplementation(
      (_entity: unknown, opts: { where: { status: string } }) =>
        Promise.resolve(opts.where.status === 'draft' ? draftRow : null),
    );

    const result = await service.publish('weekly-digest', 'en');

    // Delete-old-published must happen before promote-draft is saved, or the
    // partial unique index (≤1 published row per tag/locale) would reject it.
    expect(manager.delete.mock.invocationCallOrder[0]!).toBeLessThan(
      manager.save.mock.invocationCallOrder[0]!,
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'published', version: 2 }),
    );
    expect(result.status).toBe('published');
    expect(result.version).toBe(2);
  });

  it('publish continues the version from the prior published row, not the draft default', async () => {
    const { service, manager } = make();
    const draftRow = {
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'draft',
      version: 1,
      subject: 'x',
      blocks: [],
    };
    const priorPublished = {
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'published',
      version: 5,
      subject: 'old-published',
      blocks: [],
    };
    manager.findOne.mockImplementation(
      (_entity: unknown, opts: { where: { status: string } }) =>
        Promise.resolve(
          opts.where.status === 'draft' ? draftRow : priorPublished,
        ),
    );

    const result = await service.publish('weekly-digest', 'en');

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'published', version: 6 }),
    );
    expect(result.status).toBe('published');
    expect(result.version).toBe(6);
  });

  it('publish 400s and mutates nothing when the stored draft is invalid', async () => {
    const { service, manager } = make();
    // A draft that reached the table out-of-band (or under since-tightened
    // rules) with a CRLF subject. The render path interpolates the subject raw
    // into a plain-text header and does NOT sanitize control chars, so publish
    // is the gate that must reject it before it goes live.
    const badDraft = {
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'draft',
      version: 1,
      subject: 'Weekly\r\nBcc: evil@example.com',
      blocks: [],
    };
    manager.findOne.mockImplementation(
      (_entity: unknown, opts: { where: { status: string } }) =>
        Promise.resolve(opts.where.status === 'draft' ? badDraft : null),
    );

    await expect(service.publish('weekly-digest', 'en')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Rejected before mutating anything — the live published row is untouched.
    expect(manager.delete).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('reset deletes the published row for (tag, locale)', async () => {
    const { service, templates } = make();
    await service.reset('weekly-digest', 'en');
    expect(templates.delete).toHaveBeenCalledWith({
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'published',
    });
  });

  it('404s for a non-editable (locked) tag', async () => {
    const { service } = make();
    await expect(service.get('verification', 'en')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
