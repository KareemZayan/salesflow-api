import net from 'node:net';

// A TCP proxy in front of the compose Redis that can STALL: connections stay open and commands are
// swallowed without an answer, which is what a slow or hung Redis looks like to a client (no error,
// just silence), and not what a refused connection looks like.
//
// resume() also drops every open connection. A client matches replies to commands in order, so a
// command that was swallowed and never answered would otherwise be paired with the reply to the next
// one; reconnecting is what a real recovery looks like to the client as well.
export interface StallableProxy {
  readonly port: number;
  stall(): void;
  resume(): void;
  close(): Promise<void>;
}

export async function startStallableProxy(targetPort: number): Promise<StallableProxy> {
  let stalled = false;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('data', (chunk) => {
      if (!stalled) upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (!stalled) client.write(chunk);
    });
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', drop);
    upstream.on('close', drop);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    stall: () => {
      stalled = true;
    },
    resume: () => {
      stalled = false;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
