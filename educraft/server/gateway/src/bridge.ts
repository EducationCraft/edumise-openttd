/**
 * Bridge between the GameScript (admin port) and the wallet (contract §4.5, §4.6, §6.3).
 * Polls the wallet, delivers ops in seq order with a window of 16, reports results,
 * takes quiesced saves, runs admission and handles SIGTERM. All timing uses setTimeout /
 * setInterval + Date.now(), so tests drive it with fake timers.
 */
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminLink } from './admin';
import type { Role } from './ticket';
import type { Wallet, WalletResp } from './wallet';

export type { Role };
/** ip -> who the proxy admitted on that loopback source address (§6.3 step 1). */
export type Registry = Map<string, { studentId: string | null; role: Role }>;
export type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

export const T = {
  tick: 1_000,
  poll: 2_000,
  ping: 10_000,
  gsDead: 30_000,
  unknown: 30_000,
  walletDown: 60_000,
  refusedRetry: 60_000,
  bootRetry: 5_000,
  offlineRetry: 5_000,
  stateWait: 30_000,
  heldWait: 10_000,
  reportWait: 10_000,
  saveEvery: 5 * 60_000,
  limitStop: 10 * 60_000,
} as const;
export const WINDOW = 16;
const MAX_COMPANIES = 15;
const CLIENT_ID_SERVER = 1;
const SAVED_OK = 'Map successfully saved';
const MSG = {
  mayor: 'Jsi starosta. Ovládání: EduMise → Učitel → Starosta.',
  found: 'Založ si svou firmu: Seznam hráčů → Nová firma.',
  noTeam: 'Nejsi v žádném týmu – požádej učitele o zařazení.',
  teamChanged: 'Tvůj tým se změnil – připoj se znovu.',
};

interface WalletOp {
  seq: number;
  kind: string;
  slot?: number;
  company?: number | null;
  pounds?: number;
  houses?: number;
  value?: number | string;
  noop?: boolean;
}

interface Inflight {
  op: WalletOp;
  sentAt: number | null; // null = must be (re)sent once sending is allowed again
  unknownPosted: boolean;
}

interface Slot {
  company: number | null;
  studentIds: string[];
}

interface Client {
  ip: string;
  studentId: string | null;
  role: Role;
  admit: 'spectator' | 'new' | 'founding' | number | null;
  slot?: number;
}

type Phase = 'boot' | 'refused' | 'running' | 'offline' | 'dead';

interface Waiter {
  pred(m: any): boolean;
  resolve(m: any): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

interface FinBatch {
  date: string;
  pgs: number;
  pokl?: number;
  pages: Map<number, any[]>;
  namesPgs: number | null;
  names: Map<number, [number, string][]>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Bridge {
  phase: Phase = 'boot';
  sid: string | null = null;
  months = 18;
  cursor = 0;
  readonly inflight = new Map<number, Inflight>();
  readonly slots = new Map<number, Slot>();
  readonly clients = new Map<number, Client>();
  readonly companyNames = new Map<number, string>();
  gsDead = false;
  saving = false;
  stopping = false;
  sendBlocked = false;
  limited = false;
  /** Last `slotsRev` seen in GET /ops (D20); a change refreshes the slot map and demotes moved pupils. */
  slotsRev: number | null = null;

  private admin: AdminLink | null = null;
  private waiters: Waiter[] = [];
  private results: { seq: number; body: object; nextAt: number; delay: number }[] = [];
  private resultsBusy = false;
  private pollBusy = false;
  private booting: Promise<void> | null = null;
  private retryAt = 0;
  private lastPollAt = 0;
  private lastPingAt = 0;
  private lastPongAt = 0;
  private lastSaveAt = 0;
  private limitAt: number | null = null;
  private limitStopSent = false;
  private walletFailSince: number | null = null;
  private lastResumeAt = 0;
  private fin: FinBatch | null = null;
  private towns: { pgs: number; pages: Map<number, [number, string][]> } | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly wallet: Wallet,
    private readonly registry: Registry,
    private readonly dataDir: string,
    private readonly gameKey: string,
    private readonly log: Log,
  ) {}

