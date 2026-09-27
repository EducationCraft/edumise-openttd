/**
 * Wallet client for /wallet/game/{gameKey}/* (contract §3.5): M2M client_credentials
 * token (cached until 60 s before expiry, like kokpit-backend/lib/identity.ts) plus X-Game-Token.
 */
export interface WalletResp {
  status: number;
  /** Parsed JSON body ({data} on 200, {error, ...} otherwise). */
  body: any;
}

/** Throws on network errors; HTTP errors come back as a status. */
export interface Wallet {
  call(method: string, path: string, body?: unknown): Promise<WalletResp>;
}

export interface HttpWalletConfig {
  base: string; // https://api.educraft.cz/wallet
  gameKey: string;
  clientId: string;
  clientSecret: string;
  gameToken: string;
  tokenEndpoint: string;
  timeoutMs?: number;
}

export class HttpWallet implements Wallet {
  private token: string | null = null;
  private tokenExp = 0;

  constructor(private readonly cfg: HttpWalletConfig) {}

  private async m2m(): Promise<string> {
    if (this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    const r = await fetch(this.cfg.tokenEndpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=' + encodeURIComponent('wallet/game'),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
    });
    if (!r.ok) throw new Error(`token endpoint HTTP ${r.status}`);
    const j = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error('token endpoint returned no access_token');
    this.token = j.access_token;
    this.tokenExp = Date.now() + (j.expires_in ?? 3600) * 1000;
    return this.token;
  }

  async call(method: string, path: string, body?: unknown): Promise<WalletResp> {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${this.cfg.base}/game/${this.cfg.gameKey}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.m2m()}`,
          'X-Game-Token': this.cfg.gameToken,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
      if (r.status === 401 && attempt === 0) {
        this.token = null; // revoked or rotated: fetch a new token once
        continue;
      }
      const text = await r.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: r.status, body: parsed };
    }
  }
}
