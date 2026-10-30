import { connect } from 'node:net';
import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

export const TCP_CHECK_TIMEOUT_MS = 2000;

interface TcpTarget {
  host: string;
  port: number;
}

// Probes reachability of a host:port. Deliberately protocol-agnostic so it works for
// Postgres and Redis before their real clients exist (Phases 4 and 12).
@Injectable()
export class TcpHealthIndicator {
  constructor(private readonly healthIndicatorService: HealthIndicatorService) {}

  async check<Key extends string>(
    key: Key,
    target: TcpTarget,
  ): Promise<HealthIndicatorResult<Key>> {
    const session = this.healthIndicatorService.check(key);
    try {
      await this.connectOnce(target);
      return session.up();
    } catch {
      // Never echo the raw socket error: it can expose internal hostnames/ports.
      return session.down('unreachable');
    }
  }

  private connectOnce({ host, port }: TcpTarget): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port, timeout: TCP_CHECK_TIMEOUT_MS });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('timeout'));
      });
      socket.once('error', reject);
    });
  }
}
