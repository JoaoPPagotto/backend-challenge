import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

/** Layer boundaries, enforced as a test (in addition to Biome's restricted imports). */
const root = `${import.meta.dir}/../../src`;

async function filesMatching(pattern: string): Promise<string[]> {
  return Array.fromAsync(new Glob(pattern).scan({ cwd: root }));
}

async function importsOf(file: string): Promise<string[]> {
  const text = await Bun.file(`${root}/${file}`).text();
  return [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('architecture', () => {
  test('domain depends on no framework, ORM, AWS SDK or outer layer', async () => {
    const offenders: string[] = [];
    for (const file of await filesMatching('**/domain/**/*.ts')) {
      for (const spec of await importsOf(file)) {
        const forbidden =
          /^@(nestjs|mikro-orm|aws-sdk)\//.test(spec) ||
          /^(pino|prom-client|zod|fastify)$/.test(spec) ||
          /\/(application|infrastructure|presentation)\//.test(spec);
        if (forbidden) offenders.push(`${file} → ${spec}`);
        if (spec === 'decimal.js' && !file.endsWith('money/money.ts')) offenders.push(`${file} → decimal.js`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('application never imports infrastructure or presentation', async () => {
    const offenders: string[] = [];
    for (const file of await filesMatching('**/application/**/*.ts')) {
      for (const spec of await importsOf(file)) {
        if (/\/(infrastructure|presentation)\//.test(spec) || /^@(nestjs|mikro-orm|aws-sdk)\//.test(spec)) {
          offenders.push(`${file} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no floating point money: domain never parses amounts as numbers', async () => {
    const offenders: string[] = [];
    for (const file of await filesMatching('**/*.ts')) {
      const text = await Bun.file(`${root}/${file}`).text();
      if (/parseFloat\(|\.toNumber\(\)/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
