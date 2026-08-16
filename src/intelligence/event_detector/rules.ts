import type { EventType } from '../types.js';

/**
 * Classification rules.
 *
 * Two families, deliberately unequal:
 *
 *  - **Filing rules** map SEC form types and 8-K item codes to event types.
 *    These are near-deterministic: the item code *is* the issuer's own
 *    statement of what the filing is about. High weight.
 *  - **Keyword rules** match press-release and headline text. These are
 *    genuinely fuzzy — "guidance" appears in plenty of prose that is not an
 *    earnings guidance update — so they carry lower weights and exist mainly
 *    to route documents to the right analysis in Phase 3.
 *
 * Every rule carries an id so a classification can be traced back to exactly
 * what fired.
 */

/** 8-K item codes. Source: SEC Form 8-K, current items list. */
export const SEC_ITEM_RULES: Record<string, { type: EventType; weight: number; label: string }> = {
  '1.01': { type: 'material_agreement', weight: 0.8, label: 'Entry into a Material Definitive Agreement' },
  '1.02': { type: 'material_agreement', weight: 0.75, label: 'Termination of a Material Definitive Agreement' },
  '1.03': { type: 'bankruptcy', weight: 0.95, label: 'Bankruptcy or Receivership' },
  '2.01': { type: 'm_and_a', weight: 0.9, label: 'Completion of Acquisition or Disposition of Assets' },
  '2.02': { type: 'earnings', weight: 0.95, label: 'Results of Operations and Financial Condition' },
  '2.03': { type: 'material_agreement', weight: 0.7, label: 'Creation of a Direct Financial Obligation' },
  '2.05': { type: 'restructuring', weight: 0.85, label: 'Costs Associated with Exit or Disposal Activities' },
  '2.06': { type: 'accounting_issue', weight: 0.85, label: 'Material Impairments' },
  '3.01': { type: 'listing_status', weight: 0.85, label: 'Notice of Delisting or Failure to Satisfy a Listing Rule' },
  '4.01': { type: 'accounting_issue', weight: 0.8, label: "Changes in Registrant's Certifying Accountant" },
  '4.02': { type: 'accounting_issue', weight: 0.95, label: 'Non-Reliance on Previously Issued Financial Statements' },
  '5.02': { type: 'executive_change', weight: 0.9, label: 'Departure or Election of Directors or Officers' },
  '7.01': { type: 'disclosure', weight: 0.5, label: 'Regulation FD Disclosure' },
  '8.01': { type: 'disclosure', weight: 0.3, label: 'Other Events' },
  // 9.01 is exhibits only: it never determines what an event is about.
};

export const SEC_FORM_RULES: Record<string, { type: EventType; weight: number }> = {
  '10-Q': { type: 'periodic_report', weight: 0.9 },
  '10-K': { type: 'periodic_report', weight: 0.9 },
  '20-F': { type: 'periodic_report', weight: 0.9 },
  '40-F': { type: 'periodic_report', weight: 0.9 },
  '6-K': { type: 'disclosure', weight: 0.4 },
  '4': { type: 'insider_transaction', weight: 0.95 },
  '3': { type: 'insider_transaction', weight: 0.8 },
  '5': { type: 'insider_transaction', weight: 0.8 },
  'SC 13D': { type: 'ownership_change', weight: 0.9 },
  'SC 13G': { type: 'ownership_change', weight: 0.85 },
  '425': { type: 'm_and_a', weight: 0.85 },
  'DEFM14A': { type: 'm_and_a', weight: 0.85 },
};

export interface KeywordRule {
  id: string;
  type: EventType;
  weight: number;
  pattern: RegExp;
}

/**
 * Keyword rules, ordered by nothing in particular — all are evaluated and
 * their weights accumulate per event type.
 */
