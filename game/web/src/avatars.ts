import { AVATARS } from '@hp/shared';

export type AvatarVariant = 'thumb' | 'full';

/** Avatar images are served at /avatars/ (vite dev middleware; copied to dist/avatars/ on build). */
export const AVATAR_BASE = '/avatars/';

export const avatarById = (id: string | undefined) => (id ? AVATARS.find(a => a.id === id) : undefined);

/** URL of an avatar image (thumb = 160 px, full = 512 px), or undefined for an unknown id. */
export function avatarUrl(id: string | undefined, variant: AvatarVariant): string | undefined {
  const a = avatarById(id);
  return a ? AVATAR_BASE + a[variant] : undefined;
}

/** The thumbnail is plenty for displays up to this many css px; bigger ones (and 2x screens) use the 512 px image. */
export const THUMB_MAX_CSS_PX = 64;
export const avatarVariantFor = (cssPx: number): AvatarVariant => (cssPx <= THUMB_MAX_CSS_PX ? 'thumb' : 'full');
