import type { MeResponse } from '@aderratech/contracts/sync';

/** True when running in Azure (App Service sets this on every instance). */
export const inAzure = (): boolean => Boolean(process.env.WEBSITE_INSTANCE_ID);

/**
 * Local development only: accept "dev:" session tokens instead of App Service
 * authentication. Refused in Azure even if the setting is copied there.
 */
export function devAuthEnabled(): boolean {
  return process.env.ADERRA_DEV_AUTH === '1' && !inAzure();
}

function int(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? value : fallback;
}

/** Sent with /me and /changes (PLAN.md §9.6, §26). */
export function clientConfig(): MeResponse['config'] {
  return {
    min_app_build: int('MIN_APP_BUILD', 1),
    flags: {
      on_device_heard_signs: false,
      photos_on_mobile_data_default: true,
      owner_ok_audio: true,
      bird_photos: true,
      nearby_farms: false,
      officer_smallholder: true,
    },
    limits: { max_droppings_photos: 6, max_bird_photos: 4, max_voice_seconds: 120 },
  };
}
