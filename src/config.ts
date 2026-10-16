import type { MeResponse } from '@aderratech/contracts/sync';

/** True when running in Azure (App Service sets this on every instance). */
export const inAzure = (): boolean => Boolean(process.env.WEBSITE_INSTANCE_ID);

/**
 * Test sign-in: accept "dev:" session tokens instead of App Service authentication. Locally with
 * ADERRA_DEV_AUTH=1. In Azure only for the interim test service, and only with ADERRA_DEV_AUTH_KEY set:
 * each request must then carry that key (identity.ts), so a token alone signs no one in.
 */
export function devAuthEnabled(): boolean {
  return process.env.ADERRA_DEV_AUTH === '1' && (!inAzure() || Boolean(devAuthKey()));
}

/** The test key the interim test app sends in X-Aderra-Test-Key; at least 32 characters, else unset. */
export function devAuthKey(): string | null {
  const key = process.env.ADERRA_DEV_AUTH_KEY ?? '';
  return key.length >= 32 ? key : null;
}

/**
 * App Service authentication strips X-MS-CLIENT-PRINCIPAL headers that callers send, but only while it is
 * on. Without it, those headers are not proof of anyone, so in Azure they count only when it is on.
 */
export function appServiceAuthOn(): boolean {
  return !inAzure() || (process.env.WEBSITE_AUTH_ENABLED ?? '').toLowerCase() === 'true';
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
