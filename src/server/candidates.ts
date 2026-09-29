import { Worker } from 'node:worker_threads';
import type { Compute } from '../core/runner.js';
import type { Game } from '../core/engine.js';
import type { Candidate } from '../core/types.js';

type Job = {
  game: Game;
  signal: AbortSignal;
  resolve: (items: Candidate[]) => void;
  reject: (e: unknown) => void;
};
/** Persistent, bounded workers keep candidate search off the simulation clock. */
export class CandidatePool {
  private queue: Job[] = [];
  private workers: { worker: Worker; job: Job | null }[] = [];
  private closed = false;
  constructor(size = 2) {
    const dev = import.meta.url.endsWith('.ts');
    const module = new URL(`../core/ai-candidates.${dev ? 'ts' : 'js'}`, import.meta.url).href;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(
        `const {parentPort}=require('node:worker_threads');(async()=>{const {buildCandidates}=${dev ? `await (await import('tsx/esm/api')).tsImport(${JSON.stringify(module)},${JSON.stringify(import.meta.url)})` : `await import(${JSON.stringify(module)})`};parentPort.on('message',game=>{try{parentPort.postMessage({items:buildCandidates(game)});}catch{parentPort.postMessage({error:true});}});})();`,
        { eval: true },
      );
      const slot = { worker, job: null as Job | null };
      this.workers.push(slot);
      worker.on('message', (data) => {
        const job = slot.job;
        slot.job = null;
        if (job) {
          if (job.signal.aborted) job.reject(job.signal.reason);
          else if (data.error) job.reject(new Error('candidate_failure'));
          else job.resolve(data.items);
        }
        this.drain();
      });
      worker.on('error', () => {
        slot.job?.reject(new Error('candidate_worker_failure'));
        slot.job = null;
        this.close();
      });
    }
  }
  compute: Compute = (game, signal) =>
    new Promise((resolve, reject) => {
      if (this.closed || signal.aborted) {
        reject(signal.reason ?? new Error('candidate_pool_closed'));
        return;
      }
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      this.queue.push({
        game,
        signal,
        resolve: (items) => {
          signal.removeEventListener('abort', abort);
          resolve(items);
        },
        reject: (e) => {
          signal.removeEventListener('abort', abort);
          reject(e);
        },
      });
      this.drain();
    });
  private drain() {
    for (const slot of this.workers) {
      if (slot.job) continue;
      let job: Job | undefined;
      while ((job = this.queue.shift()) && job.signal.aborted) job.reject(job.signal.reason);
      if (job) {
        slot.job = job;
        slot.worker.postMessage(job.game);
      }
    }
  }
  close() {
    this.closed = true;
    for (const job of this.queue) job.reject(new Error('candidate_pool_closed'));
    this.queue = [];
    for (const slot of this.workers) {
      slot.job?.reject(new Error('candidate_pool_closed'));
      void slot.worker.terminate();
    }
    this.workers = [];
  }
}
