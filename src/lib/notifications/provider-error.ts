/** A provider rejection. The message is the reason code only: no body, address, or number. */
export class ProviderSendError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "ProviderSendError";
    this.status = status;
    this.code = code;
  }
}
