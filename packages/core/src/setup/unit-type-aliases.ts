/**
 * One reading of a free-text unit type against an alias table. The acuity presets and the
 * jurisdiction unit kinds both match "what the manager typed" this way; two copies of the trim,
 * lowercase and loop would drift, and a unit typed " IMCU " would be read differently by each.
 */

/** The key whose alias list holds `unitType`, matched whole after trimming and lowercasing. */
export function matchAlias<K extends string>(
  table: Partial<Record<K, readonly string[]>>,
  unitType: string,
): K | undefined {
  const key = unitType.trim().toLowerCase();
  for (const [id, aliases] of Object.entries(table) as [K, readonly string[]][]) {
    if (aliases.includes(key)) return id;
  }
  return undefined;
}
