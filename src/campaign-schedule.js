// Schedule planning only: this module never sends messages.
export const CAMPAIGN_DEFAULTS = Object.freeze({
  weekdays: [1, 2, 3, 4, 5], dailyLimit: 20, startHour: 8, windowHours: 12,
});
export function validateCampaignSchedule(input = {}) {
  const schedule = { ...CAMPAIGN_DEFAULTS, ...input };
  if (!Number.isInteger(schedule.dailyLimit) || schedule.dailyLimit < 1 || schedule.dailyLimit > 20)
    throw new Error('Daily limit must be between 1 and 20.');
  if (!Number.isInteger(schedule.startHour) || schedule.startHour < 0 || schedule.startHour > 23)
    throw new Error('Start hour must be between 0 and 23.');
  if (schedule.windowHours !== 12 || schedule.startHour + schedule.windowHours > 24)
    throw new Error('Choose a 12-hour window within one local day.');
  if (!Array.isArray(schedule.weekdays) || !schedule.weekdays.length ||
      schedule.weekdays.some(d => !Number.isInteger(d) || d < 1 || d > 5))
    throw new Error('Campaign days must be Monday to Friday.');
  if (typeof schedule.timeZone !== 'string' || !schedule.timeZone.startsWith('Australia/'))
    throw new Error('Choose an Australian recipient time zone.');
  // Intl uses the zone rules for the actual date, including daylight saving.
  new Intl.DateTimeFormat('en', { timeZone: schedule.timeZone }).format(new Date());
  return { ...schedule, weekdays: [...new Set(schedule.weekdays)].sort() };
}
export function campaignSlotAt(instant, input) {
  const s = validateCampaignSchedule(input);
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid schedule date.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: s.timeZone, weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const seconds = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  const elapsed = seconds - s.startHour * 3600;
  if (!s.weekdays.includes(weekday) || elapsed < 0 || elapsed >= s.windowHours * 3600) return null;
  const slot = Math.floor(elapsed / (s.windowHours * 3600 / s.dailyLimit));
  return { localDate: `${parts.year}-${parts.month}-${parts.day}`, slot,
    key: `${s.timeZone}:${parts.year}-${parts.month}-${parts.day}:${slot}` };
}
