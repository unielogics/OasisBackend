// The conversation's language (ADR 0160 W4b fix X5) and the server's own words in it: the automated-assistant disclosure, the STOP
// footer, the safety and card lines, the fallback, the reply-number line and the placeholder renderings (facts.ts) are written by
// the server, so the server writes them in the client's language. The language is detected from the CLIENT's texts (never the
// model's), stored on the conversation (assistant_conversations.language) and kept until a text clearly says otherwise; English is
// the default. Every string here is already GSM-7 (accents GSM-7 lacks are written without them, as the dispatcher would send
// them), so what is tested is what the phone shows.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { addDays, fmtT } from '../../platform/time.js'
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
  // a Spanish summary may end with the full stop of "a. m." (P3)
  const s = summary.endsWith('.') ? summary : `${summary}.`
  return lang === 'es' ? `${s} Responde {code} para confirmar.` : `${s} Reply {code} to confirm.`
}

// ---- dates, times and the server's other texts in Spanish (guard polish after W4b-fix, P3) ------------------------------------------

const ES_DAYS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'] as const
const ES_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const

/** "11:00 a. m.", "1:30 p. m." (Spanish clock; GSM-7). */
export function timeEs(startMin: number): string {
  const m = ((Math.round(startMin) % 1440) + 1440) % 1440
  const h = Math.floor(m / 60)
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`
}

/** "vie 16 oct" for 2026-10-16 (no accent GSM-7 lacks: "mie", "sab"). */
export function shortDateEs(date: string): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  const day = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  return `${ES_DAYS[day]} ${d} ${ES_MONTHS[mo - 1]}`
}

/**
 * A visit's day and time in the conversation's language: "today at 10:00 AM", "tomorrow at 9:00 AM", "Fri Oct 16 at 11:00 AM";
 * "hoy a las 10:00 a. m.", "mañana a las 9:00 a. m.", "vie 16 oct, 11:00 a. m." (a la 1:00 p. m.).
 */
export function whenIn(lang: ConvoLang, date: string, startMin: number, today: string): string {
  if (lang === 'en') {
    const day = date === today ? 'today' : date === addDays(today, 1) ? 'tomorrow' : shortDateEn(date)
    return `${day} at ${fmtT(startMin)}`
  }
  const t = timeEs(startMin)
  const at = t.startsWith('1:') ? 'a la' : 'a las'
  if (date === today) return `hoy ${at} ${t}`
  if (date === addDays(today, 1)) return `mañana ${at} ${t}`
  return `${shortDateEs(date)}, ${t}`
}

const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
/** "Fri Oct 16" (as tools/common.ts shortDate writes it). */
function shortDateEn(date: string): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  return `${EN_DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${EN_MONTHS[mo - 1]} ${d}`
}

/** A sentence end after a "when" that may already end with the full stop of "a. m." / "p. m.". */
const stop = (s: string): string => (s.endsWith('.') ? s : `${s}.`)

/** A "when" from whenIn with its article for a Spanish sentence: "el vie 16 oct, ..." / "hoy a las ..." (no article). */
const withArticleEs = (when: string): string => (/^(?:hoy|mañana)\b/.test(when) ? when : `el ${when}`)

/** The action_confirm summary in the conversation's language (the confirm line adds "Reply 4821 to confirm." after it). */
export function actionSummaryIn(
  lang: ConvoLang,
  a: { kind: 'book' | 'reschedule' | 'cancel'; service: string; when: string },
): string {
  let s: string
  if (lang === 'es')
    s =
      a.kind === 'book'
        ? `${a.service}, ${a.when}`
        : a.kind === 'reschedule'
          ? `Mover tu ${a.service} para ${withArticleEs(a.when)}`
          : `Cancelar tu ${a.service} ${/^(?:hoy|mañana)\b/.test(a.when) ? `de ${a.when}` : `del ${a.when}`}`
  else
    s =
      a.kind === 'book'
        ? `${a.service}, ${a.when}`
        : a.kind === 'reschedule'
          ? `Move your ${a.service} to ${a.when}`
          : `Cancel your ${a.service} ${a.when.startsWith('today') || a.when.startsWith('tomorrow') ? '' : 'on '}${a.when}`
  return s.length > 140 ? `${s.slice(0, 137)}...` : s
}

/** The reasons a confirmed action can fail with (actions/handler.ts), in Spanish; anything else reads as the last one. */
const FAILED_REASONS_ES: Record<string, string> = {
  'that time was just taken.': 'esa hora se acaba de ocupar.',
  'that time has passed.': 'esa hora ya paso.',
  'that service is no longer offered online.': 'ese servicio ya no se ofrece en linea.',
  'one of those add-ons is no longer offered online.': 'uno de esos extras ya no se ofrece en linea.',
  'that visit is not on your record any more.': 'esa cita ya no esta en tu registro.',
  'that visit can no longer be changed by text.': 'esa cita ya no se puede cambiar por mensaje.',
  'that visit can no longer be canceled by text.': 'esa cita ya no se puede cancelar por mensaje.',
  'it is now too close to the visit (or money is held on it) to cancel by text.':
    'ya falta muy poco para la cita (o hay un pago en ella) para cancelarla por mensaje.',
  'this number is no longer the one on your record.': 'este numero ya no es el de tu registro.',
}
const FAILED_REASON_ES_OTHER = 'algo de nuestro lado no funciono.'

/**
 * The server's own texts of the reply-number flow in Spanish (the English ones are the templates of messaging/templates/registry.ts,
 * which stay English): the booking confirmation, the moved and cancelled acks, the wrong, locked or expired reply number, verify
 * again, failed, paused; the link-page line and the opt-out confirmation. GSM-7 as the phone shows them.
 */
export function serverTextEs(key: string, vars: Record<string, string | undefined> = {}): string | null {
  switch (key) {
    case 'action_booked':
      return [
        `Reservado: ${vars.service}, ${stop(vars.when ?? '')}`,
        vars.member ? 'Los miembros nunca pagan tarifa de reserva.' : vars.fee ? `Tarifa de reserva de ${vars.fee}, se paga ${vars.how === 'by payment link' ? 'con el enlace de pago' : 'en el local'}.` : null,
        '¡Te esperamos!',
      ]
        .filter((x) => x !== null)
        .join(' ')
    case 'reschedule':
      return `Tu cita se movio para ${stop(withArticleEs(vars.when ?? ''))} Responde si no te funciona.`
    case 'cancel':
      return `Tu cita en Oasis Auto Spa ${/^(?:hoy|mañana)\b/.test(vars.when ?? '') ? `de ${vars.when}` : `del ${vars.when}`} fue cancelada. Responde aqui si tienes preguntas.`
    case 'action_code_wrong':
      return 'Ese numero no coincide. Responde con el numero de 4 digitos de nuestro ultimo mensaje.'
    case 'action_code_locked':
      return 'Ese numero no coincidio, asi que cancelamos esa solicitud para proteger tu cuenta. Responde aqui y empezamos de nuevo.'
    case 'action_code_expired':
      return 'Ese numero de confirmacion ya vencio. Responde aqui y lo preparamos de nuevo.'
    case 'action_needs_verify':
      return 'Por tu seguridad necesitamos confirmar otra vez que eres tu antes de cambiar tu reserva. Responde aqui y te enviamos un enlace seguro.'
    case 'action_failed':
      return `Lo sentimos, no pudimos completarlo: ${FAILED_REASONS_ES[vars.reason ?? ''] ?? FAILED_REASON_ES_OTHER} Responde aqui y lo resolvemos.`
    case 'action_unavailable':
      return 'Ahora no podemos confirmar cambios por mensaje. Un miembro del equipo te escribira pronto.'
    case 'code_on_link_page':
      return 'Por tu seguridad, los codigos solo se ingresan en tu pagina segura, nunca por mensaje. Responde aqui si necesitas un enlace nuevo.'
    case 'opt_out_confirm':
      return 'Ya no recibiras mensajes de Oasis Auto Spa. Responde START para volver a suscribirte.'
    default:
      return null
  }
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
