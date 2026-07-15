import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { EmailTemplate } from '../../entities/email-template.entity.js';
import type { EmailService } from '../email/email.service.js';
import { AdminEmailTemplateService } from './admin-email-template.service.js';
import { DEFAULT_TEMPLATE_BLOCKS } from './default-template-blocks.js';

function make() {
  const templates = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(
      (partial: Partial<EmailTemplate>) => partial as EmailTemplate,
    ),
    save: jest.fn((row: EmailTemplate) => Promise.resolve(row)),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    delete: jest.fn(),
  };

  const manager = {
    findOne: jest.fn(),
    delete: jest.fn(),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    create: jest.fn(
      (_entity: unknown, partial: Partial<EmailTemplate>) =>
        partial as EmailTemplate,
    ),
    save: jest.fn((row: EmailTemplate) => Promise.resolve(row)),
    query: jest.fn(),
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

  it('saveDraft inserts a fresh draft when the scoped update matches no draft row', async () => {
    const { service, templates } = make();
    // No draft row matched (none existed, or it was published between calls).
    templates.update.mockResolvedValue({ affected: 0 });
    templates.findOne.mockResolvedValue({
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'draft',
      version: 1,
      subject: 'Hi {displayName}',
      blocks: [{ type: 'paragraph', text: 'You rode {distance}' }],
    });

    const result = await service.saveDraft('weekly-digest', 'en', {
      subject: 'Hi {displayName}',
      blocks: [{ type: 'paragraph', text: 'You rode {distance}' }],
    });

    // Scoped write targets only draft rows; nothing matched → insert a fresh
    // draft rather than reverting any row that a concurrent publish promoted.
    expect(templates.update).toHaveBeenCalledWith(
      { template_tag: 'weekly-digest', locale: 'en', status: 'draft' },
      expect.objectContaining({ subject: 'Hi {displayName}' }),
    );
    expect(templates.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
    expect(result.status).toBe('draft');
  });

  it('saveDraft updates the draft via a status-scoped write, never rewriting a published row', async () => {
    const { service, templates } = make();
    templates.update.mockResolvedValue({ affected: 1 });
    templates.findOne.mockResolvedValue({
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'draft',
      version: 1,
      subject: 'New {displayName}',
      blocks: [{ type: 'heading', text: '{distance}' }],
    });

    const result = await service.saveDraft('weekly-digest', 'en', {
      subject: 'New {displayName}',
      blocks: [{ type: 'heading', text: '{distance}' }],
    });

    // The write is a targeted UPDATE ... WHERE status = 'draft' carrying only
    // subject/blocks — so a row a super_admin published between our read and
    // write can never be reverted to draft (the guard for this finding).
    expect(templates.update).toHaveBeenCalledWith(
      { template_tag: 'weekly-digest', locale: 'en', status: 'draft' },
      {
        subject: 'New {displayName}',
        blocks: [{ type: 'heading', text: '{distance}' }],
      },
    );
    // Matched an existing draft → no full-entity save (which would carry the
    // stale status) and no freshly created row.
    expect(templates.create).not.toHaveBeenCalled();
    expect(templates.save).not.toHaveBeenCalled();
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

  it('publish archives the prior published row before promoting the draft, and records the publisher', async () => {
    const { service, manager } = make();
    const draftRow = {
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'draft',
      version: 1,
      subject: 'x',
      blocks: [],
    };
    // findOne is called for: the draft (status 'draft'), and the top
    // published/archived row for nextVersion (order.version 'DESC').
    manager.findOne.mockImplementation(
      (
        _entity: unknown,
        opts: { where: { status: unknown }; order?: { version?: string } },
      ) => {
        if (opts.where.status === 'draft') return Promise.resolve(draftRow);
        if (opts.order?.version === 'DESC') return Promise.resolve(null); // first publish
        return Promise.resolve(null);
      },
    );

    const result = await service.publish('weekly-digest', 'en', 'admin-1');

    // Archive-old must run before promote-save, or the partial unique index
    // (<=1 published per tag/locale) rejects the promote.
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { template_tag: 'weekly-digest', locale: 'en', status: 'published' },
      { status: 'archived' },
    );
    expect(manager.update.mock.invocationCallOrder[0]!).toBeLessThan(
      manager.save.mock.invocationCallOrder[0]!,
    );
    // First-ever publish (no published/archived) → version 1.
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'published',
        version: 1,
        created_by: 'admin-1',
      }),
    );
    expect(result.status).toBe('published');
    expect(result.version).toBe(1);
    // Draft read FOR UPDATE + the (tag, locale) advisory lock still hold.
    expect(manager.findOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['email_template:weekly-digest:en'],
    );
    // Never deletes — the prior version is retained as history.
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('publish numbers the new version at MAX(published+archived)+1', async () => {
    const { service, manager } = make();
    const draftRow = {
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'draft',
      version: 1,
      subject: 'x',
      blocks: [],
    };
    manager.findOne.mockImplementation(
      (
        _entity: unknown,
        opts: { where: { status: unknown }; order?: { version?: string } },
      ) => {
        if (opts.where.status === 'draft') return Promise.resolve(draftRow);
        if (opts.order?.version === 'DESC')
          return Promise.resolve({ version: 5 }); // highest existing
        return Promise.resolve(null);
      },
    );

    const result = await service.publish('weekly-digest', 'en', 'admin-1');

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'published', version: 6 }),
    );
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
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('reset deletes the published row under the advisory lock', async () => {
    const { service, manager } = make();
    await service.reset('weekly-digest', 'en');
    // Runs inside the transaction and takes the same (tag, locale) advisory
    // lock as publish, so a reset overlapping a publish can't return 200 while
    // the just-published override stays live.
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['email_template:weekly-digest:en'],
    );
    expect(manager.delete).toHaveBeenCalledWith(expect.anything(), {
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

  it('get seeds from the default doc when there is no draft or published row', async () => {
    const { service, templates } = make();
    templates.findOne.mockResolvedValue(null); // no draft, no published
    const result = await service.get('weekly-digest', 'en');
    expect(result.status).toBe('none');
    expect(result.version).toBe(0);
    expect(result.subject).toBe(
      DEFAULT_TEMPLATE_BLOCKS['weekly-digest'].subject,
    );
    expect(result.blocks).toEqual(
      DEFAULT_TEMPLATE_BLOCKS['weekly-digest'].blocks,
    );
    expect(result.whitelist.textVars).toContain('displayName');
  });
});
