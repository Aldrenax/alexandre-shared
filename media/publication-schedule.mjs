const DEFAULT_DELAYS = Object.freeze({ news: 20, video: 10, guide: 120 });

function localParts(date, timeZone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return values;
}

function offsetAt(date, timeZone) {
  const parts = localParts(date, timeZone);
  const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return representedAsUtc - date.getTime();
}

function instantForLocal(parts, timeZone) {
  const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute || 0, parts.second || 0);
  let candidate = new Date(wallClock - offsetAt(new Date(wallClock), timeZone));
  candidate = new Date(wallClock - offsetAt(candidate, timeZone));
  return candidate;
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function recommendedPublicationTime(contentType, {
  now = new Date(),
  timeZone = 'Europe/Paris',
  startHour = 7,
  endHour = 21,
  delayMinutes = DEFAULT_DELAYS[contentType] ?? 20,
} = {}) {
  const candidate = new Date(now.getTime() + Math.max(0, Number(delayMinutes)) * 60_000);
  const parts = localParts(candidate, timeZone);
  if (parts.hour >= startHour && parts.hour < endHour) return candidate;
  const day = addLocalDays(parts, parts.hour >= endHour ? 1 : 0);
  return instantForLocal({ ...day, hour: startHour, minute: 0, second: 0 }, timeZone);
}

