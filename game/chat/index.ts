// @hp/chat - the HUNG PARLIAMENT chat module.
//   common/      pure logic (also exported alone as @hp/chat/common for the server) + shared UI pieces (common/ui)
//   group/       the common group chat with @-tags (mode GROUP)
//   individual/  one-to-one chats, Teams style, with offers in the conversations (mode INDV)
// The components know nothing about the game's store or network: the app passes people, messages, offers and callbacks.
export * from './common';
export type { ChatPerson, AvatarRenderer } from './common/ui/types';
export { Badge, Avatar, MessageText, Row, EventRow, clock } from './common/ui/parts';
export { ItemList, useOnScreen } from './common/ui/ItemList';
export { Composer, MAX_MESSAGE } from './common/ui/Composer';
export { GroupChat, mentionCandidates } from './group/GroupChat';
export type { GroupChatProps } from './group/GroupChat';
export { DirectChat } from './individual/DirectChat';
export type { DirectChatProps } from './individual/DirectChat';
