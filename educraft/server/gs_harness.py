#!/usr/bin/env python3
"""Headless test of the EduMise wallet GameScript and the server patches (CONTRACT.md §8 A).

Starts the native dedicated server from build-dedicated/ in a throwaway directory with
educraft/server/openttd.cfg (plus test-only deltas: random loopback ports, insecure admin
login with a password, GS setting ladeni=1) and plays the bridge's side over the admin port.
AI companies (start_ai) stand in for pupil companies: the GameScript treats them the same.

    python3 educraft/server/gs_harness.py           # ~5 min
    python3 educraft/server/gs_harness.py --slow    # + bankruptcy hold over 13 game months (~15 min more)

Python 3 stdlib only. Nothing leaves 127.0.0.1.
"""

import argparse
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from game_client import NEW_COMPANY, SPECTATOR, GameClient, JoinRefused, cstr, i64, newgrf_version, u8, u16, u32

ROOT = Path(__file__).resolve().parents[2]
GAME = "ctest00000001"

# Admin packet types (src/network/core/tcp_admin.h).
A_JOIN, A_UPDATE_FREQUENCY, A_POLL, A_RCON, A_GAMESCRIPT = 0, 2, 3, 5, 6
S_ERROR, S_WELCOME, S_COMPANY_NEW, S_COMPANY_INFO, S_COMPANY_UPDATE, S_COMPANY_REMOVE = 102, 104, 113, 114, 115, 116
S_RCON, S_GAMESCRIPT, S_RCON_END = 120, 124, 125
UPD_COMPANY_INFO, UPD_GAMESCRIPT, FREQ_AUTOMATIC = 2, 9, 0x40


def cstr(s):
    return s.encode() + b"\0"


class Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def u8(self):
        self.pos += 1
        return self.data[self.pos - 1]

    def u16(self):
        self.pos += 2
        return struct.unpack_from("<H", self.data, self.pos - 2)[0]

    def u32(self):
        self.pos += 4
        return struct.unpack_from("<I", self.data, self.pos - 4)[0]

    def string(self):
        end = self.data.index(b"\0", self.pos)
        s = self.data[self.pos:end].decode("utf-8", "replace")
        self.pos = end + 1
        return s


