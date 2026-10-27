// An error with an HTTP status and a stable code, sent to the client as
// {"error": code, "message": message} by the app's error handler.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
