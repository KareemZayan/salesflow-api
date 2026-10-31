import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, REJECTED_PASSWORDS } from './auth.constants';

// Thin argon2 wrapper. It uses the library defaults on purpose: the seed hashes the same way, and
// the dummy hash below must cost the same as a real one for the login timing defence to work.
@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash = '';

  // Hashed once at startup with the real parameters. Login verifies against it when the email is
  // unknown, so "no such user" takes as long as "wrong password" (no user enumeration by timing).
  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(randomBytes(16).toString('hex'));
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // A malformed stored hash must read as "wrong password", not as a 500.
      return false;
    }
  }

  async verifyDummy(password: string): Promise<void> {
    await this.verify(this.dummyHash, password);
  }

  assertAcceptable(password: string): void {
    const problem = this.problemWith(password);
    if (problem)
      throw new DomainException(ERROR_CODES.WEAK_PASSWORD, problem, HttpStatus.BAD_REQUEST);
  }

  private problemWith(password: string): string | null {
    if (password.length < PASSWORD_MIN_LENGTH) {
      return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      return `Password must be at most ${PASSWORD_MAX_LENGTH} characters long`;
    }
    if (REJECTED_PASSWORDS.has(password)) return 'This password is not allowed';
    return null;
  }
}
