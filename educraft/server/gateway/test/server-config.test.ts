/**
 * The class server's openttd.cfg (§6.2) and the EduCraft client setting defaults: values the
 * dedicated binary reads at boot, so a typo only shows on a live server.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../..');

/** Minimal OpenTTD ini: `[section]`, `key = value`, `;` comments. */
function ini(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let sec = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) {
      out[(sec = s[1])] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) out[sec][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

describe('educraft/server/openttd.cfg', () => {
  const cfg = ini(readFileSync(join(ROOT, 'educraft/server/openttd.cfg'), 'utf8'));

  it('has ini_version (without it private.cfg with the admin key and bind address is ignored)', () => {
    expect(Number(cfg.version?.ini_version)).toBeGreaterThanOrEqual(8);
  });

  it('new class maps are 4096 x 4096 (2^12, the engine maximum)', () => {
    expect(cfg.game_creation).toMatchObject({ map_x: '12', map_y: '12' });
  });

  it('pupils get ~110 s to download and load the big map on join', () => {
    expect(cfg.network).toMatchObject({ max_join_time: '4000', max_download_time: '4000' });
  });

  it('only quiesced saves are rollback points: no autosave, not even on exit, no threaded save', () => {
    expect(cfg.gui).toMatchObject({ autosave_interval: '0', autosave_on_exit: 'false', threaded_saves: 'false' });
  });

  it('wallet mode with 15 companies and the pilot loan', () => {
    expect(cfg.network).toMatchObject({ edu_wallet_mode: 'true', max_companies: '15', allow_insecure_admin_login: 'false' });
    expect(cfg.difficulty.max_loan).toBe('300000');
    expect(cfg.game_scripts['"EduMise — daně"']).toContain('penezenka=1');
    expect(cfg.game_scripts['"EduMise — daně"']).toContain('ladeni=0');
  });
});

describe('src/table/settings/misc_settings.ini', () => {
  it('prefer_sprite_font defaults to true (the classic pixel font)', () => {
    const text = readFileSync(join(ROOT, 'src/table/settings/misc_settings.ini'), 'utf8');
    const block = text.split(/\n(?=\[)/).find((b) => b.includes('name     = ""prefer_sprite_font""'));
    expect(block).toBeDefined();
    expect(block).toMatch(/^def\s*=\s*true$/m);
  });
});
