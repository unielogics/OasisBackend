// The conversation's language (ADR 0160 W4b fix X5) and the server's own words in it: the automated-assistant disclosure, the STOP
// footer, the safety and card lines, the fallback, the reply-number line and the placeholder renderings (facts.ts) are written by
// the server, so the server writes them in the client's language. The language is detected from the CLIENT's texts (never the
// model's), stored on the conversation (assistant_conversations.language) and kept until a text clearly says otherwise; English is
// the default. Every string here is already GSM-7 (accents GSM-7 lacks are written without them, as the dispatcher would send
// them), so what is tested is what the phone shows.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import './schema.js'

export const CONVO_LANGS = ['en', 'es'] as const
export type ConvoLang = (typeof CONVO_LANGS)[number]

export const isConvoLang = (x: unknown): x is ConvoLang =>
  typeof x === 'string' && (CONVO_LANGS as readonly string[]).includes(x)

/** The first AI text of a conversation: this line before the text and the STOP footer after it (owner 2026-10-11; no AGENT offer). */
export const DISCLOSURE: Record<ConvoLang, { open: string; footer: string }> = {
  en: { open: 'Oasis Auto Spa’s automated assistant here.', footer: 'Reply STOP to opt out.' },
  es: {
    open: 'Asistente automatizado de Oasis Auto Spa.',
    footer: 'Responde STOP para no recibir mas mensajes.',
  },
}

/** The server's line after a verify, PIN, membership or payment link (the model never writes it). */
export const SAFETY_LINES: Record<ConvoLang, string> = {
  en: 'For your security, enter codes and your PIN only on the secure page, never by text.',
  es: 'Por tu seguridad, ingresa codigos y tu PIN solo en la pagina segura, nunca por mensaje.',
}

/** The server's line when the answered texts held a card number (the model may write nothing about cards). */
export const CARD_LINES: Record<ConvoLang, string> = {
  en: 'For your security, please never text card numbers.',
  es: 'Por tu seguridad, nunca envies numeros de tarjeta por mensaje.',
}

/** The fixed fallback text (template ai_fallback in English). */
export const FALLBACK_TEXTS: Record<ConvoLang, string> = {
  en: 'Thanks — a team member will text you back shortly.',
  es: 'Gracias, un miembro del equipo te escribira pronto.',
}

/** The {confirm} rendering: the server's pointer to the reply-number text it just sent. */
export const CONFIRM_WORDS_BY_LANG: Record<ConvoLang, string> = {
  en: 'I just texted you the details with how to confirm',
  es: 'Te acabo de enviar los detalles para confirmar',
}

/** The action_confirm text: "<summary>. Reply 4821 to confirm." ({code} is the secretVar). */
export function actionConfirmText(summary: string, lang: ConvoLang): string {
  return lang === 'es'
    ? `${summary}. Responde {code} para confirmar.`
    : `${summary}. Reply {code} to confirm.`
}

/** A text with the disclosure before it and the STOP footer after it. */
export function withDisclosure(text: string, lang: ConvoLang): string {
  const d = DISCLOSURE[lang]
  return `${d.open} ${text.trim()} ${d.footer}`
}

// ---- detection ---------------------------------------------------------------------------------------------------------------------

