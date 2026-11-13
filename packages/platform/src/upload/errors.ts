/** 换身份中止本地工作，不代表用户放弃自己的分片会话。 */
export class UploadSessionEndedError extends Error {
  override name = 'AbortError'

  constructor() {
    super('upload session ended')
  }
}
