export type MediaErrorCode =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'HEIC_NOT_SUPPORTED'
  | 'TYPE_MISMATCH'
  | 'CORRUPT'
  | 'TOO_MANY_PIXELS'
  | 'INVALID_OPTIONS'

export class MediaError extends Error {
  constructor(
    readonly code: MediaErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MediaError'
  }
}