  start(): void {
    this.interval ??= setInterval(() => this.bg(this.tick(), 'tick'), T.tick);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** A fresh admin connection: re-run the boot hello (§4.5 step 1). */
  attach(admin: AdminLink): Promise<void> {
    this.admin = admin;
    this.phase = 'boot';
    return this.boot();
  }

  /** The admin connection is gone: wait for a reconnect. */
  detach(): void {
    this.admin = null;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error('admin connection lost'));
    }
    if (this.phase !== 'dead') this.phase = 'boot';
    this.retryAt = Number.MAX_SAFE_INTEGER; // only attach() boots again
  }

  // ---------------------------------------------------------------- helpers

  /** Background work: an unhandled rejection would kill the gateway and the task with it. */
  private bg(p: Promise<unknown>, what: string): void {
    p.catch((e) => this.log('error', `${what} failed`, { err: String(e) }));
  }

  private gs(msg: object): void {
    this.admin?.gs(msg);
  }

  private rcon(cmd: string): Promise<string[]> {
    if (!this.admin) return Promise.reject(new Error('no admin connection'));
    return this.admin.rcon(cmd);
  }

  private waitGs(pred: (m: any) => boolean, ms: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        pred,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new Error('timeout'));
        }, ms),
      };
      this.waiters.push(w);
    });
  }

  /** Wallet call with the §4.5 step 11 outage bookkeeping. Throws on network errors. */
  private async wcall(method: string, path: string, body?: unknown): Promise<WalletResp> {
    let r: WalletResp;
    try {
      r = await this.wallet.call(method, path, body);
    } catch (e) {
      this.walletFailSince ??= Date.now();
      throw e;
    }
    if (r.status >= 500 || r.status === 429) this.walletFailSince ??= Date.now();
    else this.walletFailSince = null;
    return r;
  }

  private setSlots(list: { slot: number; company: number | null; studentIds: string[] }[] | undefined): void {
    if (!list) return;
    this.slots.clear();
    for (const s of list) this.slots.set(s.slot, { company: s.company ?? null, studentIds: s.studentIds ?? [] });
  }

  /** Returns false when the map could not be refreshed (the old one stays). */
  private async refreshSlots(): Promise<boolean> {
    try {
      const r = await this.wcall('GET', '/slots');
      const list = r.body?.data?.slots;
      if (r.status === 200 && list) {
        this.setSlots(list);
        return true;
      }
      this.log('warn', 'GET /slots failed', { status: r.status });
    } catch (e) {
      this.log('warn', 'GET /slots failed', { err: String(e) });
    }
    return false;
  }

  private slotOf(studentId: string | null): number | undefined {
    if (!studentId) return undefined;
    for (const [no, s] of this.slots) if (s.studentIds.includes(studentId)) return no;
    return undefined;
  }

  private sendSession(): void {
    this.lastResumeAt = Date.now();
    this.gs({ t: 'session', run: true, sid: this.sid, months: this.months });
    this.sendBlocked = false;
    this.resendUnsent();
  }

  // ---------------------------------------------------------------- boot (§4.5 steps 1–4)

  boot(): Promise<void> {
    this.booting ??= this.doBoot().finally(() => {
      this.booting = null;
    });
    return this.booting;
  }

  private async doBoot(): Promise<void> {
    if (!this.admin || this.gsDead) return;
    this.phase = 'boot';
    try {
      this.gs({ t: 'hello', v: 1 });
      const st = await this.waitGs((m) => m.t === 'state', T.stateWait);
      const r = await this.wcall('POST', '/hello', {
        gsLastSeq: st.last,
        ring: st.ring ?? [],
        gsGame: st.game ?? null,
        bindings: st.co ?? [],
      });
      if (r.status === 409 && ['game_mismatch', 'rollback_refused'].includes(r.body?.error)) {
        // §4.5 step 2: stay paused, a human must act (§6.5).
        this.phase = 'refused';
        this.retryAt = Date.now() + T.refusedRetry;
        this.log('error', 'wallet refused hello; game stays paused', { error: r.body.error, gsLastSeq: st.last });
        return;
      }
      if (r.status !== 200) throw new Error(`POST /hello HTTP ${r.status}`);
      const d = r.body.data;
      this.sid = d.sessionId;
      this.months = d.sessionMonths ?? 18;
      this.setSlots(d.slots);
      this.cursor = st.last;
      this.inflight.clear();
      this.limited = false;
      this.limitAt = null;

      for (const c of d.unbind ?? []) {
        this.gs({ t: 'bind', c, s: null });
        await this.waitGs((m) => m.t === 'bound' && m.c === c, T.heldWait).catch(() => undefined);
      }
      if (d.adopt) {
        // §4.5 step 3: anchor the map to this game before any company exists.
        this.gs({ t: 'adopt', game: this.gameKey });
        await this.waitGs((m) => m.t === 'state' && m.game === this.gameKey, T.stateWait);
        await this.save({ resume: false });
      }
      this.phase = 'running';
      this.lastPongAt = this.lastPingAt = this.lastSaveAt = Date.now();
      this.sendSession();
      await this.reportTowns().catch((e) => this.log('warn', 'towns report failed', { err: String(e) }));
      await this.reportFinance(false).catch((e) => this.log('warn', 'finance report failed', { err: String(e) }));
    } catch (e) {
      this.log('warn', 'boot hello failed, retrying', { err: String(e) });
      this.phase = 'boot';
      this.retryAt = Date.now() + T.bootRetry;
    }
  }

  // ---------------------------------------------------------------- periodic work

  async tick(): Promise<void> {
    const now = Date.now();
    if (this.stopping) return;
    if ((this.phase === 'refused' || this.phase === 'boot') && this.admin && now >= this.retryAt && !this.booting) {
      void this.boot();
      return;
    }
    if (this.phase === 'offline' && now >= this.retryAt) {
      this.retryAt = now + T.offlineRetry;
      try {
        const r = await this.wcall('GET', '/slots');
        if (r.status === 200) void this.boot();
      } catch {
        /* still offline */
      }
      return;
    }
    if (this.phase !== 'running') return;

    if (now - this.lastPingAt >= T.ping) {
      this.lastPingAt = now;
      this.gs({ t: 'ping' });
    }
    if (now - this.lastPongAt > T.gsDead) {
      await this.onGsDead();
      return;
    }
    if (this.walletFailSince !== null && now - this.walletFailSince > T.walletDown) {
      // §4.5 step 11: pause the game until the wallet answers again.
      this.log('error', 'wallet unreachable for 60 s, pausing the session');
      this.gs({ t: 'session', run: false });
      this.phase = 'offline';
      this.sendBlocked = true;
      this.retryAt = now;
      return;
    }
    if (this.sendBlocked && !this.saving && !this.limited && now - this.lastResumeAt >= T.ping) {
      // An op was nacked paused/held outside a save: the GS watchdog paused the game (§4.4).
      this.sendSession();
    }
    this.checkUnknown(now);
    void this.flushResults();
    if (now - this.lastPollAt >= T.poll) {
      this.lastPollAt = now;
      await this.poll();
    }
    if (!this.saving && !this.limited && now - this.lastSaveAt >= T.saveEvery) {
      this.bg(this.save({ resume: true }), 'save');
    }
    if (this.limitAt !== null && !this.limitStopSent && now - this.limitAt >= T.limitStop) {
      this.limitStopSent = true;
      await this.stopSession('limit');
    }
  }

  private canSend(): boolean {
    return this.phase === 'running' && !this.saving && !this.sendBlocked && !this.gsDead && !this.stopping;
  }

  // ---------------------------------------------------------------- ops (§4.5 step 5)

  private opMsg(op: WalletOp): object {
    if (op.noop) return { t: 'op', seq: op.seq, k: 'noop' };
    const m: Record<string, unknown> = { t: 'op', seq: op.seq, k: op.kind };
    // tax/news/expand carry no slot and no company (§4.3).
    if (op.slot != null) Object.assign(m, { s: op.slot, c: op.company ?? null });
    const p = op.pounds ?? op.houses;
    if (p != null) m.p = p;
    if (op.value != null) m.v = op.value;
    return m;
  }

  private sendOp(f: Inflight): void {
    this.gs(this.opMsg(f.op));
    f.sentAt = Date.now();
  }

  async poll(): Promise<void> {
    if (!this.canSend() || this.pollBusy) return;
    this.pollBusy = true;
    try {
      const r = await this.wcall('GET', `/ops?after=${this.cursor}&limit=${WINDOW}`);
      if (r.status !== 200) return;
      const rev = r.body.data.slotsRev;
      // The rev counts as seen only after a successful refresh, so a failed GET /slots retries.
      if (typeof rev === 'number' && rev !== this.slotsRev && (await this.onTeamsChanged())) this.slotsRev = rev;
      for (const op of (r.body.data.ops ?? []) as WalletOp[]) {
        if (!this.canSend()) break;
        if (op.seq <= this.cursor || this.inflight.has(op.seq)) continue; // acked while this poll ran
        if (this.inflight.size >= WINDOW) break;
        const f: Inflight = { op, sentAt: null, unknownPosted: false };
        this.inflight.set(op.seq, f);
        this.sendOp(f);
      }
    } catch (e) {
      this.log('warn', 'GET /ops failed', { err: String(e) });
    } finally {
      this.pollBusy = false;
    }
  }

  private sorted(): [number, Inflight][] {
    return [...this.inflight.entries()].sort((a, b) => a[0] - b[0]);
  }

  private resendUnsent(): void {
    if (!this.canSend()) return;
    for (const [, f] of this.sorted()) if (f.sentAt === null) this.sendOp(f);
  }

  /** 30 s without an ack: report `unknown` once, and re-send the same op (§4.5 step 5). */
  private checkUnknown(now: number): void {
    if (!this.canSend()) return;
    for (const [seq, f] of this.sorted()) {
      if (f.sentAt === null || now - f.sentAt < T.unknown) continue;
      if (!f.unknownPosted && !f.op.noop) {
        f.unknownPosted = true;
        this.queueResult(seq, { status: 'unknown' });
      }
      this.sendOp(f);
    }
  }

  private onAck(m: { seq: number; ok: boolean; r?: string; p?: number }): void {
    const f = this.inflight.get(m.seq);
    if (!f) return; // a re-ack for something already resolved
    this.inflight.delete(m.seq);
    if (m.seq > this.cursor) this.cursor = m.seq;
    // A failed op travels as noop and is already terminal in the wallet: nothing to report.
    if (f.op.noop) return;
    // Mayor ops ack what was actually applied (pounds | houses, §4.3); a ring re-ack has no p.
    const applied = typeof m.p === 'number' ? { status: 'applied', p: m.p } : { status: 'applied' };
    // A ring re-ack has no r: omit reason so the wallet records its default 'failed_in_game'.
    this.queueResult(m.seq, m.ok ? applied : m.r ? { status: 'failed', reason: m.r } : { status: 'failed' });
  }

  private onNack(m: { seq: number; expect: number; r: string }): void {
    if (m.r === 'gap') {
      const tail = this.sorted().filter(([s]) => s >= m.expect);
      if (tail.length && tail[0][0] === m.expect) {
        for (const [, f] of tail) this.sendOp(f);
      } else {
        // The GS wants a seq we do not hold: drop the tail and let the next poll fetch from there.
        for (const [s] of tail) this.inflight.delete(s);
        this.cursor = Math.min(this.cursor, m.expect - 1);
      }
      return;
    }
    if (m.r === 'game_mismatch') {
      this.log('error', 'GS reports game_mismatch, re-running hello');
      void this.boot();
      return;
    }
    // paused / held: not consumed; re-send once the session runs again.
    const f = this.inflight.get(m.seq);
    if (f) f.sentAt = null;
    this.sendBlocked = true; // tick() resumes the session (the GS watchdog may have paused it)
  }

  private queueResult(seq: number, body: object): void {
    this.results.push({ seq, body, nextAt: 0, delay: 1_000 });
    void this.flushResults();
  }

  /** FIFO, so `unknown` always reaches the wallet before the final result of the same op. */
  private async flushResults(): Promise<void> {
    if (this.resultsBusy) return;
    this.resultsBusy = true;
    try {
      while (this.results.length && Date.now() >= this.results[0].nextAt) {
        const head = this.results[0];
        let r: WalletResp | null = null;
        try {
          r = await this.wcall('POST', `/ops/${head.seq}/result`, head.body);
        } catch (e) {
          this.log('warn', 'op result not delivered', { seq: head.seq, err: String(e) });
        }
        if (r && r.status < 500 && r.status !== 429) {
          if (r.status === 409) this.log('error', 'op result refused (invalid_state), treated as acked', { seq: head.seq, body: head.body });
          else if (r.status !== 200) this.log('error', 'op result rejected', { seq: head.seq, status: r.status });
          this.results.shift();
          continue;
        }
        head.nextAt = Date.now() + head.delay;
        head.delay = Math.min(head.delay * 2, 30_000);
        break;
      }
    } finally {
      this.resultsBusy = false;
    }
  }

  private async drainResults(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (this.results.length && Date.now() < end) {
      for (const r of this.results) r.nextAt = 0;
      await this.flushResults();
      if (this.results.length) await sleep(1_000);
    }
  }

  // ---------------------------------------------------------------- GS messages

  onGs(json: string): void {
    let m: any;
    try {
      m = JSON.parse(json);
    } catch {
      this.log('warn', 'GS sent invalid JSON');
      return;
    }
    for (const w of [...this.waiters]) {
      if (w.pred(m)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(m);
      }
    }
    switch (m.t) {
      case 'state':
      case 'held':
      case 'bound':
      case '$fin':
      case '$towns':
        return;
      case 'pong':
        this.lastPongAt = Date.now();
        return;
      case 'ack':
        return this.onAck(m);
      case 'nack':
        return this.onNack(m);
      case 'fin':
      case 'names':
        return this.onFin(m);
      case 'towns':
        return this.onTowns(m);
      case 'need':
        void this.onNeed(m);
        return;
      case 'company':
        void this.onCompanyEvent(m);
        return;
      case 'loaninit':
        if (!m.ok) this.log('error', 'loan-init failed, needs a human', { company: m.c, cash: m.cash, loan: m.loan });
        return;
      case 'limit':
        this.limited = true;
        this.sendBlocked = true;
        this.limitAt = Date.now();
        this.bg(this.save({ resume: false }), 'save');
        return;
      default:
        this.log('warn', 'unknown GS message', { t: m.t });
    }
  }

  private async onNeed(m: { c: number; cash: number; loan: number; ml: number; p?: number }): Promise<void> {
    // ponytail: the GS computes p with its buffer B (§4.4); the fallback uses the minimum B.
    const pounds = m.p ?? m.loan - m.ml - m.cash + 1000;
    try {
      const r = await this.wcall('POST', '/rescues', { company: m.c, pounds });
      if (r.status !== 200) this.log('error', 'rescue refused', { company: m.c, status: r.status, error: r.body?.error });
    } catch (e) {
      this.log('error', 'rescue request failed; the GS asks again next month', { company: m.c, err: String(e) });
    }
  }

  private async onCompanyEvent(m: { c: number; ev: string }): Promise<void> {
    if (m.ev !== 'removed' && m.ev !== 'merged') {
      if (m.ev === 'bankrupt') this.log('warn', 'company in trouble', { company: m.c });
      return;
    }
    for (const s of this.slots.values()) if (s.company === m.c) s.company = null;
    this.companyNames.delete(m.c);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await this.wcall('POST', `/companies/${m.c}/gone`, { reason: m.ev });
        if (r.status < 500) return;
      } catch {
        /* retry */
      }
      await sleep(2_000 * (attempt + 1));
    }
    this.log('error', 'company gone not reported; the next hello reconciles it', { company: m.c });
  }

  // ---------------------------------------------------------------- reports

  private onFin(m: any): void {
    if (m.t === 'fin') {
      if (m.pg === 0 || !this.fin) this.fin = { date: m.d, pgs: m.pgs, pages: new Map(), namesPgs: null, names: new Map() };
      if (typeof m.pokl === 'number') this.fin.pokl = m.pokl;
      this.fin.pages.set(m.pg, m.co ?? []);
    } else {
      if (!this.fin) return;
      this.fin.namesPgs = m.pgs;
      this.fin.names.set(m.pg, m.co ?? []);
    }
    const b = this.fin;
    if (b.pages.size < b.pgs || b.namesPgs === null || b.names.size < b.namesPgs) return;
    this.fin = null;
    const names = new Map<number, string>();
    for (const page of b.names.values()) for (const [c, n] of page) names.set(c, n);
    const companies = [...b.pages.values()].flat().map((c: any) => ({
      company: c.c,
      cashPounds: c.cash,
      loanPounds: c.loan,
      maxLoanPounds: c.ml,
      valuePounds: c.val,
      colour: c.col,
      name: names.get(c.c) ?? this.companyNames.get(c.c) ?? null, // null keeps the wallet's known name
      inc0: c.i0,
      exp0: c.e0,
      inc1: c.i1,
      exp1: c.e1,
    }));
    const report = { t: '$fin', gameDate: b.date, companies, treasuryPounds: b.pokl };
    // An explicit report() waits for it; a monthly one is forwarded as a live update.
    if (this.waiters.some((w) => w.pred(report))) {
      this.onGs(JSON.stringify(report));
    } else {
      void this.wcall('PUT', '/finance', { gameDate: b.date, final: false, treasuryPounds: b.pokl, companies }).catch((e) =>
        this.log('warn', 'monthly finance not delivered', { err: String(e) }),
      );
    }
  }

  private onTowns(m: any): void {
    if (m.pg === 0 || !this.towns) this.towns = { pgs: m.pgs, pages: new Map() };
    this.towns.pages.set(m.pg, m.tw ?? []);
    if (this.towns.pages.size < this.towns.pgs) return;
    const towns = [...this.towns.pages.values()].flat().map(([id, name]) => ({ id, name }));
    this.towns = null;
    void this.wcall('PUT', '/towns', { towns }).catch((e) => this.log('warn', 'towns not delivered', { err: String(e) }));
    this.onGs(JSON.stringify({ t: '$towns' }));
  }

  private async reportTowns(): Promise<void> {
    const done = this.waitGs((m) => m.t === '$towns', T.reportWait);
    this.gs({ t: 'report', what: 'towns' });
    await done;
  }

  /** `attempts` > 1 retries the PUT on network errors, 5xx and 429 (the final report, §3.6). */
  private async reportFinance(final: boolean, attempts = 1): Promise<void> {
    const got = this.waitGs((m) => m.t === '$fin', T.reportWait);
    this.gs({ t: 'report', what: 'fin' });
    const rep = await got;
    const body = { gameDate: rep.gameDate, final, treasuryPounds: rep.treasuryPounds, companies: rep.companies };
    let err = '';
    for (let i = 1; i <= attempts; i++) {
      if (i > 1) await sleep(2_000 * (i - 1));
      let r: WalletResp;
      try {
        r = await this.wcall('PUT', '/finance', body);
      } catch (e) {
        err = String(e);
        continue;
      }
      if (r.status === 200) return;
      err = `PUT /finance HTTP ${r.status}`;
      if (r.status < 500 && r.status !== 429) break;
    }
    throw new Error(err);
  }

  // ---------------------------------------------------------------- save (§4.5 step 8)

  /** Quiesced save. Returns the saved `last`, or null when no save happened. */
  async save(opts: { resume: boolean }): Promise<number | null> {
    if (this.gsDead || this.saving || this.stopping || !this.admin) return null;
    this.saving = true;
    this.lastSaveAt = Date.now(); // a failed attempt retries at the next trigger, not every tick
    let last: number | null = null;
    try {
      const held = this.waitGs((m) => m.t === 'held', T.heldWait);
      this.gs({ t: 'hold' });
      const h = await held.catch(() => null);
      if (!h) {
        this.log('warn', 'no held from the GS, save skipped');
        return null;
      }
      if (!(await this.rconSave())) return null;
      writeFileSync(join(this.dataDir, 'save', 'current.seq'), String(h.last));
      last = h.last;
      await this.postSaved(h.last, false);
      return last;
    } finally {
      this.saving = false;
      // End the hold. After `limit` (or before the session started) the game must stay
      // paused, so `hello` ends the hold instead of session{run:true}.
      if (!this.stopping && !this.gsDead) {
        if (opts.resume && !this.limited && this.phase === 'running') this.sendSession();
        else this.gs({ t: 'hello', v: 1 });
      }
    }
  }

  private async rconSave(): Promise<boolean> {
    try {
      const lines = await this.rcon('save current');
      if (lines.some((l) => l.includes(SAVED_OK))) return true;
      this.log('error', 'rcon save failed', { lines });
    } catch (e) {
      this.log('error', 'rcon save failed', { err: String(e) });
    }
    return false;
  }

  private async postSaved(lastSeq: number, final: boolean, attempts = 5): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await this.wcall('POST', '/saved', { lastSeq, final });
        if (r.status === 200) return true;
        if (r.status < 500 && r.status !== 429) {
          this.log('error', 'POST /saved rejected', { status: r.status, error: r.body?.error });
          return false;
        }
      } catch {
        /* retry */
      }
      await sleep(2_000);
    }
    this.log('error', 'POST /saved not delivered', { lastSeq, final });
    return false;
  }

  private async stopSession(reason: 'limit' | 'gs_dead' | 'wallet_unreachable'): Promise<void> {
    for (let i = 0; i < 5; i++) {
      try {
        const r = await this.wcall('POST', '/session', { action: 'stop', reason });
        if (r.status < 500) return;
      } catch {
        /* retry */
      }
      await sleep(5_000);
    }
    this.log('error', 'session stop not delivered', { reason });
  }

  // ---------------------------------------------------------------- GS dead (§4.5 step 10)

  private async onGsDead(): Promise<void> {
    if (this.gsDead) return;
    this.gsDead = true;
    this.phase = 'dead';
    this.log('error', 'GameScript silent for 30 s: pausing, no further saves');
    await this.rcon('pause').catch((e) => this.log('error', 'rcon pause failed', { err: String(e) }));
    await this.stopSession('gs_dead');
  }

  // ---------------------------------------------------------------- SIGTERM (§4.5 step 12)

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.stop();
    if (!this.sid || this.gsDead || this.phase === 'refused' || !this.admin) return;
    for (let i = 0; this.saving && i < 150; i++) await sleep(100);
    this.gs({ t: 'session', run: false });
    const held = this.waitGs((m) => m.t === 'held', T.heldWait);
    this.gs({ t: 'hold' });
    const h = await held.catch(() => null);
    if (!h) {
      this.log('warn', 'no held at shutdown: session not final, settle needs another session');
      return;
    }
    // Without finalFinance a final session would sell every company at 0 (§3.6): then the
    // save is still taken, but reported non-final so settle asks for another session.
    let final = true;
    try {
      await this.reportFinance(true, 5);
    } catch (e) {
      final = false;
      this.log('error', 'final finance not delivered: session not final, settle needs another session', { err: String(e) });
    }
    if (!(await this.rconSave())) return;
    const saveDir = join(this.dataDir, 'save');
    writeFileSync(join(saveDir, 'current.seq'), String(h.last));
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(join(saveDir, 'current.sav'), join(this.dataDir, 'snapshots', `${iso}.sav`));
    copyFileSync(join(saveDir, 'current.seq'), join(this.dataDir, 'snapshots', `${iso}.seq`));
    // Results first: /saved commits only ops the wallet already knows as applied (§4.6).
    await this.drainResults(30_000);
    await this.postSaved(h.last, final, 20);
  }

  // ---------------------------------------------------------------- admission (§6.3)

  /**
   * CLIENT_INFO arrives on join and for every client after an admin (re)connect (the
   * AdminClient polls all). A client already known is only re-checked: a `new` pupil who
   * founded a company while the link was down is bound now.
   */
  onClientInfo(id: number, ip: string, playas = MAX_COMPANIES): void {
    if (id === CLIENT_ID_SERVER) return;
    const known = this.clients.get(id);
    if (known?.ip === ip) return this.onClientUpdate(id, playas);
    const who = this.registry.get(ip);
    if (!who) {
      this.log('warn', 'client from an unknown address, kicking', { id, ip });
      void this.rcon(`kick ${id}`).catch(() => undefined);
      return;
    }
    this.clients.set(id, { ip, studentId: who.studentId, role: who.role, admit: null });
    this.bg(this.admit(id), 'admission');
  }

  onClientUpdate(id: number, playas: number): void {
    const c = this.clients.get(id);
    if (!c || c.admit !== 'new' || playas >= MAX_COMPANIES) return;
    this.bg(this.founded(id, c, playas), 'founding');
  }

  onClientQuit(id: number): void {
    this.clients.delete(id);
  }

  onCompanyInfo(company: number, name: string): void {
    this.companyNames.set(company, name);
  }

  private say(id: number, text: string): Promise<unknown> {
    return this.rcon(`say_client ${id} "${text}"`).catch(() => undefined);
  }

  async admit(id: number): Promise<void> {
    const c = this.clients.get(id);
    if (!c) return;
    try {
      if (c.role !== 'pupil') {
        // A mayor has no company: spectator + chat; powers live in the EduMise web (D21).
        c.admit = 'spectator';
        await this.rcon(`edu_admit ${id} spectator`);
        if (c.role === 'mayor') await this.say(id, MSG.mayor);
        return;
      }
      // Teams change mid-game (D20): always decide from a fresh slot map.
      await this.refreshSlots();
      const slot = this.slotOf(c.studentId);
      if (slot === undefined) {
        c.admit = 'spectator';
        await this.rcon(`edu_admit ${id} spectator`);
        await this.say(id, MSG.noTeam);
        return;
      }
      c.slot = slot;
      const company = this.slots.get(slot)!.company;
      if (company !== null) {
        c.admit = company;
        await this.rcon(`edu_admit ${id} ${company + 1}`);
      } else {
        c.admit = 'new';
        await this.rcon(`edu_admit ${id} new`);
        await this.say(id, MSG.found);
      }
    } catch (e) {
      this.log('error', 'admission failed', { id, err: String(e) });
    }
  }

  /**
   * §6.3 team change: a pupil whose admitted company (or `new` slot) is no longer their
   * team's goes back to spectator and must reconnect; the next admission uses the new map.
   */
  private async onTeamsChanged(): Promise<boolean> {
    if (!(await this.refreshSlots())) return false;
    for (const [id, c] of this.clients) {
      if (c.role !== 'pupil' || c.admit === null || c.admit === 'founding') continue;
      const slot = this.slotOf(c.studentId);
      if (c.admit === 'spectator') {
        // Had no team (MSG.noTeam) and now has one: tell them to reconnect, once.
        if (c.slot === undefined && slot !== undefined) {
          c.slot = slot;
          await this.say(id, MSG.teamChanged);
        }
        continue;
      }
      const ok = c.admit === 'new' ? slot === c.slot : slot !== undefined && this.slots.get(slot)!.company === c.admit;
      if (ok) continue;
      c.admit = 'spectator';
      await this.rcon(`edu_admit ${id} spectator`).catch(() => undefined);
      await this.say(id, MSG.teamChanged);
    }
    return true;
  }

  /** §6.3 step 3: a pupil admitted as `new` founded company `company`. */
  private async founded(id: number, c: Client, company: number, retried = false): Promise<void> {
    c.admit = 'founding';
    const slot = c.slot!;
    let r: WalletResp | null = null;
    for (let i = 0; i < 3 && !r; i++) {
      try {
        r = await this.wcall('POST', '/companies', { slot, company, companyName: this.companyNames.get(company) ?? null, studentId: c.studentId });
        if (r.status >= 500 || r.status === 429) r = null;
      } catch {
        r = null;
      }
      if (!r) await sleep(2_000);
    }
    const err = r?.body?.error;
    const bound = err === 'already_bound' ? (r!.body.company ?? r!.body.data?.company) : undefined;
    // already_bound to this very company: a retried POST whose first attempt committed.
    if (r?.status === 200 || (r?.status === 409 && bound === company)) {
      this.slots.get(slot)!.company = company;
      await this.refreshSlots();
      this.gs({ t: 'bind', c: company, s: slot });
      await this.waitGs((m) => m.t === 'bound' && m.c === company, T.heldWait).catch(() => undefined);
      await this.save({ resume: true });
      c.admit = company;
      await this.rcon(`edu_admit ${id} ${company + 1}`).catch(() => undefined);
      return;
    }
    await this.refreshSlots();
    if (r?.status === 409 && typeof bound === 'number') {
      c.admit = bound;
      await this.rcon(`edu_admit ${id} ${bound + 1}`).catch(() => undefined);
      await this.rcon(`reset_company ${company + 1}`).catch(() => undefined);
      return;
    }
    if (r?.status === 409 && err === 'not_member') {
      // The team changed between admission and founding (D20): the company is not theirs.
      c.admit = 'spectator';
      await this.rcon(`edu_admit ${id} spectator`).catch(() => undefined);
      await this.rcon(`reset_company ${company + 1}`).catch(() => undefined);
      await this.say(id, MSG.teamChanged);
      return;
    }
    if (r?.status === 409 && err === 'company_taken' && !retried) {
      await this.boot();
      return this.founded(id, c, company, true);
    }
    this.log('error', 'company could not be bound to the slot', { id, slot, company, status: r?.status, error: err });
    c.admit = 'spectator';
    await this.rcon(`edu_admit ${id} spectator`).catch(() => undefined);
    await this.rcon(`reset_company ${company + 1}`).catch(() => undefined);
  }
}
