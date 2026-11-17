/**
 * Lookup tables from the tracker workbook (problem type -> discipline, site code -> facility and zone).
 * Unknown values never throw: they come back as "Unmapped".
 */

export const UNMAPPED = 'Unmapped';

export interface LookupsJson {
  site_to_facility_zone?: Record<string, { zone?: string; facility?: string; group?: string; site_name?: string }>;
  problem_type_to_discipline?: Record<string, string>;
}

export interface Lookups {
  discipline: Map<string, string>;
  site: Map<string, { facility: string; zone: string }>;
}

const key = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

let current: Lookups = { discipline: new Map(), site: new Map() };

/** Build lookup tables from the JSON of `assets/tracker-lookups.json`. Also becomes the default for the helpers below. */
export function loadLookups(json: unknown): Lookups {
  const j = (json ?? {}) as LookupsJson;
  const discipline = new Map<string, string>();
  for (const [k, v] of Object.entries(j.problem_type_to_discipline ?? {})) {
    if (typeof v === 'string' && v.trim()) discipline.set(key(k), v.trim());
  }
  const site = new Map<string, { facility: string; zone: string }>();
  for (const [k, v] of Object.entries(j.site_to_facility_zone ?? {})) {
    // Three sites have an empty "zone" but a filled "group" (= the zone name): the group is used then, because the
    // workbook's zone totals (446 + 523 + 266 = 1,235) leave no room for an unmapped zone.
    const zone = (v?.zone || v?.group || '').trim();
    const facility = (v?.facility || '').trim();
    site.set(key(k), { facility: facility || UNMAPPED, zone: zone || UNMAPPED });
  }
  current = { discipline, site };
  return current;
}

export function currentLookups(): Lookups {
  return current;
}

/** Discipline for a Problem Type (case-insensitive, e.g. "CIVI", "CAPM|ELEC"). Unknown -> "Unmapped". */
export function disciplineFor(problemType: unknown, lookups: Lookups = current): string {
  return lookups.discipline.get(key(problemType)) ?? UNMAPPED;
}

/** Facility and zone for a Site Code. Unknown -> "Unmapped" for both. */
export function facilityZoneFor(siteCode: unknown, lookups: Lookups = current): { facility: string; zone: string } {
  return lookups.site.get(key(siteCode)) ?? { facility: UNMAPPED, zone: UNMAPPED };
}
