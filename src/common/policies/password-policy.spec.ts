import {
  findPasswordProblem,
  isRejectedPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PLACEHOLDER_PASSWORD,
  passwordLengthProblem,
} from './password-policy';

describe('password policy', () => {
  it('accepts the length boundaries', () => {
    expect(findPasswordProblem('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(findPasswordProblem('a'.repeat(PASSWORD_MAX_LENGTH))).toBeNull();
  });

  it('rejects too short and too long passwords', () => {
    expect(findPasswordProblem('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toMatch(/at least/);
    expect(findPasswordProblem('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toMatch(/at most/);
  });

  it('rejects the shipped placeholder, but exposes the length rule separately', () => {
    expect(isRejectedPassword(PLACEHOLDER_PASSWORD)).toBe(true);
    expect(findPasswordProblem(PLACEHOLDER_PASSWORD)).toBe('This password is not allowed');
    // The seed applies only the length rule outside production.
    expect(passwordLengthProblem(PLACEHOLDER_PASSWORD)).toBeNull();
  });
});
