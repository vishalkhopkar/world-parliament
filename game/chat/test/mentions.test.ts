import { describe, expect, it } from 'vitest';
import { findMentions, insertMention, mentionQuery, splitMentions } from '../common';

const people = [
  { id: 'a', name: 'Lotus Front' },
  { id: 'b', name: 'Blue' },
  { id: 'c', name: 'Blue Anchor' },
  { id: 'd', name: 'Green Leaf' },
];

describe('findMentions: "@Party name" in the text tags that party', () => {
  it('finds each tagged party once, in order of first appearance, case-insensitively', () => {
    expect(findMentions('@green leaf and @Lotus Front, then @Green Leaf again', people)).toEqual(['d', 'a']);
  });

  it('prefers the longest party name at an @ ("@Blue Anchor" is not "@Blue")', () => {
    expect(findMentions('hi @Blue Anchor', people)).toEqual(['c']);
    expect(findMentions('hi @Blue!', people)).toEqual(['b']);
  });

  it('needs a word boundary after the name and an @ before it', () => {
    expect(findMentions('@Blue Anchorage is not a party', people)).toEqual(['b']);
    expect(findMentions('@Bluebird', people)).toEqual([]);
    expect(findMentions('Green Leaf without the at sign', people)).toEqual([]);
    expect(findMentions('mail me at x@Green Leaf', people)).toEqual([]);
  });

  it('leaves out the sender when given', () => {
    expect(findMentions('@Lotus Front @Green Leaf', people, 'a')).toEqual(['d']);
  });

  it('works with nothing to find', () => {
    expect(findMentions('', people)).toEqual([]);
    expect(findMentions('@', people)).toEqual([]);
    expect(findMentions('@Green Leaf', [])).toEqual([]);
  });
});

describe('splitMentions: text pieces for display, tagged names marked', () => {
  it('marks the tagged names and keeps the rest as plain text', () => {
    expect(splitMentions('Hi @Green Leaf, ok?', people)).toEqual([
      { text: 'Hi ' }, { text: '@Green Leaf', mention: 'd' }, { text: ', ok?' },
    ]);
  });
  it('only marks the ids given when a list is passed (what the server found)', () => {
    expect(splitMentions('@Blue and @Green Leaf', people, ['d'])).toEqual([
      { text: '@Blue and ' }, { text: '@Green Leaf', mention: 'd' },
    ]);
  });
  it('plain text stays one piece', () => {
    expect(splitMentions('nothing here', people)).toEqual([{ text: 'nothing here' }]);
  });
});

describe('mentionQuery / insertMention: the @ picker while typing', () => {
  it('reports the word being typed after an @ at the caret', () => {
    expect(mentionQuery('hello @gr', 9)).toEqual({ start: 6, query: 'gr' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('hi @Blue An', 11)).toEqual({ start: 3, query: 'Blue An' });
  });
  it('is null when the caret is not in an @ word', () => {
    expect(mentionQuery('hello', 5)).toBeNull();
    expect(mentionQuery('mail x@y', 8)).toBeNull();
    expect(mentionQuery('@a b c d e f', 12)).toBeNull(); // more than 4 spaces since the @: not a name being typed
  });
  it('replaces the typed @word with "@Name " and puts the caret after it', () => {
    expect(insertMention('hi @gr there', 3, 6, 'Green Leaf')).toEqual({ text: 'hi @Green Leaf there', caret: 15 }); // no double space
    expect(insertMention('@', 0, 1, 'Blue')).toEqual({ text: '@Blue ', caret: 6 });
  });
});
