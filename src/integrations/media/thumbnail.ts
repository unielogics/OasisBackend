import { MAX_UPLOAD_BYTES } from '../storage/types.js'
import { MediaError } from './errors.js'
import { MAX_INPUT_PIXELS, validateImageInput, type ImageInfo } from './image-info.js'

export interface ThumbnailOptions {
  /** Longest edge of the thumbnail in pixels. */
  maxEdge: number
  /** WebP quality, 1-100. */
  quality: number
}

export const DEFAULT_THUMBNAIL: ThumbnailOptions = { maxEdge: 480, quality: 78 }

export interface ThumbnailPlan {
  /** Bounding box for `fit: inside`. A square so EXIF-rotated sources need no special casing. */
  box: { width: number; height: number }
  fit: 'inside'
  withoutEnlargement: true
  format: 'webp'
  quality: number
  /** Apply EXIF orientation, then strip all metadata (GPS included). */
  autoOrient: true
  /** Dimensions of the result for an upright source, for logging and tests. */
  expected: { width: number; height: number }
}

/** Pure: decides the resize parameters for a validated image. Never enlarges. */
export function planThumbnail(
  src: Pick<ImageInfo, 'width' | 'height'>,
  opts: Partial<ThumbnailOptions> = {},
): ThumbnailPlan {
  const { maxEdge, quality } = { ...DEFAULT_THUMBNAIL, ...opts }
  if (!Number.isInteger(maxEdge) || maxEdge < 16 || maxEdge > 4096) {
    throw new MediaError('INVALID_OPTIONS', 'maxEdge must be an integer between 16 and 4096')
  }
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new MediaError('INVALID_OPTIONS', 'quality must be an integer between 1 and 100')
  }
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height))
  return {
    box: { width: maxEdge, height: maxEdge },
    fit: 'inside',
    withoutEnlargement: true,
    format: 'webp',
    quality,
    autoOrient: true,
    expected: {
      width: Math.max(1, Math.round(src.width * scale)),
      height: Math.max(1, Math.round(src.height * scale)),
    },
  }
}

/** The slice of sharp's API used here, so the optional dependency is never imported statically. */
interface SharpPipeline {
  rotate(): SharpPipeline
  resize(w: number, h: number, o: { fit: 'inside'; withoutEnlargement: boolean }): SharpPipeline
  webp(o: { quality: number }): SharpPipeline
  toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>
}
export type SharpFactory = (
  input: Buffer,
  options: { limitInputPixels: number; failOn: 'error' },
) => SharpPipeline

export type SharpLoader = () => Promise<SharpFactory | null>

/** Loads sharp if it is installed and its native binary matches this platform; resolves null otherwise. */
export const loadSharp: SharpLoader = async () => {
  try {
    const name = 'sharp' // not a literal: keeps the optional dependency out of static resolution
    const mod = (await import(name)) as { default?: SharpFactory }
    return typeof mod.default === 'function' ? mod.default : null
  } catch {
    return null
  }
}

export interface Thumbnail {
  data: Buffer
  contentType: 'image/webp'
  width: number
  height: number
}

export interface ThumbnailServiceOptions extends Partial<ThumbnailOptions> {
  loader?: SharpLoader
  maxBytes?: number
  maxPixels?: number
}

export class ThumbnailService {
  private sharp: Promise<SharpFactory | null> | null = null
  private readonly opts: Required<Pick<ThumbnailServiceOptions, 'maxBytes' | 'maxPixels'>> &
    Partial<ThumbnailOptions>
  private readonly loader: SharpLoader

  constructor(opts: ThumbnailServiceOptions = {}) {
    this.loader = opts.loader ?? loadSharp
    this.opts = {
      maxBytes: opts.maxBytes ?? MAX_UPLOAD_BYTES,
      maxPixels: opts.maxPixels ?? MAX_INPUT_PIXELS,
      ...(opts.maxEdge !== undefined ? { maxEdge: opts.maxEdge } : {}),
      ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
    }
    planThumbnail({ width: 1, height: 1 }, this.opts) // fail fast on bad options
  }

  /** True when sharp loaded on this machine. Without it, `create` returns null and callers serve the original. */
  async available(): Promise<boolean> {
    return (await this.load()) !== null
  }

  private load(): Promise<SharpFactory | null> {
    this.sharp ??= this.loader().catch(() => null)
    return this.sharp
  }

  /**
   * Validates the input (throws MediaError for HEIC, corrupt, oversized or mismatched files regardless of sharp),
   * then returns a WebP thumbnail, or null when sharp is unavailable or the decoder fails on the pixels.
   */
  async create(input: Buffer, declaredType?: string): Promise<Thumbnail | null> {
    const info = validateImageInput(input, {
      ...(declaredType ? { declaredType } : {}),
      maxBytes: this.opts.maxBytes,
      maxPixels: this.opts.maxPixels,
    })
    const sharp = await this.load()
    if (!sharp) return null
    const plan = planThumbnail(info, this.opts)
    try {
      const { data, info: out } = await sharp(input, {
        limitInputPixels: this.opts.maxPixels,
        failOn: 'error',
      })
        .rotate()
        .resize(plan.box.width, plan.box.height, {
          fit: plan.fit,
          withoutEnlargement: plan.withoutEnlargement,
        })
        .webp({ quality: plan.quality })
        .toBuffer({ resolveWithObject: true })
      return { data, contentType: 'image/webp', width: out.width, height: out.height }
    } catch {
      return null
    }
  }
}
