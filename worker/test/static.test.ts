/**
 * Source-level rules: enforcement must not depend on convention alone, so these checks fail the
 * build if someone adds a second way to click, fill or run script in the portal.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
function files(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : [],
  );
}
const src = files('src').map((f) => ({ f: f.replace(/\\/g, '/'), text: readFileSync(join(root, f), 'utf8') }));
const where = (re: RegExp) => src.filter((s) => re.test(s.text)).map((s) => s.f).sort();

describe('worker source rules', () => {
  it('clicks only in guard.ts (clickAllowed)', () => {
    expect(where(/\.(click|dblclick|tap|dispatchEvent|dragTo|setChecked|check|uncheck)\(/)).toEqual(['src/guard.ts']);
    const guard = src.find((s) => s.f === 'src/guard.ts')!.text;
    expect(guard.match(/\.click\(/g)).toHaveLength(1);
  });
  it('fills form fields only in session.ts (the three login fields)', () => {
    expect(where(/\.(fill|type|pressSequentially|selectOption|setInputFiles|press)\(/)).toEqual(['src/session.ts']);
    const session = src.find((s) => s.f === 'src/session.ts')!.text;
    expect(session.match(/\.fill\(/g)).toHaveLength(3);
  });
  it('never runs script in the portal page', () => {
    expect(where(/evaluate|\$eval|\$\$eval|addInitScript|exposeFunction|exposeBinding|addScriptTag/)).toEqual([]);
  });
  it('portal addresses and rule names live only in allowlist.ts', () => {
    expect(where(/\/archibus|executeCustomSQL|plaincall|(?<![\w-])qf-|(?<![\w-])gc-qf-|[A-Za-z]+-[A-Za-z]+\.axvw/)).toEqual(['src/allowlist.ts']);
  });
  it('contains no real portal host anywhere in the package', () => {
    const host = ['marafiq', 'qf', 'org', 'qa'].join('.');
    const all = [...files('src'), ...files('mock-portal'), ...files('test')].map((f) => readFileSync(join(root, f), 'utf8'));
    expect(all.some((t) => t.toLowerCase().includes(host))).toBe(false);
  });
});
