// The mark: a parcel tag with a tick for "approved", on a glowing tile; eBay's four colours as the tag's
// stripe, each one a state of a change (red decide, blue information, yellow held, green applied).

export function Logo({ size = 32, title = "EBayManager" }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label={title} class="logo" style={{ flex: "none" }}>
      <defs>
        <linearGradient id="logo-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#6d97ff" />
          <stop offset="1" stop-color="#2f5bff" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#logo-tile)" />
      <rect x="0.5" y="0.5" width="47" height="47" rx="12.5" fill="none" stroke="rgba(255,255,255,.28)" />
      <path d="M17 10h12l7 7v17a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3z" fill="#fff" />
      <circle cx="29.5" cy="16.5" r="2" fill="#2f5bff" />
      <path d="M18.5 24.5l4 4 7.5-7.5" fill="none" stroke="#2f5bff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      <rect x="14" y="32" width="5.5" height="5" fill="#e53238" />
      <rect x="19.5" y="32" width="5.5" height="5" fill="#0064d2" />
      <rect x="25" y="32" width="5.5" height="5" fill="#f5af02" />
      <rect x="30.5" y="32" width="5.5" height="5" fill="#86b817" />
    </svg>
  );
}
