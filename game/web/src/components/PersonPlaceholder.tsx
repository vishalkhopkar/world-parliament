/** Gender-neutral placeholder portrait: head and shoulders on a soft background. */
export function PersonPlaceholder({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 70" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Candidate photo placeholder">
      <rect width="100" height="70" fill="#dfe7de" />
      <path d="M12 70c0-17 14-27 38-27s38 10 38 27z" fill="#8fa89a" />
      <circle cx="50" cy="27" r="14" fill="#a9bdb1" />
    </svg>
  );
}
