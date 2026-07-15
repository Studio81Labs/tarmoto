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
    manager: { find: jest.fn() },
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

  it('saveDraft inserts a fresh draft under the lock when no draft row matches', async () => {
    const { service, templates, manager } = make();
    manager.update.mockResolvedValue({ affected: 0 });
    templates.findOne.mockResolvedValue({
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'draft',
      version: 1,
      subject: 'Hi {displayName}',
      blocks: [{ type: 'paragraph', text: 'You rode {distance}' }],
    });

    const result = await service.saveDraft(
      'weekly-digest',
      'en',
      {
        subject: 'Hi {displayName}',
        blocks: [{ type: 'paragraph', text: 'You rode {distance}' }],
      },
      'admin-1',
    );

    // Serialized under the (tag, locale) advisory lock so two concurrent
    // first-saves can't both insert.
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['email_template:weekly-digest:en'],
    );
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { template_tag: 'weekly-digest', locale: 'en', status: 'draft' },
      expect.objectContaining({ subject: 'Hi {displayName}' }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft', created_by: 'admin-1' }),
    );
    expect(result.status).toBe('draft');
  });

  it('saveDraft updates the draft via a status-scoped write, never rewriting a published row', async () => {
    const { service, templates, manager } = make();
    manager.update.mockResolvedValue({ affected: 1 });
    templates.findOne.mockResolvedValue({
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'draft',
      version: 1,
      subject: 'New {displayName}',
      blocks: [{ type: 'heading', text: '{distance}' }],
    });

    const result = await service.saveDraft(
      'weekly-digest',
      'en',
      {
        subject: 'New {displayName}',
        blocks: [{ type: 'heading', text: '{distance}' }],
      },
      'admin-1',
    );

    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { template_tag: 'weekly-digest', locale: 'en', status: 'draft' },
      {
        subject: 'New {displayName}',
        blocks: [{ type: 'heading', text: '{distance}' }],
      },
    );
    // Matched a draft → no insert.
    expect(manager.create).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
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

  it('reset archives the live published row (keeps it in history), never deletes', async () => {
    const { service, manager } = make();
    await service.reset('weekly-digest', 'en');
    // Runs inside the transaction and takes the same (tag, locale) advisory
    // lock as publish, so a reset overlapping a publish can't return 200 while
    // the just-published override stays live.
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['email_template:weekly-digest:en'],
    );
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { template_tag: 'weekly-digest', locale: 'en', status: 'published' },
      { status: 'archived' },
    );
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('publish after a reset continues numbering from the archived versions (no reuse)', async () => {
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
        // Post-reset: no published row; the highest published/archived is an archived v3.
        if (opts.order?.version === 'DESC')
          return Promise.resolve({ version: 3, status: 'archived' });
        return Promise.resolve(null);
      },
    );

    const result = await service.publish('weekly-digest', 'en', 'admin-1');

    // nextVersion = MAX(published+archived) + 1 = 4 — the archived v3 is counted, not skipped/reused.
    expect(result.version).toBe(4);

    // Confirm the lookup itself widens status to In(['published','archived'])
    // via TypeORM's public `.type`/`.value` FindOperator getters, not just the
    // resulting number — call[1] is the nextVersion lookup (call[0] is the draft read).
    const [, nextVersionOpts] = manager.findOne.mock.calls[1] as [
      unknown,
      { where: { status: { type: string; value: unknown } } },
    ];
    expect(nextVersionOpts.where.status.type).toBe('in');
    expect(nextVersionOpts.where.status.value).toEqual([
      'published',
      'archived',
    ]);
  });

  it('revert re-publishes the target version content as a new version, archiving the current live one', async () => {
    const { service, manager } = make();
    const target = {
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'archived',
      version: 2,
      subject: 'old-good',
      blocks: [{ type: 'paragraph', text: 'restore me' }],
    };
    manager.findOne.mockImplementation(
      (
        _entity: unknown,
        opts: { where: { version?: number }; order?: { version?: string } },
      ) => {
        if (opts.where.version === 2) return Promise.resolve(target); // target lookup
        if (opts.order?.version === 'DESC')
          return Promise.resolve({ version: 4 }); // highest existing
        return Promise.resolve(null);
      },
    );

    const result = await service.revert('weekly-digest', 'en', 2, 'admin-9');

    // Serialized under the advisory lock.
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['email_template:weekly-digest:en'],
    );
    // Archive current published before inserting the new one.
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { template_tag: 'weekly-digest', locale: 'en', status: 'published' },
      { status: 'archived' },
    );
    expect(manager.update.mock.invocationCallOrder[0]!).toBeLessThan(
      manager.save.mock.invocationCallOrder[0]!,
    );
    // New published version = MAX+1, target's content, acting admin as author.
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'published',
        version: 5,
        subject: 'old-good',
        created_by: 'admin-9',
      }),
    );
    expect(result.status).toBe('published');
    expect(result.version).toBe(5);
  });

  it('revert 404s for an unknown version', async () => {
    const { service, manager } = make();
    manager.findOne.mockResolvedValue(null);
    await expect(
      service.revert('weekly-digest', 'en', 99, 'admin-9'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('revert 400s and mutates nothing when the target content fails current validation', async () => {
    const { service, manager } = make();
    const badTarget = {
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'archived',
      version: 2,
      subject: 'Weekly\r\nBcc: evil@example.com',
      blocks: [],
    };
    manager.findOne.mockImplementation(
      (_entity: unknown, opts: { where: { version?: number } }) =>
        Promise.resolve(opts.where.version === 2 ? badTarget : null),
    );
    await expect(
      service.revert('weekly-digest', 'en', 2, 'admin-9'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
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

  it('history returns published+archived versions newest-first with authors resolved to email', async () => {
    const { service, templates } = make();
    templates.find.mockResolvedValue([
      {
        version: 3,
        status: 'published',
        created_by: 'admin-1',
        published_at: new Date('2026-07-10T00:00:00.000Z'),
        subject: 's3',
        blocks: [{ type: 'paragraph', text: 'v3' }],
      },
      {
        version: 2,
        status: 'archived',
        created_by: null, // seed/system
        published_at: new Date('2026-07-01T00:00:00.000Z'),
        subject: 's2',
        blocks: [],
      },
    ]);
    templates.manager.find.mockResolvedValue([
      { id: 'admin-1', email: 'jane@tarmoto.app' },
    ]);

    const result = await service.history('weekly-digest', 'en');

    // Read scoped to published+archived, ordered version DESC.
    expect(templates.find).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining() returns any; asymmetric matcher is intentional
        where: expect.objectContaining({
          template_tag: 'weekly-digest',
          locale: 'en',
        }),
        order: { version: 'DESC' },
      }),
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      version: 3,
      status: 'published',
      author: 'jane@tarmoto.app',
      publishedAt: '2026-07-10T00:00:00.000Z',
      subject: 's3',
      blocks: [{ type: 'paragraph', text: 'v3' }],
    });
    // Null author → null (UI renders "System"); one batched admin_users lookup.
    expect(result[1]!.author).toBeNull();
    expect(templates.manager.find).toHaveBeenCalledTimes(1);
  });

  it('history skips the admin_users lookup when no version has an author', async () => {
    const { service, templates } = make();
    templates.find.mockResolvedValue([
      {
        version: 1,
        status: 'published',
        created_by: null,
        published_at: null,
        subject: 's1',
        blocks: [],
      },
    ]);

    const result = await service.history('weekly-digest', 'en');

    expect(result[0]!.author).toBeNull();
    expect(result[0]!.publishedAt).toBeNull();
    expect(templates.manager.find).not.toHaveBeenCalled();
  });

  it('history renders author null when the created_by admin no longer exists', async () => {
    const { service, templates } = make();
    templates.find.mockResolvedValue([
      {
        version: 1,
        status: 'published',
        created_by: 'ghost-admin',
        published_at: new Date('2026-07-01T00:00:00.000Z'),
        subject: 's1',
        blocks: [],
      },
    ]);
    templates.manager.find.mockResolvedValue([]); // admin row not found (deleted)
    const result = await service.history('weekly-digest', 'en');
    expect(result[0]!.author).toBeNull();
  });
});
