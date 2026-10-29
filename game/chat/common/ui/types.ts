import type { ReactNode } from 'react';
import type { PlayerId } from '@hp/shared';

/** A party as the chat shows it. The app decides the name (party name, never a nickname), colour and subtitle. */
export interface ChatPerson {
  id: PlayerId;
  name: string;
  /** Hex colour: the fallback avatar and the tag highlight. */
  colour?: string;
  /** Small line under the name in the conversation list (e.g. "120 seats"). */
  subtitle?: string;
}

/** Draws a party's avatar; without it the chat shows the party's initial on its colour. */
export type AvatarRenderer = (id: PlayerId, size: number) => ReactNode;
