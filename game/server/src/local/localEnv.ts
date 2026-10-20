import type { MapConfig } from '@hp/shared';
import { makeRegistryMapProvider } from '../core/maps';

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Apply HP_CAMPAIGN_MS / HP_COUNTING_MS / HP_POST_MS / HP_GRACE_MS on top of a MapConfig (for short local games). */
export function applyEnvOverrides(cfg: MapConfig, env: NodeJS.ProcessEnv = process.env): MapConfig {
  return {
    ...cfg,
    durations: {
      campaignMs: num(env.HP_CAMPAIGN_MS) ?? cfg.durations.campaignMs,
      countingMs: num(env.HP_COUNTING_MS) ?? cfg.durations.countingMs,
      postCountingMs: num(env.HP_POST_MS) ?? cfg.durations.postCountingMs,
      graceMs: num(env.HP_GRACE_MS) ?? cfg.durations.graceMs,
    },
  };
}

/** All maps from the generated registry (maps/<id>/), with the HP_*_MS duration overrides applied. */
export function loadLocalMaps(env: NodeJS.ProcessEnv = process.env) {
  return makeRegistryMapProvider(cfg => applyEnvOverrides(cfg, env));
}

export const startDelayFromEnv = (env: NodeJS.ProcessEnv = process.env): number => num(env.HP_START_DELAY_MS) ?? 5000;
