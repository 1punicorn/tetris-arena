import { z } from 'zod';
export const RunConfigSchema = z
  .object({
    mode: z.enum(['realtime', 'decision']).default('realtime'),
    players: z
      .tuple([z.string().min(1).max(64), z.string().min(1).max(64)])
      .default(['heuristic', 'random']),
    modelOverrides: z.record(z.string().max(64), z.string().min(1).max(256)).default({}),
    seed: z.string().min(1).max(100).default('1'),
    maxSeconds: z.number().int().min(1).max(600).default(180),
    maxTurns: z.number().int().min(1).max(2000).default(500),
    timeoutMs: z.number().int().min(100).max(120000).default(30000),
    attempts: z.number().int().min(1).max(5).default(3),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.players[0] === 'none' || value.players.filter((p) => p === 'human').length > 1)
      ctx.addIssue({ code: 'custom', message: 'One human at most; player one must participate' });
    if (value.mode === 'decision' && value.players.includes('human'))
      ctx.addIssue({ code: 'custom', message: 'Decision evaluation requires AI players' });
  });
export type RunConfig = z.infer<typeof RunConfigSchema>;
export const BenchConfigSchema = z
  .object({
    models: z.array(z.string().min(1).max(64)).min(2).max(12),
    seeds: z.array(z.string().min(1).max(100)).min(1).max(50).default(['1', '2', '3', '4', '5']),
    run: RunConfigSchema.default(RunConfigSchema.parse({ mode: 'decision' })),
  })
  .strict()
  .refine(
    (c) =>
      new Set(c.models).size === c.models.length &&
      !c.models.some((m) => ['human', 'none'].includes(m)),
    'Use distinct AI connections',
  );
export type BenchConfig = z.infer<typeof BenchConfigSchema>;
export function schedule(config: BenchConfig): RunConfig[] {
  const runs: RunConfig[] = [];
  for (let a = 0; a < config.models.length; a++)
    for (let b = a + 1; b < config.models.length; b++)
      for (const seed of config.seeds) {
        const pair: [string, string] = [config.models[a], config.models[b]];
        runs.push(
          { ...config.run, seed, players: pair },
          { ...config.run, seed, players: [pair[1], pair[0]] },
        );
      }
  return runs;
}
