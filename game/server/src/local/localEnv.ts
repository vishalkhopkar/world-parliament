import type { MapConfig } from '@hp/shared';
import { makeRegistryMapProvider } from '../core/maps';

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * Apply HP_CAMPAIGN_MS / HP_COUNTING_MS / HP_COUNTING_MS_2P / HP_POST_MS / HP_GRACE_MS on top of a MapConfig (for short
 * local games). A short HP_COUNTING_MS also shortens the 2-player counting (to at most that) unless HP_COUNTING_MS_2P is given.
 */
export function applyEnvOverrides(cfg: MapConfig, env: NodeJS.ProcessEnv = process.env): MapConfig {
  const countingMs = num(env.HP_COUNTING_MS);
  return {
    ...cfg,
    durations: {
      ...cfg.durations,
      campaignMs: num(env.HP_CAMPAIGN_MS) ?? cfg.durations.campaignMs,
      countingMs: countingMs ?? cfg.durations.countingMs,
      countingMsTwoPlayers: num(env.HP_COUNTING_MS_2P)
        ?? (countingMs !== undefined ? Math.min(countingMs, cfg.durations.countingMsTwoPlayers) : cfg.durations.countingMsTwoPlayers),
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
