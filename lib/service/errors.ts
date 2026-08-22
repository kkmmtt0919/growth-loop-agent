/** Service 层业务错误：携带 HTTP 状态码，由 API route 转成响应 */
export class ServiceError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "ServiceError";
  }
}
