export class ModelError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export function safeError(error: unknown): string {
  if (error instanceof ModelError) return error.code;
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
    return error.name === 'TimeoutError' ? 'timeout' : 'cancelled';
  const status = (error as { statusCode?: number })?.statusCode;
  return status ? `http_${status}` : 'invalid_or_unavailable_response';
}
