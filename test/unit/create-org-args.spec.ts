import {
  ORG_ADMIN_PASSWORD_ENV,
  parseCreateOrgArgs,
  UsageError,
} from '../../prisma/seed/create-org-args';

const REQUIRED = ['--name', 'Acme', '--slug', 'acme', '--admin-email', 'Boss@Acme.com'];

describe('parseCreateOrgArgs', () => {
  it('applies the documented defaults and normalizes the email', () => {
    expect(parseCreateOrgArgs(REQUIRED, {})).toEqual({
      name: 'Acme',
      slug: 'acme',
      adminEmail: 'boss@acme.com',
      adminFirstName: 'Admin',
      adminLastName: 'User',
      currency: 'USD',
      password: undefined,
    });
  });

  it('accepts the optional names and an (any-case) currency', () => {
    const args = parseCreateOrgArgs(
      [...REQUIRED, '--admin-first-name', 'Sara', '--admin-last-name', 'Ali', '--currency', 'egp'],
      {},
    );
    expect(args).toMatchObject({ adminFirstName: 'Sara', adminLastName: 'Ali', currency: 'EGP' });
  });

  it.each([
    [['--slug', 'acme', '--admin-email', 'a@b.co'], /--name is required/],
    [['--name', 'A', '--admin-email', 'a@b.co'], /slug/],
    [['--name', 'A', '--slug', 'acme'], /adminEmail/],
    [['--name', 'A', '--slug', 'Not A Slug', '--admin-email', 'a@b.co'], /slug/],
    [['--name', 'A', '--slug', 'acme', '--admin-email', 'nope'], /adminEmail/],
    [[...REQUIRED, '--currency', 'XXX1'], /currency/],
    [[...REQUIRED, '--admin-first-name', ' '], /adminFirstName/],
  ])('rejects invalid input %j', (argv, message) => {
    expect(() => parseCreateOrgArgs(argv, {})).toThrow(UsageError);
    expect(() => parseCreateOrgArgs(argv, {})).toThrow(message);
  });

  it('rejects unknown options, including a password on the command line', () => {
    expect(() => parseCreateOrgArgs([...REQUIRED, '--password', 'x'.repeat(20)], {})).toThrow(
      UsageError,
    );
  });

  it('reads the password only from the environment, with the shared policy', () => {
    const env = { [ORG_ADMIN_PASSWORD_ENV]: 'a-strong-password-1' };
    expect(parseCreateOrgArgs(REQUIRED, env).password).toBe('a-strong-password-1');

    const tooShort = { [ORG_ADMIN_PASSWORD_ENV]: 'short' };
    expect(() => parseCreateOrgArgs(REQUIRED, tooShort)).toThrow(/at least 10/);
    const placeholder = { [ORG_ADMIN_PASSWORD_ENV]: 'change_me_strong_password' };
    expect(() => parseCreateOrgArgs(REQUIRED, placeholder)).toThrow(/not allowed/);
  });

  it('never echoes the password in an error message', () => {
    const secret = 'tiny-pw'; // too short on purpose, so validation fails
    try {
      parseCreateOrgArgs(REQUIRED, { [ORG_ADMIN_PASSWORD_ENV]: secret });
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toContain(ORG_ADMIN_PASSWORD_ENV);
    }
  });
});
