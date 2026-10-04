/**
 * WSS → TCP proxy (contract §6.3 step 1). Only to the local game port; every connection is
 * admitted by a ticket and gets its own loopback source address 127.77.<hi>.<lo>, which the
 * server reports back as the client's hostname in admin CLIENT_INFO.
 */
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Log, Registry } from './bridge';
import type { Role, TicketVerifier } from './ticket';

export interface ProxyConfig {
  gameKey: string;
  verifier: TicketVerifier;
  registry: Registry;
  gameHost: string;
  gamePort: number;
  log: Log;
  /** Max `spectator` connections per game (§6.3, env SPECTATOR_CAP); pupils and mayors are never capped. */
  spectatorCap?: number;
}

export const CLOSE_UNAUTHORIZED = 4401;

/** Hands out 127.77.x.y addresses round-robin, skipping the ones in use. */
export class LoopbackPool {
  private next = 0;
  private readonly used = new Set<string>();
  private static readonly SIZE = 256 * 254;

  take(): string | null {
    for (let i = 0; i < LoopbackPool.SIZE; i++) {
      const n = (this.next + i) % LoopbackPool.SIZE;
      const ip = `127.77.${Math.floor(n / 254)}.${(n % 254) + 1}`;
      if (!this.used.has(ip)) {
        this.used.add(ip);
        this.next = n + 1;
        return ip;
      }
    }
    return null;
  }

  free(ip: string): void {
    this.used.delete(ip);
  }
}

export function createGateway(cfg: ProxyConfig): http.Server {
  const pool = new LoopbackPool();
  const path = `/g/${cfg.gameKey}`;
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    res.writeHead(404).end();
  });
  // Emscripten's SOCKFS offers the "binary" subprotocol.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://gateway');
    if (url.pathname !== path && url.pathname !== `${path}/`) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const ticket = cfg.verifier.verify(url.searchParams.get('t'), Math.floor(Date.now() / 1000));
      if (!ticket) {
        ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      const cap = cfg.spectatorCap ?? 20;
      if (ticket.r === 'spectator' && [...cfg.registry.values()].filter((x) => x.role === 'spectator').length >= cap) {
        ws.close(1013, 'busy');
        return;
      }
      const ip = pool.take();
      if (!ip) {
        ws.close(1013, 'busy');
        return;
      }
      pipe(ws, ip, cfg, pool, ticket.s, ticket.r);
    });
  });
  return server;
}

function pipe(ws: WebSocket, ip: string, cfg: ProxyConfig, pool: LoopbackPool, studentId: string | null, role: Role): void {
  cfg.registry.set(ip, { studentId, role });
  const tcp = net.connect({ host: cfg.gameHost, port: cfg.gamePort, localAddress: ip });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    cfg.registry.delete(ip);
    pool.free(ip);
    tcp.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
  };
  // ponytail: no backpressure handling; one game client is a few KB/s. Add pause/resume on
  // ws.bufferedAmount if map downloads ever stall slow clients.
  ws.on('message', (data) => tcp.write(data as Buffer));
  tcp.on('data', (d) => ws.send(d));
  ws.on('close', close);
  ws.on('error', close);
  tcp.on('close', close);
  tcp.on('error', (e) => {
    cfg.log('warn', 'game connection failed', { ip, err: String(e) });
    close();
  });
}
