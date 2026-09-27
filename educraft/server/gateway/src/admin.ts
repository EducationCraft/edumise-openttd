/**
 * Admin-port client: AdminJoinSecure with the authorized-key method (contract §4.2),
 * then encrypted traffic, rcon (serialized, one in flight) and GameScript JSON.
 */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { AeadStream, aeadLock, deriveClientKeys, publicKey } from './aead';
import { Admin, AUTH_AUTHORIZED_KEY, FREQ_AUTOMATIC, FrameDecoder, Reader, Server, UpdateType, Writer, encodeFrame } from './packet';

export interface AdminEvents {
  gs(json: string): void;
  clientInfo(id: number, host: string, playas: number): void;
  clientUpdate(id: number, playas: number): void;
  clientQuit(id: number): void;
  companyNew(c: number): void;
  companyInfo(c: number, name: string): void;
  companyRemove(c: number, reason: number): void;
  closed(err?: Error): void;
}

/** What the bridge needs from the admin link; the fake in tests implements this. */
export interface AdminLink {
  gs(msg: object): void;
  rcon(cmd: string): Promise<string[]>;
  close(): void;
}

export interface Welcome {
  serverName: string;
  revision: string;
  seed: number;
  landscape: number;
  startDate: number;
  mapX: number;
  mapY: number;
}

export const GS_MAX_BYTES = 1450;
const RCON_TIMEOUT_MS = 30_000;

export class AdminClient implements AdminLink {
  private sock!: net.Socket;
  private readonly frames = new FrameDecoder();
  private enc: AeadStream | undefined;
  private keys: [Uint8Array, Uint8Array] | undefined;
  private rconQueue: { cmd: string; resolve(l: string[]): void; reject(e: Error): void }[] = [];
  private rconLines: string[] = [];
  private rconTimer: NodeJS.Timeout | undefined;
  private closedFlag = false;

  constructor(
    private readonly secret: Uint8Array,
    private readonly events: AdminEvents,
    private readonly name = 'edumise-bridge',
    private readonly version = '1',
  ) {}

  /** Resolves after ServerWelcome, with the update frequencies registered. */
  connect(host: string, port: number): Promise<Welcome> {
    return new Promise((resolve, reject) => {
      let welcomed = false;
      this.sock = net.connect({ host, port });
      this.sock.on('connect', () => {
        this.send(
          Admin.JoinSecure,
          new Writer().str(this.name).str(this.version).u16(1 << AUTH_AUTHORIZED_KEY).build(),
        );
      });
      this.sock.on('data', (chunk) => {
        try {
          let pkts = this.frames.push(chunk);
          while (pkts.length) {
            for (const p of pkts) {
              const w = this.handle(p.type, new Reader(p.payload));
              if (w && !welcomed) {
                welcomed = true;
                this.afterWelcome();
                resolve(w);
              }
            }
            pkts = this.frames.push(new Uint8Array(0));
          }
        } catch (e) {
          this.fail(e as Error);
        }
      });
      this.sock.on('error', (e) => this.fail(e));
      this.sock.on('close', () => this.fail(new Error('admin connection closed')));
      const failEarly = (e?: Error) => !welcomed && reject(e ?? new Error('admin closed'));
      this.onFail = failEarly;
    });
  }

  private onFail: ((e?: Error) => void) | undefined;

