import { localDate, type AppState } from "../core/model";

export function dayAvailability(state: AppState, date: string) {
  return (
    state.availability?.find((item) => item.date === date) ?? {
      date,
      start: state.settings.dayStart * 60,
      end: state.settings.dayEnd * 60,
      capacity: state.settings.capacity,
    }
  );
}
export function availableMinutes(
  state: AppState,
  date: string,
  now = new Date(),
) {
  const window = dayAvailability(state, date);
  const start =
    date === localDate(now)
      ? Math.max(window.start, now.getHours() * 60 + now.getMinutes())
      : window.start;
  let used = 0;
  let end = start;
  const busy = (state.fixedTimes ?? [])
    .filter((b) => b.date === date)
    .sort((a, b) => a.start - b.start);
  for (const block of busy) {
    const from = Math.max(end, block.start, start);
    const to = Math.min(window.end, block.end);
    if (to > from) {
      used += to - from;
      end = to;
    }
  }
  return Math.max(0, Math.min(window.capacity, window.end - start - used));
}

export function planningRatio(state: AppState) {
  return (100 - (state.settings.bufferPercent ?? 20)) / 100;
}
