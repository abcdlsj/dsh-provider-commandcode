/**
 * Browser-facing Remote surface: the quota reading the composer status bar
 * polls.
 *
 * The browser never holds the API key, so the host reads Command Code and
 * returns the snapshot. The endpoint is `commandcode/usage`; the client half
 * calls it over the shared `/api` channel.
 * @module dsh-provider-commandcode/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { QuotaReader, QuotaSnapshot, QuotaUnconfigured } from './quota.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Quota reader the browser half calls; absent when the plugin is not mounted. */
    commandCodeQuota: CommandCodeQuota
  }
}

/** One quota endpoint over the account reader. */
export class CommandCodeQuota extends TypertRemoteService {
  /**
   * @param ctx - owning plugin context.
   * @param reader - quota reader over the same account the adapter uses.
   */
  constructor(ctx: Context, private readonly reader: QuotaReader) {
    super(ctx, 'commandCodeQuota', { namespace: 'commandcode' })
  }

  /**
   * Read the account's quota for the status bar.
   * @param force - bypass the short-lived credit cache after a manual refresh.
   * @returns the reading, or the unconfigured marker when no key is stored.
   */
  @Remote('usage')
  async usage(force?: boolean): Promise<QuotaSnapshot | QuotaUnconfigured> {
    return await this.reader.read(force === true)
  }
}
