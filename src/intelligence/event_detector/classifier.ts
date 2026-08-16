import type { NormalizedDocument } from '../../domain/types.js';
import { type Classification, EVENT_TYPE_MATERIALITY, type EventType, type RuleMatch } from '../types.js';
import { KEYWORD_RULES, SEC_FORM_RULES, SEC_ITEM_RULES } from './rules.js';

/**
 * Document classification.
 *
 * Filing metadata is trusted over prose: an 8-K item code is the issuer's own
 * declaration of what the filing concerns, whereas keyword matches are
 * inference. When both fire, the filing wins.
 */

/** Extract 8-K item codes from the document's metadata. */
function secItems(doc: NormalizedDocument): string[] {
  const raw = doc.metadata.items;
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * 8-K item strings arrive as "2.02" or occasionally with trailing prose.
 * Only the leading numeric code is meaningful.
 */
function normaliseItemCode(item: string): string | undefined {
  const match = /^(\d+\.\d+)/.exec(item);
  return match?.[1];
}

export function classifyDocument(doc: NormalizedDocument): Classification {
  const matched: RuleMatch[] = [];

  // --- Filing-derived rules (high precision) ------------------------------
  const form = typeof doc.metadata.form === 'string' ? doc.metadata.form : undefined;

  for (const item of secItems(doc)) {
    const code = normaliseItemCode(item);
    if (!code) continue;
    const rule = SEC_ITEM_RULES[code];
    if (rule) {
      matched.push({
        rule: `sec:item:${code}`,
        type: rule.type,
        weight: rule.weight,
        evidence: rule.label,
      });
    }
  }

  if (form) {
    const rule = SEC_FORM_RULES[form];
    if (rule) {
      // An 8-K's meaning comes from its items, not from being an 8-K, so the
      // form table deliberately has no '8-K' entry.
      matched.push({ rule: `sec:form:${form}`, type: rule.type, weight: rule.weight, evidence: form });
    }
  }

  // --- Text-derived rules (lower precision) -------------------------------
  const text = `${doc.title} ${doc.content}`;
  for (const rule of KEYWORD_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    matched.push({
      rule: rule.id,
      type: rule.type,
      weight: rule.weight,
      evidence: match[0].slice(0, 120),
    });
  }

  if (matched.length === 0) {
    return { type: 'unclassified', confidence: 0, matched: [] };
  }

  // Accumulate weights per type. Several corroborating keyword rules for the
  // same type should beat one weak match for another.
  const scores = new Map<EventType, number>();
  for (const match of matched) {
    scores.set(match.type, (scores.get(match.type) ?? 0) + match.weight);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [winner, winningScore] = ranked[0]!;

  // Confidence reflects both absolute evidence and how clearly the winner beat
  // the alternatives. A document matching two types roughly equally is a
  // genuinely ambiguous document, and should say so.
  const total = ranked.reduce((sum, [, score]) => sum + score, 0);
  const share = total > 0 ? winningScore / total : 0;
  const strength = Math.min(1, winningScore);
  const confidence = Number((strength * (0.5 + 0.5 * share)).toFixed(3));

  return { type: winner, confidence, matched: matched.sort((a, b) => b.weight - a.weight) };
}

/**
 * Prior materiality of a document, before verification.
 *
 * Event-type prior, adjusted for how much the source is worth listening to and
 * whether the document actually names an asset. An unattributed "chip industry
 * faces pressure" story is less actionable than the same claim about a named
 * issuer, and the score should reflect that.
 */
export function materialityOf(
  classification: Classification,
  options: { sourceReliability: number; hasTickers: boolean; hasEntities: boolean },
): number {
  const base = EVENT_TYPE_MATERIALITY[classification.type];
  const sourceFactor = 0.6 + 0.4 * options.sourceReliability;
  const specificity = options.hasTickers ? 1 : options.hasEntities ? 0.8 : 0.6;
  const classificationFactor = 0.5 + 0.5 * classification.confidence;

  return Number(Math.min(1, base * sourceFactor * specificity * classificationFactor).toFixed(3));
}
