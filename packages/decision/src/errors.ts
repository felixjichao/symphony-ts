export class DecisionStoreError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "store_error", status = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
  }
}

export class DecisionStoreLockError extends DecisionStoreError {
  constructor(message: string) {
    super(message, "store_locked", 503);
  }
}

export class CorruptedStoreError extends DecisionStoreError {
  constructor(message: string) {
    super(message, "corrupted_store", 500);
  }
}

export class UnsupportedStoreVersionError extends DecisionStoreError {
  constructor(version: unknown) {
    super(`Unsupported store schemaVersion: ${String(version)}`, "unsupported_store_version", 500);
  }
}

export class StorePoisonedError extends DecisionStoreError {
  constructor(message: string) {
    super(`Store is poisoned due to previous write failure: ${message}`, "store_poisoned", 503);
  }
}

export class DecisionConflictError extends DecisionStoreError {
  constructor(message: string, code = "conflict") {
    super(message, code, 409);
  }
}

export class DecisionNotFoundError extends DecisionStoreError {
  constructor(message: string, code = "not_found") {
    super(message, code, 404);
  }
}

export class DecisionValidationError extends DecisionStoreError {
  constructor(message: string, code = "validation_error") {
    super(message, code, 400);
  }
}

export class DecisionUnauthorizedError extends DecisionStoreError {
  constructor(message = "Missing or invalid authorization token") {
    super(message, "unauthorized", 401);
  }
}

export class DecisionPayloadTooLargeError extends DecisionStoreError {
  constructor(message = "Request payload exceeds size limit") {
    super(message, "payload_too_large", 413);
  }
}
