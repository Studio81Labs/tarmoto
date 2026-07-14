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

  it('publish 404s when there is no draft to promote', async () => {
    const { service, manager } = make();
    manager.findOne.mockResolvedValue(null);
    await expect(service.publish('weekly-digest', 'en')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('publish deletes the prior published row before promoting the draft', async () => {
    const { service, manager } = make();
    manager.findOne.mockResolvedValue({
      template_tag: 'weekly-digest',
      locale: 'en',
      status: 'draft',
      version: 1,
      subject: 'x',
      blocks: [],
    });

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
