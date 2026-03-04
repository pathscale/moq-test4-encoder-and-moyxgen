const T0 = performance.now();
const DEFAULT_RELAY = "https://localhost:4433/moq";

export function diagTime(): number {
  return Math.round(performance.now() - T0);
}

export function getCountryCode(): string {
  try {
    const region = new Intl.Locale(navigator.language).region;
    if (region) return region.toLowerCase();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return (tz.split("/")[0]?.toLowerCase() ?? "xx").slice(0, 2);
  } catch {
    return "xx";
  }
}

export function getOrCreateStreamName(): string {
  const key = "moq-test4-stream-name";
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  const name = `${getCountryCode()}-${crypto.randomUUID().slice(0, 6)}`;
  localStorage.setItem(key, name);
  return name;
}

export function getOrCreateRelayUrl(): string {
  const key = "moq-test4-relay-url";
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  localStorage.setItem(key, DEFAULT_RELAY);
  return DEFAULT_RELAY;
}

/** Generate a track name prefix from date */
export function generateTrackNamePrefix(): string {
  const d = new Date();
  const pad = (n: number, len: number) => n.toString().padStart(len, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1, 2) +
    pad(d.getUTCDate(), 2) +
    pad(d.getUTCHours(), 2) +
    pad(d.getUTCMinutes(), 2) +
    pad(d.getUTCSeconds(), 2)
  );
}

/** Get or create a shared track name prefix persisted in localStorage. */
export function getOrCreateTrackNamePrefix(): string {
  const key = "moq-test4-track-prefix";
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  const prefix = generateTrackNamePrefix();
  localStorage.setItem(key, prefix);
  return prefix;
}

/** Store a new track name prefix (called by encoder on start). */
export function setTrackNamePrefix(prefix: string): void {
  localStorage.setItem("moq-test4-track-prefix", prefix);
}

/** Read the current track name prefix (called by player to discover encoder's tracks). */
export function getTrackNamePrefix(): string | null {
  return localStorage.getItem("moq-test4-track-prefix");
}

/** Build audio/video track names from a prefix */
export function getTrackNames(prefix: string) {
  return {
    audio: `${prefix}audio0`,
    video: `${prefix}video0`,
  };
}
