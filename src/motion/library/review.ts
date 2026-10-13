import type { SignLibraryWord } from './format'

/**
 * Deaf review decisions recorded in the app and exported as the pipeline's
 * deaf_review_decisions.csv (same columns as the pipeline's
 * viewer/clip_viewer.html). Drop the file into
 * s3://<bucket>/v2/05_library/<avatar>/reviews/ and rerun
 * `python -m aslv2 library`: approved takes are chosen first, rejected takes
 * are skipped in favour of the next-ranked candidate.
 *
 * A decision is about the dataset TAKE (sign + sequence_id). The app shows
 * the conformed rendition of the take; the importer re-applies the same
 * deterministic conformance on every import.
 */
export type Decision = 'approved' | 'rejected'

export interface ReviewRecord {
  gloss: string
  sequenceId: string
  decision: Decision
  notes: string
  reviewer: string
  /** ISO timestamp of the last change. */
  at: string
}

export const REVIEW_CSV_COLUMNS = ['sign', 'rank', 'sequence_id', 'participant_id', 'decision', 'reviewer', 'notes', 'clip_file'] as const

function cell(value: string | number) {
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** CSV rows for every word that has a decision for its CURRENT take (stale decisions are dropped). */
export function reviewCsv(words: readonly SignLibraryWord[], records: Readonly<Record<string, ReviewRecord>>) {
  const lines = [REVIEW_CSV_COLUMNS.join(',')]
  for (const word of words) {
    const record = records[word.gloss]
    if (!record || record.sequenceId !== word.source.sequenceId) continue
    lines.push([
      word.gloss,
      word.source.rank,
      word.source.sequenceId,
      word.source.participantId,
      record.decision,
      record.reviewer,
      record.notes,
      word.source.clipFile
    ].map(cell).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

/** Parse stored records defensively (localStorage content can be anything). */
export function parseReviewRecords(text: string | null): Record<string, ReviewRecord> {
  if (!text) return {}
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object') return {}
    const out: Record<string, ReviewRecord> = {}
    for (const [gloss, raw] of Object.entries(value as Record<string, Partial<ReviewRecord>>)) {
      if (!raw || (raw.decision !== 'approved' && raw.decision !== 'rejected') || typeof raw.sequenceId !== 'string') continue
      out[gloss] = {
        gloss,
        sequenceId: raw.sequenceId,
        decision: raw.decision,
        notes: typeof raw.notes === 'string' ? raw.notes : '',
        reviewer: typeof raw.reviewer === 'string' ? raw.reviewer : '',
        at: typeof raw.at === 'string' ? raw.at : ''
      }
    }
    return out
  } catch {
    return {}
  }
}
