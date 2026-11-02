// The mark: a parcel tag, its eyelet, a tick for "approved", and eBay's four colours as the tag's stripe,
// each colour one state of a change (red: decide, blue: information, yellow: held, green: applied).

export function Logo({ size = 32, title = "EBayManager" }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label={title} class="logo">
      <path d="M14 4h20l10 10v26a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" fill="var(--ink)" />
      <circle cx="35" cy="13" r="3.2" fill="var(--ground)" />
      <path d="M17 24.5l5.5 5.5L33 19.5" fill="none" stroke="var(--paper)" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round" />
      <rect x="10" y="36" width="8.5" height="5" fill="var(--red)" />
      <rect x="18.5" y="36" width="8.5" height="5" fill="var(--blue)" />
      <rect x="27" y="36" width="8.5" height="5" fill="var(--yellow)" />
      <rect x="35.5" y="36" width="8.5" height="5" fill="var(--green)" />
    </svg>
  );
}