/** Words that only Spanish texts use (weight 2) or that lean Spanish (weight 1); accents folded. */
const ES_STRONG = new Set([
  'hola',
  'gracias',
  'quiero',
  'quisiera',
  'cuanto',
  'cuesta',
  'cuestan',
  'lavado',
  'lavar',
  'necesito',
  'puedo',
  'pueden',
  'reservar',
  'reserva',
  'cita',
  'manana',
  'buenos',
  'buenas',
  'llamo',
  'precio',
  'precios',
  'tienen',
  'horario',
  'abren',
  'cierran',
  'usted',
  'ustedes',
  'tambien',
  'carro',
  'coche',
  'camioneta',
  'donde',
  'como',
  'que',
  'cual',
  'esta',
  'estan',
  'estoy',
  'porque',
  'pero',
  'favor',
  'semana',
  'hoy',
  'tarde',
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
  'domingo',
  'membresia',
  'polarizado',
  'detallado',
  'cambiar',
  'cancelar',
  'mover',
  'listo',
  'si',
  'claro',
  'vale',
  'bueno',
  'nombre',
  'soy',
  'tengo',
  'hacen',
  'hay',
])
const ES_WEAK = new Set([
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'de',
  'del',
  'con',
  'para',
  'por',
  'mi',
  'es',
  'y',
  'en',
  'muy',
  'bien',
  'al',
  'lo',
  'le',
  'nos',
  'te',
  'me',
])
const EN_STRONG = new Set([
  'hello',
  'hey',
  'thanks',
  'thank',
  'want',
  'need',
  'how',
  'much',
  'what',
  'when',
  'where',
  'book',
  'booking',
  'wash',
  'price',
  'the',
  'you',
  'your',
  'open',
  'tomorrow',
  'today',
  'please',
  'can',
  'could',
  'would',
  'is',
  'are',
  'do',
  'does',
  'have',
  'my',
  'i',
  'im',
  'it',
  'this',
  'that',
  'there',
  'with',
  'and',
  'for',
  'of',
  'to',
  'cost',
  'appointment',
  'cancel',
  'move',
  'yes',
  'sure',
  'works',
  'name',
  'just',
  'about',
  'will',
  'did',
  'set',
  'all',
  'okay',
  'ok',
  'great',
  'thx',
  'pls',
  'u',
])

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * The language a set of client texts is written in, or null when they do not say (a name, "ok", "10am works", a mix): Spanish needs
 * two points (a Spanish-only word such as "hola" counts 2, a function word 1, ¿ ¡ ñ 2) and more than the English points; English needs two
 * English words (4 points) and more than the Spanish points, so a short "ok" never turns a Spanish conversation English.
 */
export function detectLanguage(texts: readonly string[]): ConvoLang | null {
  let es = 0
  let en = 0
  for (const raw of texts) {
    if (/[¿¡ñÑ]/.test(raw)) es += 2
    if (/\b(?:por favor|buenos dias|buenas tardes|buenas noches)\b/.test(fold(raw))) es += 2
    for (const w of fold(raw).split(/[^a-z]+/)) {
      if (!w) continue
      if (ES_STRONG.has(w)) es += 2
      else if (ES_WEAK.has(w)) es += 1
      if (EN_STRONG.has(w)) en += 2
    }
  }
  if (es >= 2 && es > en) return 'es'
  if (en >= 4 && en > es) return 'en'
  return null
}

/** The conversation's language and whether its disclosure went out already. */
export async function conversationVoice(
  db: Executor,
  conversationId: string,
): Promise<{ lang: ConvoLang; disclosed: boolean }> {
  const c = await db
    .selectFrom('assistant_conversations')
    .select(['language', 'disclosed_at'])
    .where('id', '=', conversationId)
    .executeTakeFirst()
  return {
    lang: isConvoLang(c?.language) ? c.language : 'en',
    disclosed: c ? c.disclosed_at !== null : false,
  }
}

/** Records that the disclosure went out (only the first time). */
export async function markDisclosed(tx: Tx, conversationId: string, at: Date): Promise<void> {
  await tx
    .updateTable('assistant_conversations')
    .set({ disclosed_at: at })
    .where('id', '=', conversationId)
    .where('disclosed_at', 'is', null)
    .execute()
}

/** Stores a detected language on the conversation (no-op when it is the same). */
export async function storeLanguage(db: Executor, conversationId: string, lang: ConvoLang): Promise<void> {
  await sql`update assistant_conversations set language = ${lang} where id = ${conversationId} and language <> ${lang}`.execute(
    db,
  )
}
