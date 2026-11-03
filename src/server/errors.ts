// Expected, user-facing failures. api() turns these into JSON errors with their HTTP status.
export class ServiceError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, status: number, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
