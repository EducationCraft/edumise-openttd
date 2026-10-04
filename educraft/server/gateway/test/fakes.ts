/**
 * A fake GameScript that follows contract §4.4 (last/ring/hold/pause/gap rules) and an
 * in-memory fake wallet for §3.5. Both are deliberately small; see bridge.test.ts.
 */
import type { AdminLink } from '../src/admin';
import type { Bridge } from '../src/bridge';
import type { Wallet, WalletResp } from '../src/wallet';

export class FakeGs implements AdminLink {
  bridge!: Bridge;
  sent: any[] = [];
  rcons: string[] = [];
  last = 0;
  ring: [number, number][] = [];
  game: string | null = 'c000000000001';
  co: [number, number][] = [];
  run = false;
  held = false;
  alive = true;
  ignoreHold = false;
  ignoreOps = false;
  /** seq -> number of deliveries to swallow before answering. */
  dropFirst = new Map<number, number>();
  fail = new Map<number, string>();
  /** seq -> p of a mayor op ack (what the GS actually applied). */
  ackP = new Map<number, number>();
  pokl: number | undefined = undefined;
  saveOk = true;
  fin = [{ c: 0, cash: 100, loan: 0, ml: 13924, val: 500, col: 3, i0: 1, e0: -2, i1: 3, e1: -4 }];

  private reply(m: object): void {
    queueMicrotask(() => this.bridge.onGs(JSON.stringify(m)));
  }

  state(): object {
    return { t: 'state', v: 1, game: this.game, last: this.last, ring: this.ring, co: this.co, run: this.run, paused: !this.run };
  }

  gs(msg: any): void {
    this.sent.push(msg);
    if (!this.alive) return;
    switch (msg.t) {
      case 'hello':
        this.held = false;
        return this.reply(this.state());
      case 'adopt':
        if (this.game === null) this.game = msg.game;
        return this.reply(this.state());
      case 'bind':
        this.co = this.co.filter(([c]) => c !== msg.c);
        if (msg.s !== null) this.co.push([msg.c, msg.s]);
        return this.reply({ t: 'bound', c: msg.c, s: msg.s });
      case 'ping':
        return this.reply({ t: 'pong', last: this.last });
      case 'hold':
        if (this.ignoreHold) return;
        this.held = true;
        return this.reply({ t: 'held', last: this.last });
      case 'session':
        this.held = false;
        this.run = msg.run;
        return;
      case 'report':
        if (msg.what === 'towns') return this.reply({ t: 'towns', pg: 0, pgs: 1, tw: [[0, 'Citadela']] });
        this.reply({ t: 'fin', pg: 0, pgs: 1, d: '1951-03-01', pokl: this.pokl, co: this.fin });
        return this.reply({ t: 'names', pg: 0, pgs: 1, co: [[0, 'Rychlá doprava']] });
      case 'op':
        return this.op(msg);
    }
  }

  private op(msg: any): void {
    if (this.ignoreOps) return;
    const drops = this.dropFirst.get(msg.seq) ?? 0;
    if (drops > 0) {
      this.dropFirst.set(msg.seq, drops - 1);
      return;
    }
    if (!this.run) return this.reply({ t: 'nack', seq: msg.seq, expect: this.last + 1, r: 'paused' });
    if (this.held) return this.reply({ t: 'nack', seq: msg.seq, expect: this.last + 1, r: 'held' });
    if (msg.seq <= this.last) {
      const hit = this.ring.find(([s]) => s === msg.seq);
      return this.reply({ t: 'ack', seq: msg.seq, ok: hit ? hit[1] === 1 : true });
    }
    if (msg.seq !== this.last + 1) return this.reply({ t: 'nack', seq: msg.seq, expect: this.last + 1, r: 'gap' });
    const r = msg.k === 'noop' ? undefined : this.fail.get(msg.seq);
    this.last = msg.seq;
    this.ring = [...this.ring, [msg.seq, r ? 0 : 1] as [number, number]].slice(-64);
    const p = this.ackP.get(msg.seq);
    this.reply(r ? { t: 'ack', seq: msg.seq, ok: false, r } : { t: 'ack', seq: msg.seq, ok: true, ...(p !== undefined ? { p } : {}) });
  }

  async rcon(cmd: string): Promise<string[]> {
    this.rcons.push(cmd);
    if (cmd === 'save current') return this.saveOk ? ['Saving map...', "Map successfully saved to 'current.sav'."] : ['Saving map failed.'];
    return [];
  }

  close(): void {}

  /** Messages of type t the bridge sent. */
  of(t: string): any[] {
    return this.sent.filter((m) => m.t === t);
  }
}

type Handler = (body: any, path: string) => WalletResp | undefined;

export class FakeWallet implements Wallet {
  calls: { method: string; path: string; body: any }[] = [];
  down = false;
  ops: any[] = [];
  slots = [{ slot: 1, company: 0, studentIds: ['s-1'] }, { slot: 2, company: null, studentIds: ['s-2'] }];
  hello: WalletResp = { status: 200, body: {} };
  override = new Map<string, Handler>();

  constructor() {
    this.setHello({});
  }

  setHello(extra: Record<string, unknown>, status = 200, error?: string): void {
    this.hello =
      status === 200
        ? { status, body: { data: { sessionId: 'sid-1', session: 'running', sessionMonths: 18, adopt: false, unbind: [], slots: this.slots, ...extra } } }
        : { status, body: { error } };
  }

  async call(method: string, path: string, body?: unknown): Promise<WalletResp> {
    this.calls.push({ method, path, body });
    if (this.down) throw new Error('ECONNREFUSED');
    const [p, q] = path.split('?');
    const key = `${method} ${p.replace(/\/\d+(?=\/|$)/g, '/:n')}`;
    const custom = this.override.get(key)?.(body, path);
    if (custom) return custom;
    switch (key) {
      case 'POST /hello':
        return this.hello;
      case 'GET /ops': {
        const query = new URLSearchParams(q);
        const after = Number(query.get('after'));
        const ops = this.ops.filter((o) => o.seq > after).slice(0, Number(query.get('limit')));
        return { status: 200, body: { data: { ops, session: 'running' } } };
      }
      case 'GET /slots':
        return { status: 200, body: { data: { slots: this.slots } } };
      default:
        return { status: 200, body: { data: {} } };
    }
  }

  of(method: string, prefix: string): any[] {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(prefix));
  }
}

export function deposit(seq: number, extra: Record<string, unknown> = {}): any {
  return { seq, kind: 'deposit', slot: 1, company: 0, pounds: 696, noop: false, ...extra };
}