class Admin:
    """Minimal admin-port client: GS JSON in both directions, rcon, company info."""

    def __init__(self, port, password):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.buf = b""
        self.gs = []           # every GS message, in arrival order
        self.rcon_lines, self.rcon_done = [], False
        self.companies = {}    # company -> quarters of bankruptcy (last info/update)
        self.removed = []
        self.welcome = False
        self.send(A_JOIN, cstr(password) + cstr("gs_harness") + cstr("1"))
        self.pump_until(lambda: self.welcome, 10, "admin welcome")
        for upd in (UPD_GAMESCRIPT, UPD_COMPANY_INFO):
            self.send(A_UPDATE_FREQUENCY, struct.pack("<HH", upd, FREQ_AUTOMATIC))

    def send(self, ptype, payload):
        self.sock.sendall(struct.pack("<HB", len(payload) + 3, ptype) + payload)

    def pump(self, timeout):
        self.sock.settimeout(timeout)
        try:
            chunk = self.sock.recv(65536)
        except socket.timeout:
            return
        if not chunk:
            raise RuntimeError("admin connection closed")
        self.buf += chunk
        while len(self.buf) >= 3:
            size, ptype = struct.unpack_from("<HB", self.buf)
            if len(self.buf) < size:
                break
            self.handle(ptype, Reader(self.buf[3:size]))
            self.buf = self.buf[size:]

    def handle(self, ptype, r):
        if ptype == S_WELCOME:
            r.string()
            self.revision = r.string()  # the network revision a game client must send
            self.welcome = True
        elif ptype == S_ERROR:
            raise RuntimeError(f"admin error {r.u8()}")
        elif ptype == S_GAMESCRIPT:
            self.gs.append(json.loads(r.string()))
        elif ptype == S_RCON:
            r.u16()
            self.rcon_lines.append(r.string())
        elif ptype == S_RCON_END:
            self.rcon_done = True
        elif ptype in (S_COMPANY_INFO, S_COMPANY_UPDATE):
            c = r.u8()
            r.string(), r.string(), r.u8(), r.u8()
            if ptype == S_COMPANY_INFO:
                r.u32(), r.u8()
            self.companies[c] = r.u8()
        elif ptype == S_COMPANY_REMOVE:
            self.removed.append(r.u8())

    def pump_until(self, cond, timeout, what):
        end = time.time() + timeout
        while not cond():
            if time.time() > end:
                raise TimeoutError(f"timed out waiting for {what}")
            self.pump(0.2)

    def mark(self):
        return len(self.gs)

    def to_gs(self, msg):
        self.send(A_GAMESCRIPT, cstr(json.dumps(msg, ensure_ascii=False)))

    def expect(self, since, pred, timeout=15, what="GS message"):
        found = []

        def cond():
            found[:] = [m for m in self.gs[since:] if pred(m)]
            return bool(found)
        self.pump_until(cond, timeout, what)
        return found[0]

    def none_within(self, since, pred, seconds):
        end = time.time() + seconds
        while time.time() < end:
            self.pump(0.2)
        return not any(pred(m) for m in self.gs[since:])

    def ask(self, msg, t, timeout=15, **match):
        """Send a message and return the first reply of type t matching the fields."""
        since = self.mark()
        self.to_gs(msg)
        return self.expect(since, lambda m: m["t"] == t and all(m.get(k) == v for k, v in match.items()),
                           timeout, f"{t} {match} after {msg}")

    def rcon(self, cmd):
        self.rcon_lines, self.rcon_done = [], False
        self.send(A_RCON, cstr(cmd))
        self.pump_until(lambda: self.rcon_done, 30, f"rcon {cmd}")
        return self.rcon_lines

    def poll_company(self, c):
        self.send(A_POLL, struct.pack("<BI", UPD_COMPANY_INFO, c))

    def fin(self):
        """Current finances by company, from a fresh report (all pages)."""
        since = self.mark()
        self.to_gs({"t": "report", "what": "fin"})
        first = self.expect(since, lambda m: m["t"] == "fin", what="fin")
        self.pump_until(lambda: sum(1 for m in self.gs[since:] if m["t"] == "fin") >= first["pgs"], 15, "fin pages")
        return {co["c"]: co for m in self.gs[since:] if m["t"] == "fin" for co in m["co"]}

    def names(self):
        """Current company names, from a fresh report (all pages)."""
        since = self.mark()
        self.to_gs({"t": "report", "what": "fin"})
        first = self.expect(since, lambda m: m["t"] == "names", what="names")
        self.pump_until(lambda: sum(1 for m in self.gs[since:] if m["t"] == "names") >= first["pgs"], 15, "names pages")
        return {c: n for m in self.gs[since:] if m["t"] == "names" for c, n in m["co"]}

    def state(self):
        return self.ask({"t": "hello", "v": 1}, "state")

    def wait(self, seconds):
        """Keep the admin connection served for a while."""
        self.none_within(self.mark(), lambda m: False, seconds)

    def playas(self, client_id):
        """The client's company as the server has it (`clients` prints company + 1)."""
        for line in self.rcon("clients"):
            m = re.match(r"Client #(\d+)\s+name: '.*'\s+company: (\d+)", line)
            if m and int(m.group(1)) == client_id:
                n = int(m.group(2))
                return n if n == SPECTATOR else n - 1
        return None


def needs_per_month(msgs, company):
    """Count `need`s per game month; every `fin` page carries the date it was sent."""
    month, counts = None, {}
    for x in msgs:
        if x["t"] == "fin":
            month = x["d"][:7]
        elif x["t"] == "need" and x["c"] == company:
            counts[month] = counts.get(month, 0) + 1
    return counts


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, work, openttd):
        self.work, self.openttd, self.proc = work, openttd, None
        self.port, self.admin_port, self.password = free_port(), free_port(), "harness"
        cfg = (ROOT / "educraft/server/openttd.cfg").read_text(encoding="utf-8")
        cfg = cfg.replace("server_port = 3979", f"server_port = {self.port}")
        cfg = cfg.replace("server_admin_port = 3977", f"server_admin_port = {self.admin_port}")
        cfg = cfg.replace("allow_insecure_admin_login = false", "allow_insecure_admin_login = true")
        cfg = cfg.replace("ladeni=0", "ladeni=1,kapital=0")  # 0/0 checks below assume no start capital
        (work / "openttd.cfg").write_text(cfg, encoding="utf-8")
        (work / "private.cfg").write_text("[server_bind_addresses]\n127.0.0.1\n", encoding="utf-8")
        (work / "secrets.cfg").write_text(f"[network]\nadmin_password = {self.password}\n", encoding="utf-8")
        (work / "game").mkdir()
        (work / "game/edumise_dane").symlink_to(ROOT / "bin/game/edumise_dane")
        self.env = dict(os.environ, HOME=str(work / "home"), XDG_DATA_HOME=str(work / "home/data"),
                        XDG_CONFIG_HOME=str(work / "home/config"))

    def start(self, *args):
        log = open(self.work / "server.log", "ab")
        self.proc = subprocess.Popen([self.openttd, "-D", "-d", "script=4", "-c", str(self.work / "openttd.cfg"), *args],
                                     cwd=self.work, stdout=log, stderr=subprocess.STDOUT, env=self.env)
        end = time.time() + 120
        while True:
            if self.proc.poll() is not None:
                raise RuntimeError(f"server exited, see {self.work / 'server.log'}")
            try:
                return Admin(self.admin_port, self.password)
            except (ConnectionRefusedError, TimeoutError, socket.timeout):
                if time.time() > end:
                    raise
                time.sleep(0.5)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()

    def log(self):
        return (self.work / "server.log").read_text(encoding="utf-8", errors="replace")


