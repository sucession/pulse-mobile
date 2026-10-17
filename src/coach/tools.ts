// src/coach/tools.ts — Pulse Coach Tools + Full Nutrition, Hydration, Weight & Symptom Logging
import AsyncStorage from "@react-native-async-storage/async-storage";
import { tool, type InferToolOutput } from "ai";
import { z } from "zod";
import { logEntry, logFoods } from "@/actions/log";
import { trainingGuidance } from "@/core/algorithms/coaching";
import type { Metric } from "@/lib/reasons";
import { addDays, daysBetween, localMidnight } from "@/lib/time";
import { NO_CUSTOM, parseCustomTargets } from "@/nutrition/targets";
import { getActivities } from "@/queries/activities";
import { costDigest } from "@/queries/activityCost";
import { getActivity } from "@/queries/activity";
import { dayStartOf, firstDay, loadDays, maybe, meanSd, todayOf, type QueryCtx } from "@/queries/common";
import { acwrStatus, getFitness, getHealthHub, getMonitor, getStress } from "@/queries/health";
import { energyBankVM, latestReport } from "@/queries/home";
import { getJournalInsights } from "@/queries/journal";
import { FLOWS, MEALS, MOODS, SYMPTOMS, VALENCES, type Flow, type Meal, type Mood, type Symptom, type Valence } from "@/queries/log";
import { getNutrition } from "@/queries/nutrition";
import { getRecovery } from "@/queries/recovery";
import { getReport } from "@/queries/reports";
import { getSleep } from "@/queries/sleep";
import { getStrain } from "@/queries/strain";
import { TREND_METRICS, type TrendMetricKey } from "@/queries/trends";
import { defaultTexts, type Texts } from "./texts";

const round = (v: number, dp = 0) => Math.round(v * 10 ** dp) / 10 ** dp;

export function num(m: Metric<number>, dp = 0) {
  return { value: m.value === null ? null : round(m.value, dp), reason: m.value === null ? (m.reason ?? "no_data") : null, provisional: m.provisional, ...(m.nightsLeft !== undefined && { nightsLeft: m.nightsLeft }) };
}

const Day = (description: string) => z.iso.date().optional().describe(description);

async function dayOf(ctx: QueryCtx, day: string | undefined) {
  const today = todayOf(ctx);
  if (!day || day > today) return today;
  const first = await firstDay(ctx);
  return first && day < first ? first : day;
}

export async function sleepDigest(ctx: QueryCtx, day: string) {
  const s = await getSleep(day, ctx);
  return {
    day,
    timeZone: ctx.timeZone,
    performance: { ...num(s.performance), unit: "%" },
    asleepMinutes: num(s.hours.value ? { ...s.hours, value: s.hours.value.asleepMin } : { ...s.hours, value: null }),
    need: s.hoursVsNeed,
    summary: s.summary.map((v) => ({ key: v.key, label: v.label, unit: v.unit ?? null, ...num(v.metric, 1), baseline: v.average, status: v.status ?? null })),
    details: s.details.map((v) => ({ key: v.key, label: v.label, unit: v.unit ?? null, ...num(v.metric, 1), baseline: v.average })),
    stages: s.stages?.value
      ? { value: { bedAt: s.stages.value.bed, wakeAt: s.stages.value.wake, rows: s.stages.value.rows.map((r) => ({ stage: r.label, minutes: round(r.minutes), pct: round(r.pct) })) }, reason: null, provisional: s.stages.provisional }
      : { value: null, reason: s.stages?.reason ?? "no_data", provisional: false },
    planner: s.planner,
    insight: s.insight,
  };
}

