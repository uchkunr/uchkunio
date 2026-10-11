// Post dates are "YYYY-MM-DD". Formatting in UTC keeps the output stable
// regardless of the timezone of the machine that runs the build.

const formats = {
  long: new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }),
  short: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
  day: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
};

export type DateStyle = keyof typeof formats;

/** long: "July 1, 2026" · short: "Jul 1, 2026" · day: "Jul 1" */
export function formatDate(date: string, style: DateStyle = "short"): string {
  return formats[style].format(new Date(date));
}
