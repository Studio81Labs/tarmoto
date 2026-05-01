/**
 * DI token for the `ObjectStorage` provider. Modules that consume
 * object storage should `@Inject(OBJECT_STORAGE)` rather than
 * importing a concrete class so the provider can be swapped via env
 * config (`TARMOTO_STORAGE_DRIVER`).
 */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
