import { EventEmitter } from 'node:events';
import { Runner, type Snapshot } from '../core/runner.js';
import {
  schedule,
  type BenchConfig,
  type RunConfig,
  type BenchmarkState,
} from '../core/run-config.js';
import { createAgent } from '../providers/agents.js';
import type { Profile } from '../providers/config.js';
import { Artifacts } from './artifacts.js';
import { CandidatePool } from './candidates.js';
import { DEFAULT_EXPERIMENT, type Experiment } from '../core/experiment.js';
export class Manager extends EventEmitter {
  runner: Runner | null = null;
  private pool = new CandidatePool();
  private queue: RunConfig[] = [];
  private finalizing = false;
  progress = { total: 0, completed: 0, active: false };
  benchmark: BenchmarkState | null = null;
  error: string | null = null;
  constructor(readonly artifacts = new Artifacts()) {
    super();
  }
  start(config: RunConfig, profiles: Profile[], experiment: Experiment = DEFAULT_EXPERIMENT) {
    if (this.finalizing || (this.runner && this.runner.status !== 'finished'))
      throw new Error('run_in_progress');
    config = structuredClone(config);
    experiment = structuredClone(experiment);
    profiles = structuredClone(profiles).map((p) => ({
      ...p,
      model: config.modelOverrides[p.id] ?? p.model,
    }));
    this.error = null;
    const agents = config.players.map((id) =>
      ['human', 'none'].includes(id) ? null : createAgent(id, profiles, config.seed),
    ) as ConstructorParameters<typeof Runner>[1];
    const runner = new Runner(
      config,
      agents,
      (event) => {
        if (event.type === 'state') {
          this.artifacts.record(event);
          this.emit('state', event.snapshot);
          if (event.snapshot.status === 'finished') {
            this.finalizing = true;
            void this.finished(profiles, experiment);
          }
        } else this.artifacts.decision(runner.id, event);
      },
      this.pool.compute,
      experiment.prompts,
    );
    this.runner = runner;
    if (this.progress.active && this.benchmark) this.benchmark.currentRunId = runner.id;
    this.artifacts.metadata(
      runner.id,
      profiles.filter((p) => config.players.includes(p.id)),
      { ...experiment, timeoutMs: config.timeoutMs, attempts: config.attempts },
    );
    runner.start();
    return runner.snapshot();
  }
  bench(config: BenchConfig, profiles: Profile[], experiment: Experiment = DEFAULT_EXPERIMENT) {
    if (
      this.finalizing ||
      this.progress.active ||
      (this.runner && this.runner.status !== 'finished')
    )
      throw new Error('run_in_progress');
    // Validate every participant before starting any paid calls.
    for (const id of config.models)
      createAgent(
        id,
        profiles.map((p) => ({ ...p, model: config.run.modelOverrides[p.id] ?? p.model })),
        'preflight',
      );
    this.queue = schedule(structuredClone(config));
    this.benchmark = { config: structuredClone(config), status: 'running', currentRunId: null };
    this.progress = { total: this.queue.length, completed: 0, active: true };
    return this.start(this.queue.shift()!, profiles, experiment);
  }
  private async finished(profiles: Profile[], experiment: Experiment) {
    try {
      await this.artifacts.flush();
    } catch {
      this.error = 'artifact_write_failed';
      this.queue = [];
      this.progress.active = false;
      if (this.benchmark?.status === 'running') this.benchmark.status = 'failed';
    }
    this.finalizing = false;
    if (this.progress.active) {
      this.progress.completed++;
      const next = this.queue.shift();
      if (next) {
        this.start(next, profiles, experiment);
        return;
      }
      this.progress.active = false;
      if (this.benchmark) this.benchmark.status = 'completed';
    }
    this.emit('state', this.runner?.snapshot());
    this.emit('idle');
  }
  cancel() {
    if (this.benchmark?.status === 'running') this.benchmark.status = 'cancelled';
    this.queue = [];
    this.progress.active = false;
    this.runner?.stop();
  }
  snapshot(): Snapshot | null {
    return this.runner?.snapshot() ?? null;
  }
  async close() {
    this.cancel();
    this.pool.close();
    await this.artifacts.flush();
  }
}