  private fail(e: Error): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    clearTimeout(this.rconTimer);
    for (const r of this.rconQueue.splice(0)) r.reject(e);
    this.sock?.destroy();
    this.onFail?.(e);
    this.events.closed(e);
  }

  close(): void {
    if (this.closedFlag) return;
    try {
      this.send(Admin.Quit, new Uint8Array(0));
    } catch {
      /* closing anyway */
    }
    this.fail(new Error('closed by bridge'));
  }

  private send(type: number, payload: Uint8Array): void {
    this.sock.write(encodeFrame(type, payload, this.enc));
  }

  private afterWelcome(): void {
    for (const t of [UpdateType.ClientInfo, UpdateType.CompanyInfo, UpdateType.Gamescript]) {
      this.send(Admin.UpdateFrequency, new Writer().u16(t).u16(FREQ_AUTOMATIC).build());
    }
    // Companies that already exist (names for /companies) and clients that joined or
    // founded a company while no admin link was up (admission, §6.3) — poll all.
    for (const t of [UpdateType.CompanyInfo, UpdateType.ClientInfo]) {
      this.send(Admin.Poll, new Writer().u8(t).u32(0xffffffff).build());
    }
  }

  /** Returns the welcome when the handshake finished. */
  private handle(type: number, r: Reader): Welcome | undefined {
    switch (type) {
      case Server.AuthRequest: {
        const method = r.u8();
        if (method !== AUTH_AUTHORIZED_KEY) throw new Error(`unexpected auth method ${method}`);
        const serverPub = r.bytes(32);
        const nonce = r.bytes(24);
        const keys = deriveClientKeys(this.secret, serverPub);
        if (!keys) throw new Error('server sent an illegal public key');
        this.keys = keys;
        const ourPub = publicKey(this.secret);
        const [mac, ct] = aeadLock(keys[0], nonce, ourPub, randomBytes(8));
        this.send(Admin.AuthResponse, new Writer().bytes(ourPub).bytes(mac).bytes(ct).build());
        return;
      }
      case Server.EnableEncryption: {
        if (!this.keys) throw new Error('encryption before key exchange');
        const nonce = r.bytes(24);
        this.enc = new AeadStream(this.keys[0], nonce);
        this.frames.dec = new AeadStream(this.keys[1], nonce);
        return;
      }
      case Server.Error:
        throw new Error(`admin port error ${r.u8()}`);
      case Server.Full:
      case Server.Banned:
      case Server.Shutdown:
        throw new Error(`admin port closed by server (${type})`);
      case Server.Welcome: {
        const serverName = r.str();
        const revision = r.str();
        r.bool(); // dedicated
        r.str(); // formerly the map name
        return { serverName, revision, seed: r.u32(), landscape: r.u8(), startDate: r.u32(), mapX: r.u16(), mapY: r.u16() };
      }
      case Server.GameScript:
        this.events.gs(r.str());
        return;
      case Server.ClientInfo: {
        const id = r.u32();
        const host = r.str();
        r.str(); // name
        r.u8(); // language
        r.u32(); // join date
        this.events.clientInfo(id, host, r.u8());
        return;
      }
      case Server.ClientUpdate: {
        const id = r.u32();
        r.str();
        this.events.clientUpdate(id, r.u8());
        return;
      }
      case Server.ClientQuit:
        this.events.clientQuit(r.u32());
        return;
      case Server.CompanyNew:
        this.events.companyNew(r.u8());
        return;
      case Server.CompanyInfo:
      case Server.CompanyUpdate: {
        const c = r.u8();
        this.events.companyInfo(c, r.str());
        return;
      }
      case Server.CompanyRemove: {
        const c = r.u8();
        this.events.companyRemove(c, r.u8());
        return;
      }
      case Server.Rcon:
        r.u16(); // colour
        this.rconLines.push(r.str());
        return;
      case Server.RconEnd:
        this.finishRcon();
        return;
      default:
        return; // protocol, date, chat, console, ... are not used
    }
  }

  gs(msg: object): void {
    const json = JSON.stringify(msg);
    if (Buffer.byteLength(json) > GS_MAX_BYTES) throw new Error('GameScript message over 1450 bytes');
    this.send(Admin.GameScript, new Writer().str(json).build());
  }

  rcon(cmd: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      if (this.closedFlag) return reject(new Error('admin connection closed'));
      this.rconQueue.push({ cmd, resolve, reject });
      if (this.rconQueue.length === 1) this.startRcon();
    });
  }

  private startRcon(): void {
    const head = this.rconQueue[0];
    if (!head) return;
    this.rconLines = [];
    this.send(Admin.Rcon, new Writer().str(head.cmd).build());
    this.rconTimer = setTimeout(() => this.fail(new Error(`rcon timeout: ${head.cmd}`)), RCON_TIMEOUT_MS);
  }

  private finishRcon(): void {
    clearTimeout(this.rconTimer);
    const head = this.rconQueue.shift();
    head?.resolve(this.rconLines);
    this.startRcon();
  }
}