export const KEYWORD_RULES: KeywordRule[] = [
  // Monetary policy — the vocabulary here is unusually unambiguous.
  { id: 'kw:policy:rate_decision', type: 'monetary_policy', weight: 0.75, pattern: /\b(interest rate decision|rate decision|monetary policy decision|policy rate)\b/i },
  { id: 'kw:policy:basis_points', type: 'monetary_policy', weight: 0.6, pattern: /\b\d+\s*basis points?\b/i },
  { id: 'kw:policy:bodies', type: 'monetary_policy', weight: 0.55, pattern: /\b(Governing Council|FOMC|Federal Open Market Committee|Monetary Policy Committee)\b/i },
  { id: 'kw:policy:facilities', type: 'monetary_policy', weight: 0.6, pattern: /\b(deposit facility|main refinancing operations|federal funds (target )?rate)\b/i },
  { id: 'kw:policy:action', type: 'monetary_policy', weight: 0.5, pattern: /\b(raise|raised|cut|cuts|lower(?:ed)?|hold|held|leave|left|keep|kept)\b[^.]{0,40}\b(interest rates?|key rates?)\b/i },

  // Macro releases
  { id: 'kw:macro:inflation', type: 'macro_release', weight: 0.6, pattern: /\b(inflation rate|consumer price index|\bCPI\b|\bHICP\b|core inflation)\b/i },
  { id: 'kw:macro:labour', type: 'macro_release', weight: 0.6, pattern: /\b(unemployment rate|nonfarm payrolls|non-farm payrolls|jobless claims|employment situation)\b/i },
  { id: 'kw:macro:growth', type: 'macro_release', weight: 0.55, pattern: /\b(gross domestic product|\bGDP\b growth|industrial production)\b/i },

  // Trade policy and sanctions
  { id: 'kw:trade:tariff', type: 'trade_policy', weight: 0.8, pattern: /\b(tariffs?|import dut(?:y|ies)|customs dut(?:y|ies))\b/i },
  { id: 'kw:trade:controls', type: 'trade_policy', weight: 0.7, pattern: /\b(export controls?|trade restrictions?|trade barriers?)\b/i },
  { id: 'kw:sanctions', type: 'sanctions', weight: 0.8, pattern: /\b(sanctions?|embargo|asset freeze)\b/i },

  // Corporate events
  { id: 'kw:m_and_a', type: 'm_and_a', weight: 0.7, pattern: /\b(acquisition of|to acquire|merger (?:with|agreement)|takeover bid|tender offer)\b/i },
  { id: 'kw:earnings', type: 'earnings', weight: 0.7, pattern: /\b(quarterly results|earnings (?:report|results|per share)|reports? (?:first|second|third|fourth) quarter)\b/i },
  { id: 'kw:guidance', type: 'guidance', weight: 0.55, pattern: /\b(raises? (?:its )?(?:full[- ]year )?(?:guidance|outlook|forecast)|cuts? (?:its )?(?:guidance|outlook|forecast)|lowers? (?:its )?(?:guidance|outlook|forecast)|profit warning)\b/i },
  { id: 'kw:legal', type: 'legal_action', weight: 0.6, pattern: /\b(antitrust|lawsuit|class action|regulatory (?:probe|investigation)|files? (?:suit|charges))\b/i },
  { id: 'kw:legal:fine', type: 'legal_action', weight: 0.6, pattern: /\b(fined?|penalt(?:y|ies)|settlement of)\b[^.]{0,40}\b(million|billion|€|\$)/i },
  { id: 'kw:exec', type: 'executive_change', weight: 0.6, pattern: /\b(chief executive|\bCEO\b|chief financial officer|\bCFO\b)\b[^.]{0,60}\b(steps? down|resign(?:s|ed)?|appoint(?:s|ed)?|to succeed|departure)\b/i },
  { id: 'kw:product', type: 'product', weight: 0.3, pattern: /\b(launch(?:es|ed)? (?:a |the |its )?new|unveil(?:s|ed)?|product recall)\b/i },
];

/**
 * Phrases indicating that a claim is being denied, retracted or contradicted.
 *
 * Rule-based and therefore blunt: it cannot tell *which* claim is being denied,
 * only that denial language is present in a document about the same entities.
 * A match lowers confidence and flags the event for human or Phase 3 review —
 * it never silently resolves the disagreement.
 */
export const CONTRADICTION_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'denial:denies', pattern: /\b(denies|denied|denial of)\b/i },
  { id: 'denial:no_plans', pattern: /\bno plans to\b/i },
  { id: 'denial:dismiss', pattern: /\b(dismissed|dismisses|rejects?|rejected|refutes?)\b[^.]{0,40}\b(report|claim|allegation|speculation)/i },
  { id: 'denial:inaccurate', pattern: /\b(inaccurate|not true|false report|untrue|without merit)\b/i },
  { id: 'denial:retract', pattern: /\b(retracts?|retracted|walked back|withdraws? (?:the )?(?:report|statement))\b/i },
  { id: 'denial:correction', pattern: /\b(correction:|corrects? (?:earlier|previous) (?:report|story))\b/i },
];
