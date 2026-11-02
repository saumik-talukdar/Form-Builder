import type { Field } from "@fb/shared";

export type FormStatus = "draft" | "published" | "closed";

export interface FormSettings {
  allowMultiple: boolean;
  closesAt: string | null;
  maxResponses: number | null;
}

export interface FormSummary {
  id: string;
  slug: string;
  status: FormStatus;
  title: string;
  description?: string;
  publishedVersion: number;
  settings: FormSettings;
  responseCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FormDetail extends FormSummary {
  fields: Field[];
}

export interface PublicForm {
  slug: string;
  title: string;
  description?: string;
  version: number;
  fields: Field[];
  closesAt: string | null;
}

export interface Bucket {
  key: string;
  count: number;
}

export interface QuestionStat {
  fieldId: string;
  label: string;
  type: Field["type"];
  answered: number;
  answerRate: number;
  options?: { id: string; label: string; count: number }[];
  distribution?: { value: number; count: number }[];
  average?: number | null;
  avg?: number | null;
  min?: number | null;
  max?: number | null;
  histogram?: { min: number; max: number; count: number }[];
  byMonth?: { month: string; count: number }[];
  topValues?: { value: string; count: number }[];
}

export interface Analytics {
  range: {
    from: string | null;
    to: string | null;
    timezone: string;
    interval: "day" | "hour";
  };
  summary: {
    totalResponses: number;
    uniqueRespondents: number;
    avgDurationMs: number | null;
    medianDurationMs: number | null;
  };
  overTime: Bucket[];
  breakdowns: Record<
    "device" | "browser" | "os" | "country" | "referrer" | "language",
    Bucket[]
  >;
  funnel: {
    windowFrom: string;
    windowTo: string;
    views: number;
    uniqueViews: number;
    submissions: number;
    conversionRate: number | null;
    viewsRetentionDays: number;
  };
  questions: {
    version: number | null;
    totalResponses: number;
    items: QuestionStat[];
  };
}

export interface ResponseRow {
  id: string;
  version: number;
  answers: Record<string, unknown>;
  submittedAt: string;
  meta: {
    browser?: string;
    os?: string;
    device?: string;
    country?: string;
    durationMs?: number;
  };
}

export interface LiveEvent {
  id: string;
  count: number;
  submittedAt: string;
  device: string;
  country: string | null;
}
