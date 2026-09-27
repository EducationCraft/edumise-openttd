/**
 * EduMise Doprava gateway: one process per game task with the WSS proxy and the bridge
 * (contract §4.1). Env: GAME_KEY, SECRETS_PREFIX, WALLET_BASE, WALLET_CLIENT_ID; secrets
 * come from SSM only (§1.2, §6.2).
 */
import { AdminClient } from './admin';
import { Bridge, type Log, type Registry } from './bridge';
import { createGateway } from './proxy';
import { getSecret } from './ssm';
import { TicketVerifier } from './ticket';
import { HttpWallet } from './wallet';

const log: Log = (level, msg, extra) => {
  const line = JSON.stringify({ level, msg, ...extra, at: new Date().toISOString() });
  if (level === 'error') console.error(line);
  else console.log(line);
};

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function main(): Promise<void> {
  const startedAtS = Math.floor(Date.now() / 1000);
  const gameKey = env('GAME_KEY');
  if (!/^c[0-9a-f]{12}$/.test(gameKey)) throw new Error('GAME_KEY is not a game key');
  const prefix = env('SECRETS_PREFIX');
  const gameHost = env('OPENTTD_HOST', '127.0.0.1');
  const [clientSecret, adminKey, gameToken, ticketKey] = await Promise.all([
    getSecret(`${prefix}/wallet-client-secret`),
    getSecret(`${prefix}/admin-private-key`),
    getSecret(`${prefix}/games/${gameKey}/game-token`),
    getSecret(`${prefix}/games/${gameKey}/ticket-key`),
  ]);

  const wallet = new HttpWallet({
    base: env('WALLET_BASE'),
    gameKey,
    clientId: env('WALLET_CLIENT_ID'),
    clientSecret,
    gameToken,
    tokenEndpoint: env('TOKEN_ENDPOINT', 'https://edumetr-admin.auth.eu-central-1.amazoncognito.com/oauth2/token'),
  });
  const registry: Registry = new Map();
  const bridge = new Bridge(wallet, registry, env('DATA_DIR', '/data'), gameKey, log);

  createGateway({
    gameKey,
    // The ticket key is stored hex-encoded (HMAC output, §6.4).
    verifier: new TicketVerifier(Buffer.from(ticketKey, 'hex'), gameKey, startedAtS),
    registry,
    gameHost,
    gamePort: Number(env('OPENTTD_PORT', '3979')),
    log,
  }).listen(Number(env('PORT', '8080')));

  const secret = Uint8Array.from(Buffer.from(adminKey, 'hex'));
  const adminPort = Number(env('ADMIN_PORT', '3977'));
  const connect = async (): Promise<void> => {
    for (;;) {
      let attached = false;
      const admin = new AdminClient(secret, {
        gs: (json) => bridge.onGs(json),
        clientInfo: (id, host) => bridge.onClientInfo(id, host),
        clientUpdate: (id, playas) => bridge.onClientUpdate(id, playas),
        clientQuit: (id) => bridge.onClientQuit(id),
        companyNew: () => undefined, // the CLIENT_UPDATE that follows carries the company
        companyInfo: (c, name) => bridge.onCompanyInfo(c, name),
        companyRemove: () => undefined, // the GS reports removals (company ev:removed)
        closed: (err) => {
          if (stopping || !attached) return; // a failed connect is retried by the loop below
          log('warn', 'admin connection closed, reconnecting', { err: String(err) });
          bridge.detach();
          setTimeout(() => void connect(), 5_000);
        },
      });
      try {
        await admin.connect(gameHost, adminPort);
        log('info', 'admin connected');
        attached = true;
        await bridge.attach(admin);
        return;
      } catch (e) {
        log('warn', 'admin connect failed, retrying', { err: String(e) });
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  };

  let stopping = false;
  process.on('SIGTERM', () => {
    if (stopping) return;
    stopping = true;
    log('info', 'SIGTERM: final save');
    // ECS kills the container at stopTimeout (120 s); leave before that, whatever is pending.
    setTimeout(() => process.exit(0), 110_000).unref();
    bridge
      .shutdown()
      .catch((e) => log('error', 'shutdown failed', { err: String(e) }))
      .finally(() => process.exit(0));
  });

  bridge.start();
  await connect();
}

main().catch((e) => {
  log('error', 'gateway failed to start', { err: String(e) });
  process.exit(1);
});