export async function trendDigest(ctx: QueryCtx, metric: TrendMetricKey, start?: string, end?: string) {
  const to = end && end < todayOf(ctx) ? end : todayOf(ctx);
  const requested = start ?? addDays(to, -13);
  const from = requested > to ? to : requested < addDays(to, -89) ? addDays(to, -89) : requested;
  const count = daysBetween(from, to) + 1;
  const priorEnd = addDays(from, -1);
  const priorStart = addDays(from, -count);
  const rows = await loadDays(ctx, priorStart, to);
  const m = TREND_METRICS.find((m) => m.key === metric)!;
  const points = (a: string, b: string) => {
    const out = [];
    for (let day = a; day <= b; day = addDays(day, 1)) {
      const row = rows.get(day)!;
      const partial = !!m.partialToday && day === todayOf(ctx);
      const v = partial ? null : m.pick(row);
      const rec = row.recovery;
      const reason = metric === "recovery" && rec?.reason ? rec.reason : "no_data";
      out.push({ day, ...num(maybe(v, reason, !!m.provisional?.(row)), 1), ...(partial && { excludedPartialDay: true }) });
    }
    return out;
  };
  const current = points(from, to);
  const previous = points(priorStart, priorEnd);
  const stats = (p: typeof current) => ({ average: num(maybe(meanSd(p.map((d) => d.value)).mean, "no_data", p.some((d) => d.provisional)), 1), observedDays: p.filter((d) => d.value !== null).length });
  return { metric: m.label, key: metric, unit: m.unit ?? (m.format === "duration" ? "min" : null), start: from, end: to, requestedStart: start ?? null, requestedEnd: end ?? null, calendarDays: count, ...stats(current), previous: { start: priorStart, end: priorEnd, ...stats(previous) }, points: current };
}

export async function dayDigest(ctx: QueryCtx, day: string) {
  const [rec, sleep, strain, stress, rows] = await Promise.all([getRecovery(day, ctx), getSleep(day, ctx), getStrain(day, ctx), getStress(day, ctx), loadDays(ctx, day, day)]);
  const bank = energyBankVM(ctx, rows.get(day), day, rec.isToday, null);
  return {
    day,
    isToday: rec.isToday,
    guidance: trainingGuidance({
      recovery: rec.recovery.value,
      provisional: rec.recovery.provisional,
      sleepPerformance: sleep.performance.value,
      strain: strain.strain.value,
      targetHigh: strain.target.value?.high ?? null,
      loadStatus: rows.get(day)?.trainingLoad?.acwr == null ? null : acwrStatus(rows.get(day)!.trainingLoad!.acwr!).status,
    }),
    recovery: {
      ...num(rec.recovery),
      unit: "%",
      band: rec.band,
      contributors: rec.contributors.map((c) => ({
        label: c.label,
        unit: c.unit,
        ...num(c.metric, 1),
        baseline: c.baseline && round(c.baseline.mean, 1),
        points: c.points === null ? null : round(c.points, 1),
      })),
    },
    sleep: {
      performance: { ...num(sleep.performance), unit: "%" },
      hoursAsleep: sleep.hours.value ? round(sleep.hours.value.asleepMin / 60, 1) : null,
      hoursNeeded: sleep.hoursVsNeed.value ? round(sleep.hoursVsNeed.value.needMin / 60, 1) : null,
      stages: sleep.stages?.value?.rows.map((r) => ({ stage: r.label, minutes: Math.round(r.minutes), pct: Math.round(r.pct) })) ?? null,
    },
    strain: {
      ...num(strain.strain),
      scale: "percent, 0-100 (above 100 on a very big day)",
      soFar: strain.soFar,
      target: strain.target.value ? [round(strain.target.value.low), round(strain.target.value.high)] : null,
      coachLine: strain.coach,
    },
    energyBank: { value: bank.value ? { current: round(bank.value.current), charged: round(bank.value.charged), drained: round(bank.value.drained), asOf: bank.value.until } : null, reason: bank.reason, provisional: bank.provisional },
    stress: stress.gauge.value ? { ...num({ ...stress.gauge, value: stress.gauge.value.value }), level: stress.gauge.value.level } : num({ ...stress.gauge, value: null }),
  };
}

