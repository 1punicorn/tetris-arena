import 'dotenv/config';
import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { BenchConfigSchema } from './core/run-config.js';
import { loadProfiles } from './providers/config.js';
import { safeError } from './core/errors.js';
import { Manager } from './server/manager.js';
import { Artifacts, csv } from './server/artifacts.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    connections: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'pnpm bench [--config bench.json] [--connections connections.local.json] [--out results]\nWithout a config: heuristic vs seeded random, 5 seeds, swapped sides, decision mode until top-out (no turn limit).',
  );
  process.exit(0);
}
const config = BenchConfigSchema.parse(
  values.config
    ? JSON.parse(await readFile(values.config, 'utf8'))
    : { models: ['heuristic', 'random'] },
);
const output = resolve(values.out ?? process.env.RESULTS_DIR ?? 'results');
const manager = new Manager(new Artifacts(output));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => manager.cancel());
let failed = false;
const reported = new Set<string>();
manager.on('state', (s) => {
  if (s?.status === 'finished' && !reported.has(s.id)) {
    reported.add(s.id);
    console.log(
      `${s.id} ${s.config.players.join(' vs ')} seed=${s.config.seed} ${s.reason} winner=${s.winner === null ? 'draw' : s.winner + 1}`,
    );
    if (['model_failure', 'execution_failure'].includes(s.reason)) failed = true;
  }
});
try {
  const idle = once(manager, 'idle');
  manager.bench(config, await loadProfiles(values.connections));
  await idle;
  if (manager.error) throw new Error(manager.error);
  const summaries = await manager.artifacts.list();
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'results.csv'), csv(summaries));
  console.log(`Results: ${output}`);
} catch (error) {
  failed = true;
  console.error(`Benchmark failed: ${safeError(error)}`);
} finally {
  await manager.close();
}
process.exitCode = failed ? 1 : 0;
