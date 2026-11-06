/**
 * Deterministic request-image preparation for Command Code models.
 *
 * Every retained image is re-encoded to the route's byte target once, and the
 * request fails with `IMAGE_OFFLOAD_REQUIRED` instead of silently dropping
 * occurrences, so the harness's own offload policy owns what gets removed.
 * @module dsh-provider-commandcode/images
 */

import {
  IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImageText, projectOffloadedImages, requiredImageOffload,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageAttachmentAccessResolver, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { CatalogModel } from './catalog-types.js'

/** Request-image target of every Command Code route. */
const REQUEST_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const REQUEST_IMAGE_MAX_EDGE = 2048

/** Prepared history and the bytes of its retained images. */
export interface PreparedImages {
  /** History with offloaded occurrences replaced by placeholder text. */
  readonly messages: readonly RequestMessage[]
  /** Request versions keyed by durable attachment id. */
  readonly versions: ReadonlyMap<string, RequestImageAttachment>
}

/** Inputs of one request-image preparation. */
export interface PrepareImagesOptions {
  /** Full request history. */
  readonly messages: readonly RequestMessage[]
  /** Served model entry, for its modality declaration. */
  readonly model: CatalogModel
  /** Mounted attachment store, required only when images are present. */
  readonly attachments: AttachmentStore | undefined
  /** Execution-world path resolver for placeholders. */
  readonly access: ImageAttachmentAccessResolver
  /** Decoded image bytes one request may carry. */
  readonly maxBytes: number
  /** Images one request may carry. */
  readonly maxImages: number
  /** Caller cancellation. */
  readonly signal: AbortSignal
}

function* imageRefs(blocks: readonly ContentBlock[]): Generator<ImageAttachmentRef> {
  for (const block of blocks) {
    if (block.type === 'image') yield block.attachment
  }
}

/**
 * Prepare every retained image of one request.
 * @param options - history, route capability, attachment mount, and budgets.
 * @returns history with offloaded placeholders and the request bytes of retained images.
 * @throws LlmError `UNSUPPORTED_CONTENT` for a text-only route or missing mount,
 *   and `IMAGE_OFFLOAD_REQUIRED` when the retained occurrences exceed the budget.
 */
export async function prepareImages(options: PrepareImagesOptions): Promise<PreparedImages> {
  const messages = projectOffloadedImages(options.messages, (ref) => offloadedImageText(ref, options.access(ref)))
  const versions = new Map<string, RequestImageAttachment>()
  if (!messages.some((message) => message.content.some((block) => block.type === 'image'))) {
    return { messages, versions }
  }
  if (!options.model.inputModalities.includes('image')) {
    throw new LlmError(
      `Command Code model "${options.model.id}" accepts text only; detach the image or choose a vision model`,
      'UNSUPPORTED_CONTENT',
    )
  }
  if (options.attachments === undefined) {
    throw new LlmError('Command Code image input requires the harness attachment service', 'UNSUPPORTED_CONTENT')
  }
  if (messages.some((message) => message.role !== 'user' && message.role !== 'tool' && message.content.some((block) => block.type === 'image'))) {
    throw new LlmError('Command Code supports images only in user messages and tool results', 'UNSUPPORTED_CONTENT')
  }
  for (const message of messages) {
    for (const ref of imageRefs(message.content)) {
      if (versions.has(ref.attachmentId)) continue
      versions.set(ref.attachmentId, await options.attachments.readImageRequest(ref, {
        width: Math.min(ref.width, REQUEST_IMAGE_MAX_EDGE),
        height: Math.min(ref.height, REQUEST_IMAGE_MAX_EDGE),
        maxBytes: REQUEST_IMAGE_MAX_BYTES,
      }, options.signal))
    }
  }
  const offload = requiredImageOffload(messages, {
    representation: 'raw',
    maxBytes: options.maxBytes,
    maxImages: options.maxImages,
    byteQuantum: 256 * 1024,
    countQuantum: 1,
  }, (block) => {
    const version = versions.get(block.attachment.attachmentId)
    return version === undefined ? 0 : version.bytes
  })
  if (offload > 0) {
    throw new LlmError(
      `Command Code request images exceed the route budget; ${offload} more oldest occurrence(s) must be offloaded.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages: offload },
    )
  }
  return { messages, versions }
}
