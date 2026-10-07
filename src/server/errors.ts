export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'REQUEST_FAILED',
  ) {
    super(message);
  }
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
