import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";

import type { RangerPost, ScoredTarget } from "../types";
import { severityLabel } from "../marker";
import { TOUR_ASSUMPTIONS, type TourPlan } from "../tour";
import { ATTRIBUTION } from "../config";

/**
 * The Patrol Dispatch Order.
 *
 * This is the point of the whole application. Everything upstream — the FIRMS
 * fetch, the clustering, the score — exists to produce a document that a
 * protected-area officer can sign, hand to a crew, and defend afterwards.
 * Accordingly it is laid out as a field order, not as a data export: numbered
 * tasks, coordinates in two notations, an explicit reason for each tasking, and
 * space to record what was actually found.
 */

const styles = StyleSheet.create({
  page: {
    paddingTop: 38,
    paddingBottom: 54,
    paddingHorizontal: 42,
    fontSize: 9.5,
    fontFamily: "Helvetica",
    color: "#111827",
    lineHeight: 1.45,
  },
  ruleTop: { borderTopWidth: 3, borderTopColor: "#166534", marginBottom: 10 },
  kicker: {
    fontSize: 7.5,
    letterSpacing: 1.6,
    color: "#166534",
    fontFamily: "Helvetica-Bold",
    marginBottom: 3,
  },
  // Both carry their own lineHeight. The page sets 1.45, which at 20pt leaves
  // the title's descenders sitting on the subtitle's ascenders — legible on a
  // screen, a smudge on a photocopied field order.
  title: { fontSize: 20, fontFamily: "Helvetica-Bold", lineHeight: 1.2, marginBottom: 4 },
  subtitle: { fontSize: 9, color: "#4b5563", lineHeight: 1.3, marginBottom: 12 },

  metaRow: { flexDirection: "row", marginBottom: 14, gap: 0 },
  metaCell: { flex: 1, paddingRight: 10 },
  metaLabel: {
    fontSize: 6.8,
    letterSpacing: 0.9,
    color: "#6b7280",
    fontFamily: "Helvetica-Bold",
    marginBottom: 2,
  },
  metaValue: { fontSize: 9, fontFamily: "Helvetica-Bold" },

  banner: {
    backgroundColor: "#f0fdf4",
    borderLeftWidth: 3,
    borderLeftColor: "#166534",
    padding: 8,
    marginBottom: 16,
  },

  sectionHead: {
    fontSize: 8,
    letterSpacing: 1.2,
    fontFamily: "Helvetica-Bold",
    color: "#166534",
    borderBottomWidth: 0.75,
    borderBottomColor: "#d1d5db",
    paddingBottom: 3,
    marginBottom: 9,
  },

  task: {
    borderWidth: 0.75,
    borderColor: "#d1d5db",
    borderLeftWidth: 3,
    borderLeftColor: "#166534",
    padding: 10,
    marginBottom: 9,
  },
  taskHead: { flexDirection: "row", justifyContent: "space-between", marginBottom: 5 },
  // A long protected-area name plus the priority and baseline annotations used
  // to run straight under the severity label. The heading wraps; the label,
  // which is the part a crew scans for, never gives up room.
  rank: { flex: 1, paddingRight: 10, fontSize: 12, fontFamily: "Helvetica-Bold", lineHeight: 1.25 },
  scorePill: {
    flexShrink: 0,
    fontSize: 8.5,
    fontFamily: "Helvetica-Bold",
    color: "#166534",
    textAlign: "right",
  },

  coordRow: { flexDirection: "row", marginTop: 2, marginBottom: 7 },
  // DMS is much the widest of the three — 31 monospaced characters — so it gets
  // the room rather than spilling into the transit column beside it.
  coordCell: { flex: 1, paddingRight: 8 },
  coordCellWide: { flex: 1.35, paddingRight: 8 },
  coordLabel: { fontSize: 6.5, color: "#6b7280", fontFamily: "Helvetica-Bold" },
  coordValue: { fontSize: 8.5, fontFamily: "Courier-Bold" },

  bullet: { flexDirection: "row", marginBottom: 1.5 },
  bulletDot: { width: 12, color: "#166534" },
  bulletText: { flex: 1, fontSize: 8.5, color: "#374151" },

  findings: {
    marginTop: 7,
    paddingTop: 6,
    borderTopWidth: 0.5,
    borderTopColor: "#e5e7eb",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  checkbox: { fontSize: 7.5, color: "#6b7280" },

  footer: {
    position: "absolute",
    bottom: 26,
    left: 42,
    right: 42,
    borderTopWidth: 0.5,
    borderTopColor: "#d1d5db",
    paddingTop: 6,
    fontSize: 6.5,
    color: "#6b7280",
  },
});

/** Decimal degrees to degrees/minutes/seconds — handheld GPS units and legal
 *  paperwork still expect DMS, so both notations go on the order. */
function toDms(value: number, axis: "lat" | "lon"): string {
  const hemi =
    axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  const abs = Math.abs(value);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = ((abs - d) * 60 - m) * 60;
  return `${d}° ${String(m).padStart(2, "0")}' ${s.toFixed(1).padStart(4, "0")}" ${hemi}`;
}

export interface PatrolOrderProps {
  orderId: string;
  issuedAt: Date;
  aoiLabel: string;
  post: RangerPost;
  targets: ScoredTarget[];
  totalDetections: number;
  totalEvents: number;
  live: boolean;
  /** The sequenced day. When present, tasks are numbered in driving order. */
  tour: TourPlan | null;
}

export function PatrolOrder(props: PatrolOrderProps) {
  const { orderId, issuedAt, aoiLabel, post, targets, totalDetections, totalEvents, live, tour } =
    props;

  const issued = issuedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const unroutable = targets.filter((t) => !t.routed).length;

  // Tasks are listed in *driving* order when a route has been planned, because
  // that is the order the day actually happens in. Rank is still printed
  // against each task so the reason it was chosen stays visible.
  const byId = new Map(targets.map((t) => [t.id, t]));
  const rankOf = new Map(targets.map((t, i) => [t.id, i + 1]));
  const sequenced = tour?.sequence.length
    ? tour.sequence.map((id) => byId.get(id)).filter((t): t is ScoredTarget => !!t)
    : targets;

  return (
    <Document
      title={`Patrol Dispatch Order ${orderId}`}
      author="Rangefinder"
      subject={`Deforestation alert tasking — ${aoiLabel}`}
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.ruleTop} />
        <Text style={styles.kicker}>RANGEFINDER — ALERT TRIAGE SYSTEM</Text>
        <Text style={styles.title}>Patrol Dispatch Order</Text>
        <Text style={styles.subtitle}>{aoiLabel}</Text>

        <View style={styles.metaRow}>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>ORDER NO.</Text>
            <Text style={styles.metaValue}>{orderId}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>ISSUED</Text>
            <Text style={styles.metaValue}>{issued}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>ORIGIN STATION</Text>
            <Text style={styles.metaValue}>{post.name}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>TASKS</Text>
            <Text style={styles.metaValue}>{sequenced.length}</Text>
          </View>
        </View>

        <View style={styles.banner}>
          <Text>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>
              {totalDetections.toLocaleString()} satellite detections
            </Text>
            {"  in the last 24 hours were resolved into "}
            <Text style={{ fontFamily: "Helvetica-Bold" }}>{totalEvents} distinct clearing events</Text>
            {" and ranked by actionability."}
            {tour && tour.sequence.length > 0 ? (
              <Text>
                {"  The "}
                <Text style={{ fontFamily: "Helvetica-Bold" }}>{tour.sequence.length}</Text>
                {tour.sequence.length === 1
                  ? " task below is the only one that fits a working day, driven from "
                  : " tasks below are sequenced as a single loop from "}
                {post.name}
                {" and back: "}
                <Text style={{ fontFamily: "Helvetica-Bold" }}>
                  {tour.totalKm.toFixed(0)} km, {tour.drivingHours.toFixed(1)} h driving,
                  {" "}
                  {tour.totalHours.toFixed(1)} h including time on site, about {tour.litres} L of
                  diesel.
                </Text>
              </Text>
            ) : (
              <Text>{"  No drivable loop could be planned for these targets."}</Text>
            )}
            {unroutable > 0
              ? ` ${unroutable} target${unroutable === 1 ? "" : "s"} cannot be reached by vehicle at all.`
              : ""}
          </Text>
        </View>

        <Text style={styles.sectionHead}>
          {tour && tour.sequence.length > 0
            ? "TASKED TARGETS — IN DRIVING ORDER"
            : "TASKED TARGETS — IN PRIORITY ORDER"}
        </Text>

        {sequenced.map((t, i) => (
          <View key={t.id} style={styles.task} wrap={false}>
            <View style={styles.taskHead}>
              <Text style={styles.rank}>
                {i + 1}. {t.protectedArea ?? "Unclassified tenure"}
                {tour && tour.sequence.length > 0 ? `  (priority #${rankOf.get(t.id)})` : ""}
                {t.treeCoverPct !== null
                  ? `  ·  ${Math.round(t.treeCoverPct)}% forest baseline`
                  : ""}
              </Text>
              {/* Severity in words as well as a number: a field order is
                  routinely photocopied in black and white, where any colour
                  coding disappears entirely. */}
              <Text style={styles.scorePill}>
                {severityLabel(t.score)} · ACTIONABILITY {t.score.toFixed(1)}/100
              </Text>
            </View>

            <View style={styles.coordRow}>
              <View style={styles.coordCell}>
                <Text style={styles.coordLabel}>DECIMAL</Text>
                <Text style={styles.coordValue}>
                  {t.lat.toFixed(5)}, {t.lon.toFixed(5)}
                </Text>
              </View>
              <View style={styles.coordCellWide}>
                <Text style={styles.coordLabel}>DMS</Text>
                <Text style={styles.coordValue}>
                  {toDms(t.lat, "lat")} {toDms(t.lon, "lon")}
                </Text>
              </View>
              <View style={styles.coordCell}>
                <Text style={styles.coordLabel}>
                  {t.routed ? "ROAD DISTANCE / TRANSIT" : "ACCESS (NO ROAD ROUTE)"}
                </Text>
                <Text style={styles.coordValue}>
                  {t.routed && t.routeKm !== null
                    ? `${t.routeKm.toFixed(0)} km · ${t.driveTimeHours.toFixed(1)} h`
                    : `${t.distanceFromPostKm.toFixed(0)} km direct · air/river`}
                </Text>
              </View>
            </View>

            {t.rationale.map((line, j) => (
              <View key={j} style={styles.bullet}>
                <Text style={styles.bulletDot}>—</Text>
                <Text style={styles.bulletText}>{line}</Text>
              </View>
            ))}

            <View style={styles.findings}>
              <Text style={styles.checkbox}>[  ] Reached   [  ] Activity confirmed   [  ] Equipment seized   [  ] Report filed</Text>
              <Text style={styles.checkbox}>Ref {t.id}</Text>
            </View>
          </View>
        ))}

        {tour && tour.excluded.length > 0 && (
          <View wrap={false}>
            <Text style={[styles.sectionHead, { marginTop: 6 }]}>
              CONSIDERED BUT NOT TASKED
            </Text>
            {tour.excluded.map((e) => {
              const t = byId.get(e.id);
              return (
                <View key={e.id} style={styles.bullet}>
                  <Text style={styles.bulletDot}>—</Text>
                  <Text style={styles.bulletText}>
                    Priority #{rankOf.get(e.id) ?? "?"}
                    {t ? ` at ${t.lat.toFixed(4)}, ${t.lon.toFixed(4)}` : ""}
                    {t?.protectedArea ? ` (${t.protectedArea})` : ""} —{" "}
                    {e.reason === "no road route"
                      ? "no vehicle route exists; requires air or river access."
                      : "ranked for patrol but does not fit within the driving day; carry forward."}
                  </Text>
                </View>
              );
            })}
            <Text style={[styles.checkbox, { marginTop: 5 }]}>
              Planning assumptions: {TOUR_ASSUMPTIONS.maxDrivingHours} h driving day,{" "}
              {TOUR_ASSUMPTIONS.hoursOnSite} h on site per target,{" "}
              {TOUR_ASSUMPTIONS.litresPer100km} L/100 km on unsealed road. Travel times are
              estimated from road class and do not account for river crossings, seasonal
              closures or tracks absent from OpenStreetMap.
            </Text>
          </View>
        )}

        <View style={styles.footer} fixed>
          <Text>
            Generated by Rangefinder from {live ? "live" : "cached"} open data ·{" "}
            {ATTRIBUTION.map((a) => `${a.name} (${a.licence})`).join(" · ")}
          </Text>
          <Text style={{ marginTop: 2 }}>
            Decision-support only. Satellite thermal detections indicate active burning, not
            proof of illegality; tenure and permit status must be verified before enforcement
            action. Distances are routed over the OpenStreetMap road network; forest baseline
            is ESA WorldCover 2021.
          </Text>
        </View>
      </Page>
    </Document>
  );
}