export async function nutritionDigest(ctx: QueryCtx) {
  const rawTargets = await AsyncStorage.getItem("pulse.nutrition.targets").catch(() => null);
  const custom = rawTargets ? parseCustomTargets(rawTargets) : NO_CUSTOM;
  const n = await getNutrition(ctx, custom);
  const todayMidnight = localMidnight(n.today, ctx.timeZone);
  const logged = await ctx.store.loggedEntries(todayMidnight, 5000);
  const waterMl = logged
    .filter((r) => r.day === n.today && r.type === "hydration-log")
    .reduce((sum, r) => sum + (Number((r.data as { ml?: number })?.ml) || 0), 0);

  return {
    today: n.today,
    totals: n.totals,
    waterMl,
    targets: {
      kcal: n.targets.kcal.value,
      protein: n.targets.protein.value,
      carbs: n.targets.carbs.value,
      fat: n.targets.fat.value,
    },
    remaining: {
      kcal: Math.max(0, n.targets.kcal.value - (n.totals.kcal ?? 0)),
      protein: Math.max(0, n.targets.protein.value - (n.totals.protein ?? 0)),
      carbs: Math.max(0, n.targets.carbs.value - (n.totals.carbs ?? 0)),
      fat: Math.max(0, n.targets.fat.value - (n.totals.fat ?? 0)),
    },
    meals: n.meals.map((mg) => ({
      meal: mg.meal,
      label: mg.label,
      kcal: mg.kcal,
      items: mg.items.map((i) => ({
        id: i.id,
        name: i.title,
        portion: i.portion,
        kcal: i.kcal,
        protein: i.protein,
        carbs: i.carbs,
        fat: i.fat,
        fiber: i.fiber,
      })),
    })),
    weekAverage: n.week,
    monthAverage: n.month,
  };
}

const mealEnum = MEALS.map((m) => m[0]) as [Meal, ...Meal[]];
const symptomEnum = SYMPTOMS.map((s) => s[0]) as [Symptom, ...Symptom[]];
const moodEnum = MOODS.map((m) => m[0]) as [Mood, ...Mood[]];
const valenceEnum = VALENCES.map((v) => v[0]) as [Valence, ...Valence[]];
const flowEnum = FLOWS.map((f) => f[0]) as [Flow, ...Flow[]];

