import { getMetadataArgsStorage } from 'typeorm';
import { AdminUser } from './admin-user.entity.js';

describe('AdminUser entity metadata', () => {
  it('maps to the admin_users table with the expected columns', () => {
    // Importing AdminUser causes its decorators to run and register
    // metadata in TypeORM's global MetadataArgsStorage. We check that
    // storage directly so this test runs without a DB connection.
    void AdminUser;

    const storage = getMetadataArgsStorage();

    const tableArg = storage.tables.find((t) => t.target === AdminUser);
    expect(tableArg?.name).toBe('admin_users');

    const columnNames = storage.columns
      .filter((c) => c.target === AdminUser)
      .map((c) => c.propertyName);

    expect(columnNames).toEqual(
      expect.arrayContaining([
        'id',
        'email',
        'password_hash',
        'role',
        'status',
        'sso_provider',
        'sso_subject',
        'last_login_at',
      ]),
    );
  });
});
