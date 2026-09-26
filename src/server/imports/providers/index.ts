import { leverProvider } from '@/server/imports/providers/lever';
import { greenhouseProvider } from '@/server/imports/providers/greenhouse';
import { ashbyProvider } from '@/server/imports/providers/ashby';
import { workableProvider } from '@/server/imports/providers/workable';
import { teamtailorProvider } from '@/server/imports/providers/teamtailor';
import { recruiteeProvider } from '@/server/imports/providers/recruitee';
import { bamboohrProvider } from '@/server/imports/providers/bamboohr';
import { jazzhrProvider } from '@/server/imports/providers/jazzhr';
import { smartrecruitersProvider } from '@/server/imports/providers/smartrecruiters';
import { pinpointProvider } from '@/server/imports/providers/pinpoint';
import { mergeProvider } from '@/server/imports/providers/merge';
import type { ProviderModule } from '@/server/imports/types';

/** Every importable ATS, keyed by id. Metadata for the UI lives in src/lib/import-providers.ts. */
const PROVIDERS: Record<string, ProviderModule> = {
  [leverProvider.id]: leverProvider,
  [greenhouseProvider.id]: greenhouseProvider,
  [ashbyProvider.id]: ashbyProvider,
  [workableProvider.id]: workableProvider,
  [teamtailorProvider.id]: teamtailorProvider,
  [recruiteeProvider.id]: recruiteeProvider,
  [bamboohrProvider.id]: bamboohrProvider,
  [jazzhrProvider.id]: jazzhrProvider,
  [smartrecruitersProvider.id]: smartrecruitersProvider,
  [pinpointProvider.id]: pinpointProvider,
  [mergeProvider.id]: mergeProvider,
};

export function getProvider(id: string): ProviderModule | undefined {
  return PROVIDERS[id];
}

/** Test seam: make a provider module resolvable by id (adapter test harness only). */
export function registerProviderForTests(mod: ProviderModule) {
  PROVIDERS[mod.id] = mod;
}
