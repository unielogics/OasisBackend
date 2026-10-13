// Problem copy of Settings → Oasis AI (ADR 0174): knowledge, documents, practice and corrections. The practice and correction codes
// are registered with the contract (the next wave builds those routes).
import { registerProblems } from '../../../platform/errors.js'

registerProblems({
  KNOWLEDGE_BUDGET: {
    status: 422,
    title: 'Knowledge is full',
    detail: 'This would go over what Oasis AI can read. Turn something off or shorten it first',
  },
  KNOWLEDGE_NEEDS_REVIEW: {
    status: 422,
    title: 'Read it first',
    detail: 'Read the text from the PDF and confirm it before Oasis AI uses it',
  },
  DUPLICATE_DOCUMENT: {
    status: 409,
    title: 'Already uploaded',
    detail: 'This PDF is already in your knowledge',
  },
  DOCUMENT_NOT_READY: {
    status: 409,
    title: 'Not ready',
    detail: 'This PDF is not in a state that allows that. Reload and try again',
  },
  NOT_BUILT: {
    status: 501,
    title: 'Coming soon',
    detail: 'This part of Oasis AI is not built yet',
  },
  PRACTICE_OFF: {
    status: 409,
    title: 'Practice is off',
    detail: 'The practice chat is switched off on the server',
  },
  PRACTICE_BUSY: {
    status: 409,
    title: 'Still answering',
    detail: 'Oasis AI is still answering the last text. Wait a moment',
  },
  PRACTICE_BUDGET: {
    status: 429,
    title: 'Practice used up today',
    detail: 'Today’s practice budget is used up. Try again tomorrow',
  },
  PRACTICE_LIMIT: {
    status: 429,
    title: 'Practice limit reached',
    detail: 'This practice chat, or today’s chats, reached the limit. Start a new chat or try again tomorrow',
  },
  PRACTICE_ENDED: {
    status: 409,
    title: 'This chat has ended',
    detail: 'The client opted out in this practice chat. Start a new one',
  },
  CORRECTION_EXISTS: {
    status: 409,
    title: 'Already corrected',
    detail: 'There is already a correction for this question',
  },
})
