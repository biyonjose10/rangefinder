/**
 * Open-Meteo — cloud cover, wind and rainfall for an area.
 *
 * Two distinct jobs, both of which the application got wrong by omission.
 *
 * **Observability.** Thermal sensors cannot see through thick cloud. In the
 * tropical wet season an area can go unobserved for days, and the interface
 * would render a calm, empty map — quietly implying nothing is happening when
 * the truth is that nothing could be *seen*. Reporting absence of evidence as
 * evidence of absence is the same failure as the NDVI figure that had to be
 * retracted, and it is more dangerous here because a quiet map invites a crew
 * to stand down.
 *
 * **Trafficability.** A patrol planned for tomorrow is driven on tomorrow's
 * roads. Recent and forecast rainfall is the difference between a four-hour
 * drive on an unsealed track and one that cannot be attempted at all.
 *
 * Keyless, no signup, no rate limit worth worrying about.
 * Licence: CC BY 4.0 — https://open-meteo.com/
 */

export interface AreaWeather {
  /** Percentage cloud cover over the area right now. */
  cloudCoverPct: number;
  windSpeedKmh: number;
  windDirectionDeg: number;
  /** Rain in the last 24 h, mm. */
  rainRecentMm: number;
  /** Forecast rain over the next three days, mm per day. */
  rainForecastMm: number[];
  /** True when cloud is heavy enough that detections are probably incomplete. */
  observationLimited: boolean;
  fetchedAt: string;
}

/** Above this, treat the absence of detections as uninformative. */
const CLOUD_BLIND_THRESHOLD = 70;

export async function fetchAreaWeather(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<AreaWeather | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}` +
    `&longitude=${lon.toFixed(3)}` +
    `&current=cloud_cover,wind_speed_10m,wind_direction_10m` +
    `&daily=precipitation_sum&past_days=1&forecast_days=4&timezone=UTC`;

  try {
    const res = await fetch(url, { signal, next: { revalidate: 1800 } });
    if (!res.ok) return null;

    const d = (await res.json()) as {
      current?: {
        cloud_cover?: number;
        wind_speed_10m?: number;
        wind_direction_10m?: number;
      };
      daily?: { precipitation_sum?: (number | null)[] };
    };

    const cloud = d.current?.cloud_cover ?? 0;
    const rain = (d.daily?.precipitation_sum ?? []).map((v) => v ?? 0);

    return {
      cloudCoverPct: cloud,
      windSpeedKmh: d.current?.wind_speed_10m ?? 0,
      windDirectionDeg: d.current?.wind_direction_10m ?? 0,
      // past_days=1 puts yesterday first.
      rainRecentMm: rain[0] ?? 0,
      rainForecastMm: rain.slice(1, 4),
      observationLimited: cloud >= CLOUD_BLIND_THRESHOLD,
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    // Weather is context, not a dependency. Losing it must not take the
    // patrol queue down with it.
    return null;
  }
}

/** Plain-language note for the interface and the printed order. */
export function weatherNote(w: AreaWeather, detections: number): string | null {
  if (w.observationLimited) {
    return (
      `${Math.round(w.cloudCoverPct)}% cloud over this area — satellite coverage is ` +
      `limited, so ${detections === 0 ? "an empty queue does not mean nothing is burning" : "this list is probably incomplete"}.`
    );
  }

  const soon = w.rainForecastMm.reduce((a, b) => a + b, 0);
  if (soon >= 25) {
    return `${Math.round(soon)} mm of rain forecast over the next three days — unsealed tracks may become impassable.`;
  }
  if (w.rainRecentMm >= 20) {
    return `${Math.round(w.rainRecentMm)} mm of rain in the last 24 h — expect soft ground on approach.`;
  }
  return null;
}
