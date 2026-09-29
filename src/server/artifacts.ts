import { mkdir, readFile, readdir, appendFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { RunEvent, Snapshot } from '../core/runner.js';
import type { Profile } from '../providers/config.js';
import { POLICY_VERSION } from '../core/policy.js';
import { DEFAULT_EXPERIMENT, type Experiment } from '../core/experiment.js';
import { redactParameters } from '../providers/model-settings.js';
import { OUTPUT_INSTRUCTION } from '../providers/agents.js';

export type RecordedMatch = Snapshot & { createdAt: string };

export class Artifacts {
  private tasks = Promise.resolve();
  private failed: unknown;
  constructor(readonly root = 'results') {}
  record(event: RunEvent) {
    this.tasks = this.tasks
      .then(async () => {
        if (event.type === 'state') {
          const folder = join(this.root, event.snapshot.id);
          await mkdir(folder, { recursive: true });
          await appendFile(join(folder, 'events.jsonl'), JSON.stringify(event) + '\n');
          if (event.snapshot.status === 'finished')
            await writeFile(
              join(folder, 'summary.json'),
              JSON.stringify(event.snapshot, null, 2) + '\n',
            );
        }
      })
      .catch((e) => {
        this.failed = e;
      });
  }
  decision(id: string, event: RunEvent) {
    this.tasks = this.tasks
      .then(() => appendFile(join(this.root, id, 'events.jsonl'), JSON.stringify(event) + '\n'))
      .catch((e) => {
        this.failed = e;
      });
  }
  metadata(id: string, profiles: Profile[], experiment: Experiment = DEFAULT_EXPERIMENT) {
    this.tasks = this.tasks
      .then(async () => {
        await mkdir(join(this.root, id), { recursive: true });
        // Preserve the experiment, never provider credentials or response reasoning.
        await writeFile(
          join(this.root, id, 'metadata.json'),
          JSON.stringify(
            {
              artifactVersion: 2,
              engineVersion: '0.1.0',
              policyVersion: POLICY_VERSION,
              promptHash: createHash('sha256')
                .update(
                  JSON.stringify([
                    experiment.prompts,
                    OUTPUT_INSTRUCTION,
                    profiles.map((p) => [p.id, p.additionalInstructions]),
                  ]),
                )
                .digest('hex'),
              node: process.version,
              aiSdk: '7.0.122',
              createdAt: new Date().toISOString(),
              experiment,
              llmOutputInstruction: OUTPUT_INSTRUCTION,
              connections: profiles.map((p) => ({
                id: p.id,
                provider: p.provider,
                model: p.model,
                api: p.provider === 'openrouter-decisions' ? 'decisions' : 'llm',
                reasoning: p.provider === 'openrouter-decisions' ? null : p.reasoning,
                output: p.provider === 'openrouter-decisions' ? null : p.output,
                additionalInstructions: p.additionalInstructions,
                generation: p.provider === 'openrouter-decisions' ? null : p.generation,
                providerOptions:
                  p.provider === 'openrouter-decisions'
                    ? null
                    : redactParameters(p.providerOptions),
                requestBody: redactParameters(p.requestBody),
                requestSettingsHash: createHash('sha256')
                  .update(
                    JSON.stringify([
                      p.reasoning,
                      p.output,
                      p.generation,
                      p.providerOptions,
                      p.requestBody,
                    ]),
                  )
                  .digest('hex'),
                endpointHash: p.baseURL
                  ? createHash('sha256').update(p.baseURL).digest('hex')
                  : null,
                optionsHash: createHash('sha256')
                  .update(JSON.stringify(p.providerOptions))
                  .digest('hex'),
              })),
            },
            null,
            2,
          ) + '\n',
        );
      })
      .catch((e) => {
        this.failed = e;
      });
  }
  async flush() {
    await this.tasks;
    if (this.failed) throw new Error('artifact_write_failed');
  }
  async list(
    options: { models?: [string, string]; offset?: number; limit?: number } = {},
  ): Promise<RecordedMatch[]> {
    await this.flush();
    await mkdir(this.root, { recursive: true });
    const result: RecordedMatch[] = [];
    const entries = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !this.validId(entry.name)) continue;
      try {
        const info = await stat(join(this.root, entry.name, 'summary.json'));
        let time = info.mtimeMs;
        try {
          const metadata = JSON.parse(await this.read(entry.name, 'metadata.json'));
          const created = Date.parse(metadata.createdAt);
          if (Number.isFinite(created)) time = created;
        } catch {
          // Older recordings may have no creation metadata.
        }
        entries.push({ id: entry.name, time });
      } catch {
        /* In-progress runs have no summary. */
      }
    }
    entries.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
    let skipped = 0;
    for (const entry of entries) {
      try {
        const summary: Snapshot = JSON.parse(await this.read(entry.id, 'summary.json'));
        if (summary.status !== 'finished') continue;
        if (
          options.models &&
          (new Set(summary.config.players).size !== 2 ||
            !summary.config.players.every((id) => options.models!.includes(id)))
        )
          continue;
        if (skipped++ < (options.offset ?? 0)) continue;
        result.push({ ...summary, createdAt: new Date(entry.time).toISOString() });
        if (options.limit !== undefined && result.length >= options.limit) break;
      } catch {
        /* Skip incomplete or unreadable recordings without hiding the rest. */
      }
    }
    return result;
  }
  validId(id: string) {
    return /^[a-f0-9-]{36}$/.test(id);
  }
  async read(id: string, file: string) {
    if (!this.validId(id) || !['summary.json', 'events.jsonl', 'metadata.json'].includes(file))
      throw new Error('invalid_artifact');
    const path = join(this.root, id, file);
    if ((await stat(path)).size > 64 * 1024 * 1024) throw new Error('artifact_too_large');
    return readFile(path, 'utf8');
  }
}
export function csv(summaries: Snapshot[]): string {
  const rows = [
    [
      'run',
      'mode',
      'seed',
      'player',
      'connection',
      'outcome',
      'reason',
      'placements',
      'lines',
      'tetrises',
      'sent',
      'attack_per_placement',
      'calls',
      'valid',
      'failures',
      'p50_ms',
      'p95_ms',
      'cost',
    ],
  ];
  for (const s of summaries)
    for (let p = 0; p < 2; p++) {
      if (s.config.players[p] === 'none') continue;
      const t = s.stats[p];
      const outcome = ['model_failure', 'execution_failure', 'artifact_failure'].includes(
        s.reason ?? '',
      )
        ? 'failed'
        : s.reason === 'cancelled'
          ? 'cancelled'
          : s.winner === null
            ? 'draw'
            : s.winner === p
              ? 'win'
              : 'loss';
      rows.push([
        s.id,
        s.config.mode,
        s.config.seed,
        String(p + 1),
        s.config.players[p],
        outcome,
        s.reason ?? '',
        String(t.placements),
        String(s.games[p].lines),
        String(t.tetrises),
        String(t.sent),
        String(t.placements ? t.sent / t.placements : 0),
        String(t.calls),
        String(t.valid),
        String(t.failures),
        String(t.p50Ms ?? ''),
        String(t.p95Ms ?? ''),
        String(t.cost ?? ''),
      ]);
    }
  return (
    rows
      .map((row) =>
        row
          .map((cell) => `"${(/^[=+@\-]/.test(cell) ? "'" : '') + cell.replaceAll('"', '""')}"`)
          .join(','),
      )
      .join('\n') + '\n'
  );
}
