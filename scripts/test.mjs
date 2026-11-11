import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const tests = readdirSync(new URL('../tests/', import.meta.url)).filter(name => name.endsWith('.test.ts'));
if (!tests.length) throw new Error('No backend tests were discovered.');
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...tests.map(name => `tests/${name}`)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
