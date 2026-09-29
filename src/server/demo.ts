import type { Profile } from '../providers/config.js';
import { publicProfile } from '../providers/config.js';

export type DemoMode = { models: [string, string] };

export function createDemoMode(value: string | undefined, profiles: Profile[]): DemoMode | null {
  if (!value?.trim()) return null;
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length !== 2 || entries.some((entry) => !entry))
    throw new Error(
      'DEMO_MODELS must contain exactly two registered model IDs, separated by a comma',
    );
  const models = entries.map((entry) => {
    const exact = profiles.find((profile) => profile.id === entry);
    const matches = exact ? [exact] : profiles.filter((profile) => profile.model === entry);
    if (matches.length !== 1 || !publicProfile(matches[0]).available)
      throw new Error(`DEMO_MODELS entry must identify one enabled, available model: ${entry}`);
    return matches[0].id;
  });
  if (models[0] === models[1]) throw new Error('DEMO_MODELS must identify two different models');
  return { models: models as [string, string] };
}

export function isDemoPair(demo: DemoMode, models: string[]) {
  return (
    models.length === 2 &&
    new Set(models).size === 2 &&
    models.every((id) => demo.models.includes(id))
  );
}
