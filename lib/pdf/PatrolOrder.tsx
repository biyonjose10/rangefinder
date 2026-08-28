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
  title: { fontSize: 20, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  subtitle: { fontSize: 9, color: "#4b5563", marginBottom: 12 },

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
  rank: { fontSize: 12, fontFamily: "Helvetica-Bold" },
  scorePill: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: "#166534" },

  coordRow: { flexDirection: "row", marginBottom: 6 },
  coordCell: { flex: 1 },
  coordLabel: { fontSize: 6.5, color: "#6b7280", fontFamily: "Helvetica-Bold" },
  coordValue: { fontSize: 9.5, fontFamily: "Courier-Bold" },

  bullet: { flexDirection: "row", marginBottom: 1.5 },
  bulletDot: { width: 9, color: "#166534" },
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
}

export function PatrolOrder(props: PatrolOrderProps) {
  const { orderId, issuedAt, aoiLabel, post, targets, totalDetections, totalEvents, live } =
    props;

  const issued = issuedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const totalHours = targets.reduce((s, t) => s + t.driveTimeHours, 0);
  const unroutable = targets.filter((t) => !t.routed).length;

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
            <Text style={styles.metaValue}>{targets.length}</Text>
          </View>
        </View>

        <View style={styles.banner}>
          <Text>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>
              {totalDetections.toLocaleString()} satellite detections
            </Text>
            {"  in the last 24 hours were resolved into "}
            <Text style={{ fontFamily: "Helvetica-Bold" }}>{totalEvents} distinct clearing events</Text>
            {" and ranked by actionability. The "}
            {targets.length}
            {" highest-priority events are tasked below. Estimated total transit: "}
            <Text style={{ fontFamily: "Helvetica-Bold" }}>{totalHours.toFixed(1)} h</Text>
            {unroutable > 0
              ? `. ${unroutable} of these has no vehicle route and requires air or river access.`
              : "."}
          </Text>
        </View>

        <Text style={styles.sectionHead}>TASKED TARGETS — IN PRIORITY ORDER</Text>

        {targets.map((t, i) => (
          <View key={t.id} style={styles.task} wrap={false}>
            <View style={styles.taskHead}>
              <Text style={styles.rank}>
                {i + 1}. {t.protectedArea ?? "Unclassified tenure"}
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
              <View style={styles.coordCell}>
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
