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

  // --- Wire-service phrasing ------------------------------------------------
  //
  // The rules above were written against press releases, where an organisation
  // announces its own news in its own vocabulary. A newswire writes the same
  // event differently — "beats estimates" rather than "quarterly results",
  // "signs a deal with" rather than a Form 8-K item 1.01 — and with the news
  // feeds on, that phrasing is most of what arrives.
  //
  // Weights stay in the same low band as their neighbours. These match prose,
  // not an issuer's declaration of what a filing concerns, and a confident
  // wrong classification costs more than an unconfident right one: the event
  // study keys on the category, so a mislabelled event pollutes a measurement
  // that later decides what may trade.

  // Contracts and partnerships. A signed multi-year agreement moves the
  // supplier as much as the buyer, and until now nothing outside an 8-K could
  // reach this category at all.
  { id: 'kw:agreement:contract', type: 'material_agreement', weight: 0.6, pattern: /\b(sign(?:s|ed)?|award(?:s|ed)?|wins?|won|secur(?:es|ed))\b[^.]{0,40}\b(contract|deal|agreement)\b/i },
  { id: 'kw:agreement:partnership', type: 'material_agreement', weight: 0.55, pattern: /\b(strategic partnership|partnership with|partners? with|joint venture|teams? up with)\b/i },
  { id: 'kw:agreement:supply', type: 'material_agreement', weight: 0.6, pattern: /\b((?:long[- ]term |multi[- ]?year )?supply (?:agreement|deal|contract)|multi[- ]?year (?:agreement|deal|contract)|offtake agreement)\b/i },
  // Its own rule rather than a branch of the one above: the "AI needs
  // electricity" trade is the single most common ticker-less story right now.
  { id: 'kw:agreement:power', type: 'material_agreement', weight: 0.6, pattern: /\b(power purchase agreement|\bPPA\b|electricity (?:supply|purchase)|energy (?:supply )?(?:deal|agreement)|nuclear (?:power )?(?:deal|agreement))\b/i },

  // Results, as a wire writes them.
  { id: 'kw:earnings:beat_miss', type: 'earnings', weight: 0.6, pattern: /\b(beat(?:s|ing)?|miss(?:es|ed)?|top(?:s|ped)?|exceed(?:s|ed)?|fell short of)\b[^.]{0,30}\b(estimates?|expectations?|forecasts?|consensus)\b/i },
  // "sales" is guarded: "retail sales rose" is a macro release, and without
  // the exclusion it matched here with the same weight as the macro rule and
  // won the tie on ordering alone — a statistics print filed as company
  // earnings, which is the kind of mislabelling the event study then measures.
  { id: 'kw:earnings:move', type: 'earnings', weight: 0.5, pattern: /\b(revenue|profits?|net income|operating income|earnings|(?<!\b(?:retail|home|car|auto|vehicle|chip|arms) )sales)\b[^.]{0,40}\b(rose|fell|jump(?:s|ed)?|surg(?:es|ed)|climb(?:s|ed)?|drop(?:s|ped)?|declin(?:es|ed)|boost|slump(?:s|ed)?|plunge[ds]?)\b/i },
  { id: 'kw:earnings:quarter', type: 'earnings', weight: 0.6, pattern: /\bQ[1-4]\b[^.]{0,20}\b(results|earnings|revenue|profits?)\b/i },

  // Deals short of a completed acquisition. "In talks" is a claim, not a fact;
  // the verifier is what decides how much to believe it.
  { id: 'kw:m_and_a:stake', type: 'm_and_a', weight: 0.6, pattern: /\b(acquir(?:es|ed)|buys?|bought|takes?|purchas(?:es|ed))\b[^.]{0,30}\b(stake|majority|controlling interest)\b/i },
  { id: 'kw:m_and_a:talks', type: 'm_and_a', weight: 0.55, pattern: /\b(in talks to (?:buy|acquire|merge)|explor(?:es|ing) (?:a )?(?:sale|merger)|agreed to buy|bid for)\b/i },

  { id: 'kw:restructuring:layoffs', type: 'restructuring', weight: 0.6, pattern: /\b(lay ?offs?|job cuts|cut(?:s|ting)? \d[\d,]* jobs|restructuring (?:plan|programme|program)|plant closure|clos(?:es|ing) (?:its )?(?:plant|factory))\b/i },

  { id: 'kw:legal:ruling', type: 'legal_action', weight: 0.5, pattern: /\b(court (?:rules?|ruled|orders?|ordered)|judge (?:rules?|ruled)|appeals? court|jury (?:found|awarded)|verdict)\b/i },

  // Capacity announcements sit at the same low weight as the product rule they
  // join: a new factory is real, but it is years of cash flow away.
  { id: 'kw:product:capacity', type: 'product', weight: 0.4, pattern: /\b(new (?:plant|factory|data ?cent(?:re|er)|facility)|capacity expansion|expands? (?:production|capacity)|breaks? ground on)\b/i },

  { id: 'kw:macro:activity', type: 'macro_release', weight: 0.5, pattern: /\b(retail sales|consumer confidence|\bPMI\b|purchasing managers|housing starts|durable goods)\b/i },
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
