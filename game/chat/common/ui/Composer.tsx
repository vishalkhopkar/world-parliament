import type { KeyboardEvent, ReactNode, RefObject } from 'react';

/** The longest message the server accepts. */
export const MAX_MESSAGE = 500;

/** Text box + Send. Controlled; Enter sends (unless `onKeyDown` handled it), empty text cannot be sent. */
export function Composer({ value, onChange, onSend, placeholder, disabled, inputRef, onKeyDown, onSelect, above }: {
  value: string;
  onChange(v: string, caret: number): void;
  onSend(text: string): void;
  placeholder: string;
  disabled?: boolean;
  inputRef?: RefObject<HTMLInputElement>;
  /** Return true when the key was used (e.g. by the @ picker) so Enter does not send. */
  onKeyDown?(e: KeyboardEvent<HTMLInputElement>): boolean;
  onSelect?(caret: number): void;
  /** Shown above the text box (the @ picker). */
  above?: ReactNode;
}) {
  const send = () => { const t = value.trim(); if (t && !disabled) onSend(t); };
  return (
    <div className="hpchat-composer">
      {above}
      <input ref={inputRef} className="input hpchat-input" value={value} placeholder={placeholder} disabled={disabled} maxLength={MAX_MESSAGE}
        onChange={e => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onSelect={e => onSelect?.((e.target as HTMLInputElement).selectionStart ?? value.length)}
        onKeyDown={e => { if (onKeyDown?.(e)) return; if (e.key === 'Enter') { e.preventDefault(); send(); } }} />
      <button type="button" className="btn primary sm" disabled={disabled || !value.trim()} onClick={send}>Send</button>
    </div>
  );
}