export function coachTools(ctx: QueryCtx, t: Texts = defaultTexts) {
  return {
    get_day: tool({
      description: t("tool.get_day"),
      inputSchema: z.object({ day: Day(t("tool.get_day.day")) }),
      execute: async ({ day }) => dayDigest(ctx, await dayOf(ctx, day)),
    }),
    get_sleep: tool({
      description: t("tool.get_sleep"),
      inputSchema: z.object({ day: Day(t("tool.get_sleep.day")) }),
      execute: async ({ day }) => sleepDigest(ctx, await dayOf(ctx, day)),
    }),
    get_trend: tool({
      description: t("tool.get_trend"),
      inputSchema: z.object({ metric: z.enum(TREND_METRICS.map((m) => m.key) as [TrendMetricKey, ...TrendMetricKey[]]).describe(t("tool.get_trend.metric")), start: Day(t("tool.get_trend.start")), end: Day(t("tool.get_trend.end")) }),
      execute: async ({ metric, start, end }) => trendDigest(ctx, metric, start, end),
    }),
    get_activities: tool({
      description: t("tool.get_activities"),
      inputSchema: z.object({ days: z.number().int().min(1).max(90).default(14).describe(t("tool.get_activities.days")) }),
      execute: async ({ days }) => {
        const a = await getActivities(days, ctx);
        const all = a.groups.flatMap((g) =>
          g.items.map((i) => ({
            id: i.id,
            day: g.day,
            name: i.name,
            minutes: Math.round((i.end - i.start) / 60_000),
            strain: num(i.strain, 1),
            distanceKm: i.distanceKm === null ? null : round(i.distanceKm, 1),
          })),
        );
        const detected = a.groups.flatMap((g) =>
          g.detected.map((d) => ({ day: g.day, likely: d.label, minutes: Math.round((d.end - d.start) / 60_000), avgHr: d.avgHr, strain: d.strain === null ? null : round(d.strain, 1) })),
        );
        return {
          start: addDays(a.today, -(days - 1)),
          end: a.today,
          total: all.length,
          truncated: all.length > 30,
          workouts: all.slice(0, 30),
          detected: detected.slice(0, 30),
          recoveryCost: a.cost && costDigest(a.cost),
        };
      },
    }),
    get_activity: tool({
      description: t("tool.get_activity"),
      inputSchema: z.object({ id: z.string().min(1).max(100).describe(t("tool.get_activity.id")) }),
      execute: async ({ id }) => {
        const a = await getActivity(id, ctx);
        if (!a || a.day > todayOf(ctx)) return { workout: null, reason: "no_data" as const };
        return {
          workout: {
            id: a.id,
            day: a.day,
            name: a.name,
            minutes: Math.round((a.end - a.start) / 60_000),
            strain: num(a.strain, 1),
            stats: a.stats.map((v) => ({ label: v.label, unit: v.unit ?? null, ...num(v.metric, 1), baseline: v.average })),
            zones: a.zones,
            zoneNote: a.zoneNote,
            hrRecovery: a.hrr,
            insight: a.insight,
          },
          reason: null,
        };
      },
    }),
    get_journal_impacts: tool({
      description: t("tool.get_journal_impacts"),
      inputSchema: z.object({ outcome: z.enum(["recovery", "hrv", "sleep"]).default("recovery").describe(t("tool.get_journal_impacts.outcome")) }),
      execute: async ({ outcome }) => {
        const j = await getJournalInsights(outcome, ctx);
        return {
          outcome,
          unit: j.unit,
          effects: j.items.map((i) => ({ key: i.key, behaviour: i.label, effect: i.effect, confidenceInterval: i.ci ?? null, delta: round(i.delta, 1), withAvg: i.avgWith, withoutAvg: i.avgWithout, yesDays: i.yes, noDays: i.no })),
          needsMoreData: j.needsMore.map((n) => ({ behaviour: n.label, yesDays: n.yes, noDays: n.no })),
        };
      },
    }),
    get_health: tool({
      description: t("tool.get_health"),
      inputSchema: z.object({ day: Day(t("tool.get_health.day")) }),
      execute: async ({ day }) => {
        const d = await dayOf(ctx, day);
        const dated = { ...ctx, today: d, now: Math.min(ctx.now, dayStartOf(ctx, addDays(d, 1)) - 1) };
        const [mon, hub, fit] = await Promise.all([getMonitor(d, dated), getHealthHub(dated), getFitness(dated)]);
        return {
          day: d,
          asOf: hub.day,
          trainingLoad: fit.trainingLoad,
          vitals: mon.vitals.map((v) => ({ vital: v.label, unit: v.unit, ...num(v.metric, 1), status: v.status, range: v.range })),
          illness: mon.illness,
          pulseAge: { value: hub.healthspan.value ? { years: round(hub.healthspan.value.pulseAge, 1), vsActualAge: round(hub.healthspan.value.deltaYears, 1) } : null, reason: hub.healthspan.reason, provisional: hub.healthspan.provisional },
          vo2max: { value: hub.fitness.value ? { vo2max: round(hub.fitness.value.vo2max, 1), category: hub.fitness.value.category } : null, reason: hub.fitness.reason, provisional: hub.fitness.provisional },
          trainingLoadRatio: hub.fitness.value?.acwr ?? null,
        };
      },
    }),
    get_report: tool({
      description: t("tool.get_report"),
      inputSchema: z.object({ kind: z.enum(["week", "month"]).default("week").describe(t("tool.get_report.kind")) }),
      execute: async ({ kind }) => {
        const latest = await latestReport(ctx, kind);
        const r = latest && (await getReport(latest.period, ctx));
        if (!r) return { report: null, reason: "no_data" };
        return {
          period: r.period,
          start: r.start,
          end: r.end,
          partial: r.partial,
          scores: r.dials.map((d) => ({ score: d.label, ...num(d.metric, 1), changeVsPrevious: d.delta })),
          averages: r.averages.map((a) => ({ label: a.label, unit: a.unit ?? null, ...num(a.metric, 1) })),
          trainingBalance: r.trainingBalance.value?.line ?? null,
          bestWorst: r.bestWorst,
          summary: r.insight,
        };
      },
    }),
    get_profile: tool({
      description: t("tool.get_profile"),
      inputSchema: z.object({}),
      execute: async () => {
        const p = ctx.profile;
        const age = Math.floor((Date.parse(todayOf(ctx)) - Date.parse(p.birthDate)) / (365.2425 * 86_400_000));
        return { age, sex: p.sex, maxHr: p.maxHr, heightCm: p.heightCm, waistCm: p.waistCm ?? null, sleepGoalHours: p.sleepGoal?.hours ?? null, timeZone: ctx.timeZone, firstDayWithData: await firstDay(ctx), today: todayOf(ctx), weekAgo: addDays(todayOf(ctx), -7) };
      },
    }),
    get_nutrition: tool({
      description: "Read today's logged meals, calorie and macro totals (protein, carbs, fat, fiber), hydration (waterMl), remaining daily targets, and 7/30-day nutrition averages. Always call this before giving nutrition advice or after logging food.",
      inputSchema: z.object({}),
      execute: async () => nutritionDigest(ctx),
    }),
    log_meal: tool({
      description: "Log one or more foods into the user's Pulse nutrition log for today or a specified local time (YYYY-MM-DDTHH:mm). Estimate calories, protein, carbs, fat and fiber accurately when the user describes a meal.",
      inputSchema: z.object({
        meal: z.enum(mealEnum).describe("BREAKFAST, LUNCH, DINNER, or SNACK"),
        at: z.string().optional().describe("Optional local time YYYY-MM-DDTHH:mm; omit for right now"),
        items: z.array(
          z.object({
            name: z.string().min(1).max(80).describe("Food item name, max 80 chars"),
            portion: z.string().max(60).optional().describe("Portion description, e.g. '200g' or '2 eggs'"),
            kcal: z.number().int().min(0).max(10000).describe("Calories (whole number)"),
            protein: z.number().min(0).max(1000).nullable().describe("Protein in grams"),
            carbs: z.number().min(0).max(1000).nullable().describe("Carbohydrates in grams"),
            fat: z.number().min(0).max(1000).nullable().describe("Fat in grams"),
            fiber: z.number().min(0).max(1000).nullable().optional().describe("Fiber in grams"),
          }),
        ).min(1).max(20),
      }),
      execute: async ({ meal, at, items }) => {
        const res = await logFoods({ store: ctx.store, timeZone: ctx.timeZone, profile: ctx.profile }, { meal, via: "text", at, items });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, loggedCount: res.data.count, updatedNutrition: await nutritionDigest(ctx) };
      },
    }),
    log_entry: tool({
      description: "Log water intake (ml), body weight (kg) and body fat (%), symptoms, mood, or menstrual period into the user's Pulse database.",
      inputSchema: z.object({
        kind: z.enum(["water", "weight", "symptoms", "mood", "period"]).describe("Type of entry to log"),
        at: z.string().optional().describe("Optional local time YYYY-MM-DDTHH:mm; omit for now"),
        ml: z.number().int().min(10).max(5000).optional().describe("Water in ml (when kind = water)"),
        kg: z.number().min(20).max(300).optional().describe("Weight in kg (when kind = weight)"),
        fatPct: z.number().min(2).max(75).nullable().optional().describe("Body fat % (when kind = weight)"),
        symptoms: z.array(z.enum(symptomEnum)).optional().describe("Symptoms list (when kind = symptoms)"),
        moods: z.array(z.enum(moodEnum)).optional().describe("Moods list (when kind = mood)"),
        valence: z.enum(valenceEnum).nullable().optional().describe("Valence (when kind = mood)"),
        periodStart: z.string().optional().describe("YYYY-MM-DD start (when kind = period)"),
        periodEnd: z.string().optional().describe("YYYY-MM-DD end (when kind = period)"),
        flow: z.enum(flowEnum).nullable().optional().describe("Flow (when kind = period)"),
      }),
      execute: async (input) => {
        const actionCtx = { store: ctx.store, timeZone: ctx.timeZone, profile: ctx.profile };
        if (input.kind === "water" && input.ml != null) {
          return logEntry(actionCtx, { kind: "water", ml: input.ml, at: input.at });
        }
        if (input.kind === "weight" && input.kg != null) {
          return logEntry(actionCtx, { kind: "weight", kg: input.kg, fatPct: input.fatPct ?? null, at: input.at });
        }
        if (input.kind === "symptoms" && input.symptoms?.length) {
          return logEntry(actionCtx, { kind: "symptoms", symptoms: input.symptoms, at: input.at });
        }
        if (input.kind === "mood" && input.moods?.length) {
          return logEntry(actionCtx, { kind: "mood", moods: input.moods, valence: input.valence ?? null, at: input.at });
        }
        if (input.kind === "period" && input.periodStart && input.periodEnd) {
          return logEntry(actionCtx, { kind: "period", start: input.periodStart, end: input.periodEnd, flow: input.flow ?? null });
        }
        return { ok: false, error: "Missing required fields for the selected kind." };
      },
    }),
  };
}

export type CoachTools = ReturnType<typeof coachTools>;
export type CoachOutputs = { [K in keyof CoachTools]: InferToolOutput<CoachTools[K]> };
