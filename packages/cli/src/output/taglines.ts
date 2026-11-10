interface HolidayTagline {
  month: number;
  day: number;
  range?: number; // days before/after to show
  tagline: string;
}

const HOLIDAY_TAGLINES: HolidayTagline[] = [
  { month: 1, day: 1, range: 1, tagline: "New year, new keys, same cloud." },
  { month: 2, day: 14, tagline: "We love your data as much as you do." },
  { month: 3, day: 14, tagline: "3.14159 reasons to scope access." },
  { month: 5, day: 4, tagline: "May the fourth be with your keys." },
  { month: 10, day: 31, tagline: "No tricks: review the scopes you grant." },
  { month: 12, day: 25, range: 2, tagline: "Unwrap your data, not your keys." },
  { month: 12, day: 31, tagline: "New resolutions, deliberate permissions." },
];

const TAGLINES = [
  // Professional
  "Your data, your space, your app permissions.",
  "User-controlled access for interoperable apps.",
  "One data layer for your apps and agents.",
  "Capability-based access, not encryption.",
  "Agents get the scopes you approve.",
  "Hosted storage is plaintext at rest, not end-to-end encrypted.",
  "Shared data spaces with scoped access.",
  "Access control does not hide data from the host.",
  "Storage and key custody: docs.tinycloud.xyz/concepts/security-and-trust",
  "Review the trust boundary before sharing secrets.",
  // Playful / nerdy
  "UCAN do anything.",
  "Keys generated, delegations granted, data liberated.",
  "Decentralized storage, centralized vibes.",
  "Read the trust model, then delegate.",
  "sudo make me a sandwich, with scoped access.",
  "Have you tried turning your keys off and on again?",
  "All your base are belong to you.",
  "In UCAN we trust.",
  "Know the scope before you grant it.",
  "Capabilities connect your apps.",
];

function getHolidayTagline(): string | null {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  for (const h of HOLIDAY_TAGLINES) {
    const range = h.range ?? 0;
    if (h.month === month && Math.abs(day - h.day) <= range) {
      return h.tagline;
    }
  }
  return null;
}

export function pickTagline(): string {
  const holiday = getHolidayTagline();
  if (holiday) return holiday;
  return TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
}
