/**
 * Owner-facing commit rejection. Only `commitImport` constructs this.
 * The action shows `message` for `instanceof` this class alone.
 */
export class CsvImportRejection extends Error {
  constructor(message: string) {
    super(message);
  }
}
