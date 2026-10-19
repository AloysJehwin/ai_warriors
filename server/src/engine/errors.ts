export class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}
