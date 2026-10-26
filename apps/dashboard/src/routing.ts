/** Presentation-only ownership; all other hashes retain the legacy WorkKey route. */
export const destinations = ["Overview", "Work", "Executors", "System"] as const;
export type Destination = typeof destinations[number];
export function destination(hash: string): Destination {
  if (!hash || hash === "#overview") return "Overview";
  if (hash === "#executors") return "Executors";
  if (hash === "#system") return "System";
  return "Work";
}