class Harness:
    def __init__(self):
        self.failures = []
        self.seq = 0

    def check(self, name, ok, detail=""):
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  -- {detail}"), flush=True)
        if not ok:
            self.failures.append(name)

    def op(self, a, k, **kw):
        """Send the next op in sequence and return its ack."""
        self.seq += 1
        msg = {"t": "op", "seq": self.seq, "k": k, **kw}
        return a.ask(msg, "ack", seq=self.seq)

    def run(self, srv, slow):
        a = srv.start()
        c = self.check

        st = a.state()
        c("boot: fresh game is paused, not adopted, last 0",
          st["game"] is None and st["last"] == 0 and st["paused"] and not st["run"], st)

        m = a.mark()
        a.to_gs({"t": "op", "seq": 1, "k": "noop"})
        n = a.expect(m, lambda x: x["t"] == "nack")
        c("op before adopt: nack game_mismatch", n["r"] == "game_mismatch" and n["expect"] == 1, n)

        st = a.ask({"t": "adopt", "game": GAME}, "state")
        c("adopt sets game", st["game"] == GAME, st)
        st = a.ask({"t": "adopt", "game": "cother0000000"}, "state")
        c("adopt ignored when game already set", st["game"] == GAME, st)

        p = a.ask({"t": "ping"}, "pong")
        c("ping -> pong{last}", p["last"] == 0, p)

        m = a.mark()
        a.to_gs({"t": "op", "seq": 1, "k": "noop"})
        n = a.expect(m, lambda x: x["t"] == "nack")
        c("op outside a session: nack paused", n["r"] == "paused" and n["expect"] == 1, n)

        a.to_gs({"t": "session", "run": True, "sid": "s1", "months": 24})
        a.pump_until(lambda: not a.state()["paused"], 15, "unpause")
        c("session run unpauses", True)

        # Two companies; each must end loan-init at exactly 0 cash / 0 loan.
        comps = []
        for _ in range(2):
            m = a.mark()
            a.rcon("start_ai")
            ev = a.expect(m, lambda x: x["t"] == "company" and x["ev"] == "new", what="company new")
            li = a.expect(m, lambda x: x["t"] == "loaninit" and x["c"] == ev["c"], what="loaninit")
            c(f"loan-init company {ev['c']} to 0/0", li["ok"] and li["cash"] == 0 and li["loan"] == 0, li)
            comps.append(ev["c"])
        c0, c1 = comps
        f = a.fin()
        c("max loan is exactly 13,924 and cash/loan stay 0/0",
          all(f[x]["ml"] == 13924 and f[x]["loan"] == 0 for x in comps), f)

        for x, slot in ((c0, 1), (c1, 2)):
            b = a.ask({"t": "bind", "c": x, "s": slot}, "bound", c=x)
            c(f"bind {x} -> slot {slot}", b["s"] == slot, b)

        before = a.fin()[c0]["cash"]
        ack = self.op(a, "deposit", s=1, c=c0, p=6962)
        after = a.fin()[c0]["cash"]
        c("deposit ack and cash +6962", ack["ok"] and after - before == 6962, (ack, before, after))

        m = a.mark()
        a.to_gs({"t": "op", "seq": self.seq, "k": "deposit", "s": 1, "c": c0, "p": 6962})
        dup = a.expect(m, lambda x: x["t"] == "ack" and x["seq"] == self.seq)
        c("duplicate seq re-acked, not applied twice", dup["ok"] and a.fin()[c0]["cash"] == after, dup)

        m = a.mark()
        a.to_gs({"t": "op", "seq": self.seq + 2, "k": "noop"})
        n = a.expect(m, lambda x: x["t"] == "nack")
        c("gap nack with expect = last+1", n["r"] == "gap" and n["expect"] == self.seq + 1, n)

        ack = self.op(a, "deposit", s=1, c=c1, p=100)
        c("op with bind[c] != s -> no_company", not ack["ok"] and ack["r"] == "no_company", ack)
        ack = self.op(a, "deposit", s=1, c=None, p=100)
        c("op with c = null -> no_company", not ack["ok"] and ack["r"] == "no_company", ack)

        ack = self.op(a, "rename", s=1, c=c0, v="Rychlá doprava")
        c("rename applied by the GS in wallet mode", ack["ok"], ack)
        ack = self.op(a, "rename", s=2, c=c1, v="Rychlá doprava")
        c("failed rename -> ok:false name_taken", not ack["ok"] and ack["r"] == "name_taken", ack)

        taken = a.fin()[c1]["col"]
        ack = self.op(a, "colour", s=1, c=c0, v=taken)
        c("colour of another company -> colour_taken", not ack["ok"] and ack["r"] == "colour_taken", ack)
        free = next(x for x in range(16) if x not in {v["col"] for v in a.fin().values()})
        ack = self.op(a, "colour", s=1, c=c0, v=free)
        c("colour applied by the GS", ack["ok"] and a.fin()[c0]["col"] == free, ack)

        towns = [t for m in [a.ask({"t": "report", "what": "towns"}, "towns", pg=0)] for t in m["tw"]]
        town = towns[0][0]
        c("towns report", len(towns) > 0, towns)

        cash = a.fin()[c0]["cash"]
        ack = self.op(a, "advert", s=1, c=c0, v=town)
        c("advert with positive cash leaves cash unchanged",
          ack["ok"] and a.fin()[c0]["cash"] == cash, (ack, cash, a.fin()[c0]["cash"]))

        a.ask({"t": "debug", "c": c0, "p": -(cash + 5000)}, "debug")
        ack = self.op(a, "advert", s=1, c=c0, v=town)
        c("advert with negative cash succeeds, cash exactly cash_before",
          ack["ok"] and a.fin()[c0]["cash"] == -5000, (ack, a.fin()[c0]))
        ack = self.op(a, "statue", s=1, c=c0, v=town)
        c("statue with negative cash succeeds, cash exactly cash_before",
          ack["ok"] and a.fin()[c0]["cash"] == -5000, (ack, a.fin()[c0]))
        ack = self.op(a, "statue", s=1, c=c0, v=town)
        c("second statue -> action_unavailable, cash untouched",
          not ack["ok"] and ack["r"] == "action_unavailable" and a.fin()[c0]["cash"] == -5000, ack)

        # Rescue: below the native predicate minus the buffer.
        m = a.mark()
        a.fin()  # month marker for needs_per_month
        a.ask({"t": "debug", "c": c0, "p": -8000}, "debug")
        need = a.expect(m, lambda x: x["t"] == "need" and x["c"] == c0, 30, "need")
        buffer = need["p"] - (need["loan"] - need["ml"] - need["cash"])
        c("need read in company mode (loan 0, ml 13924) with buffer >= 1000",
          need["loan"] == 0 and need["ml"] == 13924 and need["cash"] == -13000 and buffer >= 1000, need)
        ack = self.op(a, "rescue", s=1, c=c0, p=need["p"])
        f = a.fin()[c0]
        c("rescue lifts the company to the predicate plus buffer",
          ack["ok"] and f["cash"] - f["loan"] == -f["ml"] + buffer, (ack, f))
        for _ in range(3):  # daily running costs right after the rescue
            a.ask({"t": "debug", "c": c0, "p": -40}, "debug")
            a.none_within(m, lambda x: False, 2.5)
        per_month = needs_per_month(a.gs[m:], c0)
        c("after a rescue, daily costs send no second need in the same month",
          per_month and max(per_month.values()) == 1, per_month)

        li = a.ask({"t": "debug", "c": c1, "p": -46, "reinit": True}, "loaninit", c=c1)
        c("loan-init top-up after a native charge (a month of interest) still ends at 0/0",
          li["ok"] and li["cash"] == 0 and li["loan"] == 0 and a.fin()[c1]["cash"] == 0, li)
        li = a.ask({"t": "debug", "c": c1, "p": -500, "reinit": True}, "loaninit", c=c1)
        c("loan-init does not refund pupil spending: ok:false, cash stays -500",
          not li["ok"] and li["cash"] == -500 and a.fin()[c1]["cash"] == -500, li)
        li = a.ask({"t": "debug", "c": c1, "p": 500}, "loaninit", c=c1)
        c("pending loan-init completes once the gap is closed", li["ok"] and a.fin()[c1]["cash"] == 0, li)

        self.mayor(a, c0, c1, town)

        # Hold: the current op completes first, then nothing applies until the session runs again.
        m = a.mark()
        self.seq += 1
        a.to_gs({"t": "op", "seq": self.seq, "k": "noop"})
        a.to_gs({"t": "hold"})
        held = a.expect(m, lambda x: x["t"] == "held")
        acked = [x for x in a.gs[m:] if x["t"] == "ack" and x["seq"] == self.seq]
        c("hold -> held{last} after the in-flight op", acked and held["last"] == self.seq, (held, acked))
        m = a.mark()
        a.to_gs({"t": "op", "seq": self.seq + 1, "k": "noop"})
        n = a.expect(m, lambda x: x["t"] == "nack")
        c("ops nacked held while held", n["r"] == "held", n)
        # Held: no GS money work either (loan-init, taxes: both run in Running()) until resumed.
        m = a.mark()
        a.ask({"t": "debug", "c": c1, "p": -46, "reinit": True}, "debug")
        c("no loan-init while held", a.none_within(m, lambda x: x["t"] == "loaninit", 5))
        m = a.mark()
        a.to_gs({"t": "session", "run": True, "sid": "s1", "months": 24})
        li = a.expect(m, lambda x: x["t"] == "loaninit" and x["c"] == c1, what="loaninit after the hold")
        c("loan-init right after the hold ends", li["ok"] and a.fin()[c1]["cash"] == 0, li)

        # Quiesced save, like the bridge: hold, save, then restart from that save.
        saved_state = a.state()  # hello also ends the hold; hold again for the save
        a.ask({"t": "hold"}, "held")
        dump = a.ask({"t": "debug", "what": "dump"}, "debug")
        lines = a.rcon("save harness")
        c("rcon save", any("saved" in x.lower() for x in lines), lines)
        srv.stop()
        saves = list(srv.work.rglob("harness.sav"))
        a = srv.start("-g", str(saves[0]))
        st = a.state()
        c("load keeps game, last, ring, bind",
          all(st[k] == saved_state[k] for k in ("game", "last", "ring")) and
          sorted(map(tuple, st["co"])) == sorted(map(tuple, saved_state["co"])), (st, saved_state))
        c("load pauses and clears run", st["paused"] and not st["run"], st)
        dump2 = a.ask({"t": "debug", "what": "dump"}, "debug")
        c("load keeps inited", sorted(dump2["inited"]) == sorted(dump["inited"]) and dump2["pending"] == [],
          (dump, dump2))
        c("load keeps treasury, tax rate and Citadela",
          all(dump2[k] == dump[k] for k in ("pokl", "sazba", "citadela")), (dump, dump2))

        # A company founded while paused: no money command until the session runs.
        m = a.mark()
        a.rcon("start_ai")
        ev = a.expect(m, lambda x: x["t"] == "company" and x["ev"] == "new", what="company new while paused")
        c2 = ev["c"]
        c("no loan-init while paused", a.none_within(m, lambda x: x["t"] == "loaninit", 5))
        date0 = a.state()["date"]
        m = a.mark()
        a.to_gs({"t": "session", "run": True, "sid": "s1", "months": 24})
        li = a.expect(m, lambda x: x["t"] == "loaninit" and x["c"] == c2, what="loaninit after unpause")
        a.pump_until(lambda: a.state()["date"] != date0, 20, "date advance")
        c("loan-init right after unpause, game unfrozen", li["ok"], li)

        self.seq = st["last"]
        ack = self.op(a, "deposit", s=1, c=c0, p=10)
        c("ops resume after load", ack["ok"], ack)

        # Watchdog: silence for > 2000 ticks pauses; run stays set; session run resumes.
        time.sleep(62)
        st = a.state()
        c("watchdog pauses after ~54 s without messages", st["paused"] and st["run"], st)
        a.to_gs({"t": "session", "run": True, "sid": "s1", "months": 24})
        a.pump_until(lambda: not a.state()["paused"], 15, "resume after watchdog")
        c("session run resumes after watchdog", True)

        self.client_hooks(a, srv, c0, town)

        if slow:
            self.bankruptcy_hold(a, c1)

        # Session limit: a new session of 1 month pauses itself at the month boundary.
        m = a.mark()
        a.to_gs({"t": "session", "run": True, "sid": "s2", "months": 1})
        deadline = time.time() + 90
        while time.time() < deadline and not any(x["t"] == "limit" for x in a.gs[m:]):
            a.to_gs({"t": "ping"})
            a.pump(2)
        lim = [x for x in a.gs[m:] if x["t"] == "limit"]
        st = a.state()
        c("session limit: GS pauses itself and sends limit",
          lim and lim[0]["months"] == 1 and st["paused"] and not st["run"], (lim, st))

        lines = a.rcon(f"edu_admit 9999 {c0 + 1}")
        c("edu_admit is a server console command and refuses unknown clients",
          any("Invalid client-id" in x for x in lines), lines)

        p = a.ask({"t": "ping"}, "pong")
        c("GameScript still alive at the end", p["last"] == self.seq, p)

        # An old save (wallet without pokladna/rozpocet) gets the start treasury at load.
        a.ask({"t": "hold"}, "held")
        a.ask({"t": "debug", "what": "legacy"}, "debug")
        a.rcon("save legacy")
        srv.stop()
        a = srv.start("-g", str(next(srv.work.rglob("legacy.sav"))))
        dump = a.ask({"t": "debug", "what": "dump"}, "debug")
        c("old save without a treasury loads with pokl 20,000", dump["pokl"] == 20000, dump)

        log = srv.log()
        c("no script errors or oversized admin messages",
          "GSAdmin.Send failed" not in log and "Your script made an error" not in log,
          [x for x in log.splitlines() if "error" in x.lower()][-10:])

    def mayor(self, a, c0, c1, town):
        """Mayor ops (contract §4.4, D21/D23): deity mode, ack p = what was actually applied."""
        c = self.check
        dump = a.ask({"t": "debug", "what": "dump"}, "debug")
        p0 = dump["pokl"]
        c("treasury starts at 20,000 (plus taxes paid) and Citadela is a town",
          p0 >= 20000 and isinstance(dump["citadela"], int), dump)
        since = a.mark()
        a.to_gs({"t": "report", "what": "fin"})
        page0 = a.expect(since, lambda m: m["t"] == "fin" and m["pg"] == 0, what="fin page 0")
        c("fin page 0 carries pokl", page0.get("pokl") == p0, page0)

        ack = self.op(a, "fine", s=1, c=c0, p=500)
        c("fine at the rescue line -> nothing_to_fine", not ack["ok"] and ack["r"] == "nothing_to_fine", ack)
        cash = a.fin()[c0]["cash"]
        ack = self.op(a, "grant", s=1, c=c0, p=1000)
        dump = a.ask({"t": "debug", "what": "dump"}, "debug")
        c("grant: cash +1000 from the treasury, ack p",
          ack["ok"] and ack.get("p") == 1000 and a.fin()[c0]["cash"] == cash + 1000 and dump["pokl"] == p0 - 1000,
          (ack, dump))
        ack = self.op(a, "grant", s=1, c=c1, p=1000)
        c("grant to a company not bound to the slot -> no_company", not ack["ok"] and ack["r"] == "no_company", ack)

        a.ask({"t": "debug", "c": c1, "p": 3000}, "debug")
        m = a.mark()
        a.fin()  # month marker for needs_per_month
        ack = self.op(a, "fine", s=2, c=c1, p=3481)
        f = a.fin()[c1]
        c("fine clipped to positive cash, ack p = applied",
          ack["ok"] and ack.get("p") == 3000 and f["cash"] == 0, (ack, f))
        a.wait(5)
        c("no need after a fine", not any(x["t"] == "need" and x["c"] == c1 for x in a.gs[m:]))

        a.ask({"t": "debug", "pokl": 0}, "debug")
        ack = self.op(a, "grant", s=1, c=c0, p=1)
        c("grant from an empty treasury -> treasury_empty", not ack["ok"] and ack["r"] == "treasury_empty", ack)
        ack = self.op(a, "expand", v=town, p=1)
        c("expand from an empty treasury -> treasury_empty", not ack["ok"] and ack["r"] == "treasury_empty", ack)
        a.ask({"t": "debug", "pokl": 20000}, "debug")

        # Tax (D23): only what was paid out of positive cash reaches the treasury; a refund comes out of it.
        a.ask({"t": "debug", "c": c1, "p": 300}, "debug")  # c1: 0 -> 300 after the clipped fine
        r = a.ask({"t": "debug", "c": c1, "tax": 1000}, "debug")
        dump = a.ask({"t": "debug", "what": "dump"}, "debug")
        f = a.fin()[c1]
        c("tax over positive cash: treasury gets only the cash part",
          r["ok"] and dump["pokl"] == 20300 and f["cash"] == -700, (r, dump, f))
        r = a.ask({"t": "debug", "c": c1, "tax": -400}, "debug")
        dump = a.ask({"t": "debug", "what": "dump"}, "debug")
        f = a.fin()[c1]
        c("tax refund comes out of the treasury in full",
          r["ok"] and dump["pokl"] == 19900 and f["cash"] == -300, (r, dump, f))
        a.ask({"t": "debug", "c": c1, "p": 300}, "debug")
        a.ask({"t": "debug", "pokl": 20000}, "debug")

        ack = self.op(a, "tax", v=30)
        dump = a.ask({"t": "debug", "what": "dump"}, "debug")
        c("tax without a company sets the rate", ack["ok"] and dump["sazba"] == 30, (ack, dump))
        ack = self.op(a, "tax", v=60)
        c("tax over 50 -> invalid", not ack["ok"] and ack["r"] == "invalid", ack)
        ack = self.op(a, "news", v="Zítra se staví most.")
        c("news without a company", ack["ok"], ack)
        ack = self.op(a, "expand", v=town, p=3)
        dump = a.ask({"t": "debug", "what": "dump"}, "debug")
        c("expand charges only houses actually built",
          (ack["ok"] and 1 <= ack.get("p", 0) <= 3 and dump["pokl"] == 20000 - ack["p"] * 1000) or
          (not ack["ok"] and ack["r"] == "action_unavailable" and dump["pokl"] == 20000), (ack, dump))

    def client_hooks(self, a, srv, other, town):
        """§5 tests 1, 2 and 5 through a real game socket: what a pupil's client sends."""
        c = self.check
        grf = newgrf_version(srv.openttd)
        new_company = lambda cl: cl.command(SPECTATOR, "CompanyControl", u8(0), u8(0xFF), u8(0), u32(cl.client_id))

        a.rcon(f"setting network.max_companies {len(a.fin())}")
        try:
            pa = GameClient(srv.port, a.revision, grf, "pupil-a", NEW_COMPANY)
            joined = a.playas(pa.client_id)
        except JoinRefused as e:
            pa, joined = None, str(e)
        a.rcon("setting network.max_companies 15")
        c("join as NEW_COMPANY on a full server -> spectator, not ServerFull", joined == SPECTATOR, joined)
        if pa is None:
            return

        m = a.mark()
        new_company(pa)
        c("CompanyControl New without a 'new' admission founds nothing",
          a.none_within(m, lambda x: x["t"] == "company" and x["ev"] == "new", 5))

        a.rcon(f"edu_admit {pa.client_id} new")
        m = a.mark()
        new_company(pa)
        h = a.expect(m, lambda x: x["t"] == "company" and x["ev"] == "new", what="company founded by the client")["c"]
        a.expect(m, lambda x: x["t"] == "loaninit" and x["c"] == h, what="loaninit of the client's company")
        c("with a 'new' admission the client founds one company and sits in it", a.playas(pa.client_id) == h)
        a.rcon(f"edu_admit {pa.client_id} {h + 1}")  # what the bridge does after POST /companies

        pb = GameClient(srv.port, a.revision, grf, "pupil-b")
        pb.move(h)
        a.wait(3)
        c("a client without an admission cannot move into a company", a.playas(pb.client_id) == SPECTATOR)
        a.rcon(f"edu_admit {pb.client_id} spectator")
        pb.move(h)
        a.wait(3)
        c("a spectator admission cannot move into a foreign company", a.playas(pb.client_id) == SPECTATOR)

        # Gated commands from the client socket; a loan from the same socket proves commands get through.
        a.ask({"t": "bind", "c": h, "s": 3}, "bound", c=h)
        self.op(a, "deposit", s=3, c=h, p=5000)
        f0, n0 = a.fin()[h], a.names()[h]
        free = next(x for x in range(16) if x not in {v["col"] for v in a.fin().values()})
        gated = [("RenamePresident", cstr("Hacker")), ("RenameCompany", cstr("Hacker a.s.")),
                 ("SetCompanyColour", u8(0), u8(1), u8(free)), ("GiveMoney", i64(1000), u8(other)),
                 ("BuyCompany", u8(other), u8(0)), ("TownAction", u16(town), u8(2)), ("TownAction", u16(town), u8(4))]
        for cmd in gated:
            pa.command(h, *cmd)
        pa.command(h, "IncreaseLoan", u8(2), i64(3481))
        a.pump_until(lambda: a.fin()[h]["loan"] == 3481, 15, "loan taken by the client")
        f1, n1 = a.fin()[h], a.names()[h]
        dropped = sum(1 for x in pa.chat if "peněžence" in x)
        c("gated commands from a client are not executed (name, colour, cash unchanged), a loan is",
          f1["cash"] == f0["cash"] + 3481 and f1["col"] == f0["col"] and n1 == n0 and dropped == len(gated),
          (f0, f1, n0, n1, pa.chat))

        # A removed company's id goes to the next new company; an old admission must not lead into it.
        pa.move(SPECTATOR)
        a.wait(2)
        m = a.mark()
        a.rcon(f"reset_company {h + 1}")
        a.expect(m, lambda x: x["t"] == "company" and x["ev"] == "removed" and x["c"] == h, what="company removed")
        a.rcon(f"edu_admit {pb.client_id} new")
        m = a.mark()
        new_company(pb)
        h2 = a.expect(m, lambda x: x["t"] == "company" and x["ev"] == "new", what="company founded by client b")["c"]
        pa.move(h2)
        a.wait(3)
        c("a stale admission to a removed company gives no way into the company reusing its id",
          h2 == h and a.playas(pa.client_id) == SPECTATOR and a.playas(pb.client_id) == h2, (h, h2))
        c("the test clients were never kicked", not pa.closed and not pb.closed, pa.chat + pb.chat)
        pa.close()
        pb.close()

    def bankruptcy_hold(self, a, company):
        """Insolvent for 13 game months: stays at the warnings, never offered or removed."""
        a.ask({"t": "debug", "c": company, "p": -20000}, "debug")
        start = a.state()["date"]
        quarters = set()
        while True:
            a.to_gs({"t": "ping"})
            a.poll_company(company)
            a.pump(5)
            quarters.add(a.companies.get(company))
            date = a.state()["date"]
            y0, m0 = map(int, start.split("-")[:2])
            y1, m1 = map(int, date.split("-")[:2])
            if (y1 - y0) * 12 + m1 - m0 >= 13:
                break
        self.check("insolvent company held at months_of_bankruptcy <= 3 for 13 months (not offered, not removed)",
                   company not in a.removed and 1 in quarters and quarters <= {0, 1, None}, (quarters, a.removed))
        a.ask({"t": "debug", "c": company, "p": 20000}, "debug")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--openttd", default=str(ROOT / "build-dedicated/openttd"))
    ap.add_argument("--baseset", default=str(ROOT / "build/baseset"), help="directory with OpenGFX")
    ap.add_argument("--slow", action="store_true", help="also run the 13-month bankruptcy hold test")
    ap.add_argument("--keep", action="store_true", help="keep the work directory")
    args = ap.parse_args()

    work = Path(tempfile.mkdtemp(prefix="edumise-gs-"))
    (work / "baseset").symlink_to(Path(args.baseset).resolve())
    srv = Server(work, args.openttd)
    h = Harness()
    try:
        h.run(srv, args.slow)
    except Exception as e:  # a hang or crash is a failure too
        h.check("harness ran to the end", False, repr(e))
    finally:
        srv.stop()
        if args.keep or h.failures:
            print(f"work dir kept: {work}")
        else:
            shutil.rmtree(work)
    print(f"{'FAILED' if h.failures else 'OK'}: {len(h.failures)} failure(s)")
    sys.exit(1 if h.failures else 0)


if __name__ == "__main__":
    main()
