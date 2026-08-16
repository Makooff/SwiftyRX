import type { NormalizedDocument, VerificationStatus } from '../../domain/types.js';
import { sourceRegistry } from '../../ingestion/source-registry.js';
import { CONTRADICTION_PATTERNS } from '../event_detector/rules.js';
import type { Contradiction, EventCluster, MarketReaction, VerificationAssessment } from '../types.js';

/**
 * Source verification.
 *
 * Implements the brief's chain:
 *   source reliability -> secondary sources -> official source
 *   -> market reaction -> confidence
 *
 * Three principles the arithmetic exists to enforce:
 *
 *  1. **Corroboration means independent reporting.** Ten outlets carrying one
 *     wire story is one newsroom, not ten confirmations. Documents flagged as
 *     near-duplicates therefore count once.
 *  2. **Social sources cannot self-promote.** A cluster containing nothing but
 *     posts is capped hard and can never be marked confirmed, no matter how
 *     many accounts repeat it. Repetition is not evidence.
 *  3. **Confidence is about truth, not tradeability.** This number says how
 *     likely the claim is to be real. Whether that justifies a position is the
 *     Risk Engine's question, and it gets to say no regardless.
 */

/** Ceiling on confidence when every source is a social post. */
const SOCIAL_ONLY_CONFIDENCE_CAP = 0.35;
/** Ceiling when a single non-authoritative source is all we have. */
const SINGLE_SOURCE_CONFIDENCE_CAP = 0.6;

export interface VerifyOptions {
  marketReaction?: MarketReaction;
}

function isAuthoritative(doc: NormalizedDocument): boolean {
  if (sourceRegistry.isAuthoritative(doc.source)) return true;
  return doc.sourceTier === 'official' || doc.sourceTier === 'regulatory_filing';
}

function detectContradictions(documents: NormalizedDocument[]): Contradiction[] {
  const found: Contradiction[] = [];
  for (const doc of documents) {
    const text = `${doc.title} ${doc.content}`;
    for (const { id, pattern } of CONTRADICTION_PATTERNS) {
      const match = pattern.exec(text);
      if (!match) continue;
      found.push({
        documentId: doc.id,
        source: doc.source,
        excerpt: text.slice(Math.max(0, match.index - 60), match.index + 120).trim(),
        matchedPattern: id,
      });
      break; // one flag per document is enough to force review
    }
  }
  return found;
}

export function verifyCluster(
  cluster: EventCluster,
  options: VerifyOptions = {},
): VerificationAssessment {
  const documents = cluster.documents;
  const reasons: string[] = [];

  const distinctSources = new Set(documents.map((doc) => doc.source)).size;
  // Near-duplicates are republication of the same text; they are evidence that
  // a story spread, not that it was independently established.
  const independentDocs = documents.filter((doc) => !doc.duplicateOf);
  const independentReports = Math.max(1, new Set(independentDocs.map((doc) => doc.source)).size);

  const authoritativeDocs = documents.filter(isAuthoritative);
  const authoritativeSources = [...new Set(authoritativeDocs.map((doc) => doc.source))];
  const contradictions = detectContradictions(documents);

  const socialOnly = documents.length > 0 && documents.every((doc) => doc.sourceTier === 'social');
  const maxReliability = documents.reduce((max, doc) => Math.max(max, doc.source_reliability), 0);

  // --- Status ------------------------------------------------------------
  let status: VerificationStatus;
  if (authoritativeSources.length > 0) {
    status = 'officially_confirmed';
    reasons.push(`confirmed by authoritative source(s): ${authoritativeSources.join(', ')}`);
    if (contradictions.length > 0) {
      // An outlet's denial does not override the issuer's or regulator's own
      // filing, but it does mean somebody disagrees and confidence should drop.
      reasons.push('denial language present despite official confirmation — flagged for review');
    }
  } else if (contradictions.length > 0) {
    status = 'contradicted';
    reasons.push(`denial or retraction language found in ${contradictions.length} document(s)`);
  } else if (independentReports >= 2) {
    status = 'corroborated';
    reasons.push(`${independentReports} independent sources reporting`);
  } else {
    status = 'unverified';
    reasons.push('single source, no official confirmation');
  }

  // --- Confidence --------------------------------------------------------
  let confidence = maxReliability;
  reasons.push(`base = best source reliability (${maxReliability.toFixed(2)})`);

  if (independentReports > 1) {
    const bonus = Math.min(0.15, 0.05 * (independentReports - 1));
    confidence += bonus;
    reasons.push(`+${bonus.toFixed(2)} for ${independentReports} independent reports`);
  }

  const republications = documents.length - independentDocs.length;
  if (republications > 0) {
    reasons.push(`${republications} republication(s) ignored — syndication is not corroboration`);
  }

  if (status === 'officially_confirmed') {
    confidence += 0.1;
    reasons.push('+0.10 official confirmation');
  }

  if (contradictions.length > 0) {
    confidence -= 0.35;
    reasons.push('-0.35 contradiction detected');
  }

  // Market reaction is deliberately weak and conditional. A price move shows
  // the market reacted to something; it is not evidence a claim is true, and
  // letting it lift an unverified single-source rumour would be circular —
  // the rumour moves the price, the price then "confirms" the rumour.
  if (options.marketReaction) {
    const canUse = status === 'officially_confirmed' || status === 'corroborated';
    if (canUse && options.marketReaction.abnormal) {
      confidence += 0.05;
      reasons.push('+0.05 abnormal market reaction consistent with an already-corroborated event');
    } else {
      reasons.push('market reaction recorded but not scored (claim not independently established)');
    }
  }

  // --- Caps --------------------------------------------------------------
  if (socialOnly) {
    confidence = Math.min(confidence, SOCIAL_ONLY_CONFIDENCE_CAP);
    if (status === 'officially_confirmed') status = 'corroborated';
    reasons.push(`capped at ${SOCIAL_ONLY_CONFIDENCE_CAP} — social sources only`);
  } else if (status === 'unverified' && independentReports <= 1) {
    // Keyed on independent reports, not distinct sources: five outlets running
    // the same wire copy is still one unconfirmed claim, and must not escape
    // the cap simply by being widely republished.
    confidence = Math.min(confidence, SINGLE_SOURCE_CONFIDENCE_CAP);
    reasons.push(`capped at ${SINGLE_SOURCE_CONFIDENCE_CAP} — one unconfirmed original report`);
  }

  confidence = Number(Math.max(0, Math.min(1, confidence)).toFixed(3));

  return {
    status,
    confidence,
    distinctSources,
    independentReports,
    authoritativeSources,
    contradictions,
    ...(options.marketReaction ? { marketReaction: options.marketReaction } : {}),
    reasons,
  };
}
