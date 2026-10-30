import { createServer, Server } from 'node:net';
import { HealthIndicatorService } from '@nestjs/terminus';
import { TcpHealthIndicator } from './tcp-health.indicator';

describe('TcpHealthIndicator', () => {
  const indicator = new TcpHealthIndicator(new HealthIndicatorService());
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('reports up when the port accepts connections', async () => {
    const result = await indicator.check('svc', { host: '127.0.0.1', port });
    expect(result.svc.status).toBe('up');
  });

  it('reports down when nothing is listening', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const result = await indicator.check('svc', { host: '127.0.0.1', port: closedPort });
    expect(result.svc.status).toBe('down');
  });
});
