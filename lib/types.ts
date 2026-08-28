/** A single satellite thermal/clearing detection. */
export interface Alert {
  lat: number;
  lon: number;
  acqDate: string; // YYYY-MM-DD
  acqTime: string; // HHMM UTC
  confidence: "low" | "nominal" | "high";
  frp: number; // fire radiative power, MW
  dayNight: "D" | "N";
}

/** A spatially coherent group of detections — one candidate clearing event. */
export interface Cluster {
  id: string;
  lat: number;
  lon: number;
  count: number;
  frpSum: number;
  maxConfidence: Alert["confidence"];
  firstSeen: string;
  lastSeen: string;
  /** Greatest extent of the cluster in km — a chain-linked DBSCAN cluster can be
   *  long and thin, and a ranger needs to know if "one event" is really a 30 km
   *  front rather than a single clearing. */
  spanKm: number;
  alerts: Alert[];
}

/** The factors that produced a score. Kept alongside the score so the UI and the
 *  generated patrol order can both explain *why* a target ranks where it does —
 *  a ranger will not act on a number they cannot interrogate. */
export interface ScoreBreakdown {
  confidence: number;
  extent: number;
  recency: number;
  access: number;
  protection: number;
  proximity: number;
}

export interface ScoredTarget extends Cluster {
  score: number;
  breakdown: ScoreBreakdown;
  /** Metres to the nearest mapped road or track; null when none was found
   *  within the data we hold (JSON cannot carry Infinity). */
  distanceToRoadM: number | null;
  /** Straight-line km from the ranger post. */
  distanceFromPostKm: number;
  /** Estimated one-way drive time in hours. */
  driveTimeHours: number;
  /** Name of the protected area / indigenous land this falls inside, if any. */
  protectedArea: string | null;
  /** Human-readable justification, assembled from the breakdown. */
  rationale: string[];
}

export interface RangerPost {
  name: string;
  lat: number;
  lon: number;
}

export interface ProtectedArea {
  name: string;
  nameEn?: string;
  designation?: string;
  operator?: string;
  /** Closed boundary rings in GeoJSON order ([lon, lat]). Real geometry, not a
   *  centroid-and-radius approximation — the difference decides whether we tell
   *  a ranger that a fire is inside a legally protected territory, and that
   *  claim has to be right. */
  rings: [number, number][][];
}

export interface RoadSegment {
  highway: string;
  coords: [number, number][]; // [lon, lat] pairs, GeoJSON order
}
