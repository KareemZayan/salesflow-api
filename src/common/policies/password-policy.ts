// The one definition of "acceptable password", shared by the API (PasswordService), the seed and
// the org:create CLI. Self-contained on purpose (no imports): the seed and CLI run outside Nest
// from the runtime image, which ships this folder but not the rest of src/.
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

// Shipped in .env.example; running with it would create a known-password account.
export const PLACEHOLDER_PASSWORD = 'change_me_strong_password';
export const REJECTED_PASSWORDS: ReadonlySet<string> = new Set([PLACEHOLDER_PASSWORD]);

export function passwordLengthProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters long`;
  }
  return null;
}

export function isRejectedPassword(password: string): boolean {
  return REJECTED_PASSWORDS.has(password);
}

// null when acceptable, otherwise a message safe to show to the caller.
export function findPasswordProblem(password: string): string | null {
  const length = passwordLengthProblem(password);
  if (length) return length;
  return isRejectedPassword(password) ? 'This password is not allowed' : null;
}
