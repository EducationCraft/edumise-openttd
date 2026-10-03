/**
 * Game tickets (contract §6.4): b64url(payload) "." b64url(HMAC-SHA256(ticketKey, b64url(payload))).
 * Single use (nonce kept until exp), bound to this game, and never older than this process:
 * a restarted gateway has lost its nonce set, so earlier tickets are refused (§6.3).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface Ticket {
  g: string;
  s: string | null;
  r: 'pupil' | 'spectator';
  iat: number;
  exp: number;
  n: string;
}

const MAX_TTL_S = 120;

export class TicketVerifier {
  private readonly used = new Map<string, number>(); // nonce -> exp

  constructor(
    private readonly key: Buffer,
    private readonly gameKey: string,
    private readonly startedAtS: number,
  ) {}

  verify(token: string | null, nowS: number): Ticket | null {
    for (const [n, exp] of this.used) if (exp <= nowS) this.used.delete(n);
    if (!token) return null;
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra !== undefined) return null;
    const want = createHmac('sha256', this.key).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    let t: Ticket;
    try {
      t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (t.g !== this.gameKey) return null;
    if (t.r !== 'pupil' && t.r !== 'spectator') return null;
    if (t.r === 'pupil' && (typeof t.s !== 'string' || !t.s)) return null;
    if (!Number.isInteger(t.iat) || !Number.isInteger(t.exp)) return null;
    if (t.exp <= nowS || t.exp - t.iat > MAX_TTL_S || t.iat < this.startedAtS) return null;
    if (typeof t.n !== 'string' || !t.n || this.used.has(t.n)) return null;
    this.used.set(t.n, t.exp);
    return { ...t, s: t.r === 'pupil' ? t.s : null };
  }
}

/** Test/dev helper; the wallet issues real tickets. */
export function signTicket(key: Buffer, t: Ticket): string {
  const body = Buffer.from(JSON.stringify(t)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
