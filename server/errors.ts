export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function publicError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error && error.name === "AbortError")
    return "Operation cancelled.";
  return "The operation could not finish safely. Stop or reset the session and try again.";
}
