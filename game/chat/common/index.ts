// @hp/chat/common - the chat's pure logic (no React): safe for the server, the agent and the web app alike.
export { findMentions, splitMentions, mentionQuery, insertMention } from './mentions';
export type { Mentionable, TextPiece } from './mentions';
export { channelOf, conversationKey, groupItems, directConversations, lastActivity, unreadCount, unreadTotal } from './conversations';
export type { ChatItem } from './conversations';
