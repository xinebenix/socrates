/**
 * The string tables.
 *
 * `en` is the source of truth for *shape*: the `Dict` type is derived from it, so a key
 * added in English and forgotten in Chinese fails `tsc` rather than rendering blank in
 * production. That is the whole reason the dictionaries are typed rather than looked up
 * from JSON at runtime.
 *
 * The Chinese is lifted from the `Socrates zh-CN.dc.html` design comp character for
 * character. It has a deliberate literary register — 「此番不中」for a wrong answer, not
 * 「错误」— and paraphrasing it would flatten the voice the comp was built to carry.
 */

import { DEFAULT_LOCALE, type Locale } from './locale';

/* eslint-disable @typescript-eslint/no-unused-vars */

export const en = {
  chrome: {
    subtitleDefault: 'the endless knowledge gym',
    navBlueprint: 'Blueprint',
    navDashboard: 'Dashboard',
    navItemHealth: 'Item health',
    navBenchmark: 'Benchmark',
    spendTitle: 'Estimated spend this month',
    spendHeading: 'Estimated spend',
    spendToday: 'Today',
    spendThisMonth: 'This month',
    spendBudget: 'Budget',
    spendAheadOfUse: 'Ahead of use',
    spendClose: 'Close',
  },
} as const;

/**
 * The shape every locale must satisfy. Derived from `en`, widened to `string` so a
 * translation is not required to be the same literal.
 */
export type Dict = {
  [Namespace in keyof typeof en]: { [Key in keyof (typeof en)[Namespace]]: string };
};

export const zh: Dict = {
  chrome: {
    subtitleDefault: '无尽的知识道场',
    navBlueprint: '蓝图',
    navDashboard: '总览',
    navItemHealth: '题目健康',
    navBenchmark: '基准集',
    spendTitle: '本月预估支出',
    spendHeading: '预估支出',
    spendToday: '今日',
    spendThisMonth: '本月',
    spendBudget: '预算',
    spendAheadOfUse: '先行生成',
    spendClose: '关闭',
  },
};

const DICTIONARIES: Record<Locale, Dict> = { en, zh };

export function dictionaryFor(locale: Locale): Dict {
  return DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
}

/**
 * Fill `{name}` placeholders.
 *
 * Deliberately tolerant: an unknown placeholder is left as written rather than replaced
 * with "undefined", so a mismatch between a template and its arguments shows up as
 * visible braces a reader can report instead of a confident lie.
 */
export function fill(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole
  );
}
